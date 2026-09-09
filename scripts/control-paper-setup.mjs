import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ControlPlaneError, PAPER_SETUP_FIELDS } from '../apps/control-plane/src/control-plane.mjs'
import { validateConfig } from './config.mjs'
import { createPaperLedger, validatePaperLedger } from './paper-trade.mjs'
import { sha256Hex } from './gate-trade.mjs'
import { validatePaperSettings } from '../packages/pi-agents/src/conversation-settings.mjs'
import { readJsonStrict, withFileLock, writeJsonAtomic, writeTextAtomic } from './lib-iolock.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CONFIG_FIELDS = PAPER_SETUP_FIELDS.slice(0, 5)
const PAPER_FIELDS = PAPER_SETUP_FIELDS.slice(5)
const absent = (value) => value === null || value === undefined || value === ''
const decimal = (value) => /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(String(value)) && String(value).length <= 80 && Number.isFinite(Number(value)) && Number(value) > 0
const equalDecimal = (a, b) => String(a).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '') === String(b).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')

function fail(code, message, status = 409) {
  throw new ControlPlaneError(code, message, status)
}

function noSymlinks(target) {
  let cursor = path.resolve(target)
  while (cursor !== path.dirname(cursor)) {
    try { if (fs.lstatSync(cursor).isSymbolicLink()) fail('CONTROL_PAPER_UNSAFE_FILE', '模拟设置文件不能使用符号链接。') } catch (error) { if (error.code !== 'ENOENT') throw error }
    cursor = path.dirname(cursor)
  }
}

function validateValue(key, value) {
  if (!['string', 'number'].includes(typeof value) || !decimal(value)) fail('CONTROL_PAPER_VALUE_INVALID', `${key} 必须填写正十进制数。`, 400)
  if (key === 'configured_leverage' && (!Number.isInteger(Number(value)) || Number(value) > 3)) fail('CONTROL_PAPER_VALUE_INVALID', 'configured_leverage 必须为 1、2 或 3。', 400)
  if (key.endsWith('_bps') && Number(value) > 10000) fail('CONTROL_PAPER_VALUE_INVALID', `${key} 不能超过 10000 bps（100%）。`, 400)
}

function safeFailure(error) {
  if (error instanceof ControlPlaneError) return error
  if (error?.code === 'CONFIG_CAP_ORDER_INVALID') return new ControlPlaneError('CONTROL_PAPER_CAP_ORDER', '单笔名义金额不能超过每日新增限额或总持仓限额。', 400)
  if (String(error?.code || '').startsWith('CONFIG_')) return new ControlPlaneError('CONTROL_PAPER_CONFIG_INVALID', '现有配置未通过校验；请检查已保存的配置及风险限额，原配置未被替换。', 409)
  if (String(error?.code || '').startsWith('PAPER_')) return new ControlPlaneError('CONTROL_PAPER_STATE_INVALID', '现有模拟账户或参数未通过校验；请检查账户完整性，账户未被重建。', 409)
  return new ControlPlaneError('CONTROL_PAPER_STORAGE_FAILED', '模拟设置未完成。请检查本地文件权限或占用状态后重试；已有账户不会重置。', 503)
}

// These are server-owned dependencies; HTTP callers can supply only the eleven
// scalar settings. The root/write seams allow isolated filesystem failure tests.
export function createPaperSetupAdapter({ configPath, root = ROOT, writeJson = writeJsonAtomic } = {}) {
  const template = path.join(root, 'config', 'tyche.json')
  const local = path.join(root, 'config', 'tyche.local.json')
  const active = path.join(root, 'data', 'paper', 'active.json')
  const startup = path.resolve(configPath || template)
  const fromTemplate = startup === template
  const selectedPath = () => fromTemplate && fs.existsSync(local) ? local : startup

  function readState() {
    for (const file of [template, local, startup, active]) noSymlinks(file)
    const selected = selectedPath()
    const localMissing = selected === local && !fs.existsSync(local)
    const config = readJsonStrict(localMissing ? template : selected)
    const ledgerExists = fs.existsSync(active)
    const ledger = ledgerExists ? validatePaperLedger(readJsonStrict(active)) : null
    // An incomplete group can be completed only before an account exists.
    try { validateConfig(config) } catch (error) { if (ledgerExists || error.code !== 'CONFIG_CAPS_PARTIAL') throw error }
    if (config.gate?.submission_mode !== 'locked' || config.gate?.enabled !== true || config.gate?.usdm?.enabled !== true || config.gate?.usdm?.environment !== 'dry-run' || config.binance?.submission_mode !== 'locked' || config.binance?.usdm?.environment !== 'dry-run') {
      fail('CONTROL_PAPER_SCOPE_INVALID', '当前启动配置必须为 locked / dry-run 模拟模式；请使用独立的模拟配置。')
    }
    const values = {}
    for (const key of CONFIG_FIELDS) if (!absent(config.gate.usdm[key])) { validateValue(key, config.gate.usdm[key]); values[key] = String(config.gate.usdm[key]) }
    if (ledgerExists) {
      if (ledger.config_digest !== sha256Hex(config)) fail('CONTROL_PAPER_CONFIG_DRIFT', '模拟账户与当前配置不一致。请恢复账户初始化时的配置；不会覆盖或重建已有账户。')
      for (const key of PAPER_FIELDS) { validateValue(key, ledger.policy[key]); values[key] = String(ledger.policy[key]) }
    }
    const missing = PAPER_SETUP_FIELDS.filter((key) => !Object.hasOwn(values, key))
    if (!fromTemplate && startup !== local && missing.some((key) => CONFIG_FIELDS.includes(key))) fail('CONTROL_PAPER_CUSTOM_CONFIG', '自定义启动配置缺少模拟交易限额。请补齐该配置，或重新启动服务使用本地模拟设置。')
    return { config, ledger, ledgerExists, selected, values, missing }
  }

  const dto = (state) => ({ ready: state.missing.length === 0, status: state.missing.length ? 'required' : 'ready', values: state.values, missing: state.missing })
  function status() {
    try { return dto(readState()) } catch (error) { const safe = safeFailure(error); return { ready: false, status: 'blocked', values: {}, missing: [], code: safe.code, message: safe.message } }
  }
  function setup(input, { assertActive = () => {}, commit = () => {} } = {}) {
    try {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !PAPER_SETUP_FIELDS.includes(key))) fail('CONTROL_PAPER_FIELDS_INVALID', '仅接受明确的模拟资金和风险参数。', 400)
      for (const [key, value] of Object.entries(input)) validateValue(key, value)
      try { validatePaperSettings(input) } catch { fail('CONTROL_PAPER_VALUE_INVALID', '模拟参数或交易限额组合无效。', 400) }
      for (const target of [local, active, `${local}.lock`, `${active}.lock`]) noSymlinks(target)
      return withFileLock(local, () => withFileLock(active, () => {
        assertActive()
        const state = readState()
        for (const [key, value] of Object.entries(input)) if (Object.hasOwn(state.values, key) && !equalDecimal(value, state.values[key])) fail('CONTROL_PAPER_SETTING_CONFLICT', `${key} 已有不同设置；不会覆盖现有风控或重置账户。`)
        const missing = state.missing.filter((key) => !Object.hasOwn(input, key))
        if (missing.length) fail('CONTROL_PAPER_FIELDS_REQUIRED', `请填写：${missing.join('、')}`, 400)
        try { validatePaperSettings({ ...state.values, ...input }) } catch { fail('CONTROL_PAPER_VALUE_INVALID', '模拟参数或交易限额组合无效。', 400) }
        if (state.ledgerExists) { assertActive(); const ready = dto(state); commit(ready); return ready }
        const config = structuredClone(state.config)
        for (const key of CONFIG_FIELDS) if (absent(config.gate.usdm[key])) config.gate.usdm[key] = String(input[key])
        validateConfig(config)
        const ledger = createPaperLedger({ config, initialUsdt: input.initial_usdt, dailyLossBps: input.daily_loss_bps, maxDrawdownBps: input.max_drawdown_bps, maxSpreadBps: input.max_spread_bps, maxEntryDistanceBps: input.max_entry_distance_bps, triggerSlippageBps: input.trigger_slippage_bps })
        validatePaperLedger(ledger)
        const writeConfig = fromTemplate || startup === local
        const previous = fs.existsSync(local) ? fs.readFileSync(local, 'utf8') : null
        const changed = writeConfig && (previous === null || sha256Hex(config) !== sha256Hex(state.config))
        assertActive()
        try {
          if (changed) writeJson(local, config, { mode: 0o600 })
          writeJson(active, ledger, { mode: 0o600 })
          const ready = dto(readState())
          assertActive()
          // No await: this callback is the shared file/session commit point.
          commit(ready)
          return ready
        } catch (error) {
          if (fs.existsSync(active) && sha256Hex(readJsonStrict(active)) === sha256Hex(ledger)) fs.unlinkSync(active)
          // Config first: interruption can leave only valid settings without an
          // account, never an account referencing settings that were not saved.
          if (changed) {
            if (previous === null) { if (fs.existsSync(local)) fs.unlinkSync(local) }
            else writeTextAtomic(local, previous, { mode: 0o600 })
          }
          throw error
        }
      }, { waitMs: 500 }), { waitMs: 500 })
    } catch (error) { throw safeFailure(error) }
  }
  return { status, setup, configPath: selectedPath }
}
