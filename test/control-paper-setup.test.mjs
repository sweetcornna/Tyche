import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createPaperSetupAdapter } from '../scripts/control-paper-setup.mjs'
import { loadConfig, validateConfig } from '../scripts/config.mjs'
import { validatePaperLedger } from '../scripts/paper-trade.mjs'
import { sha256Hex } from '../scripts/gate-trade.mjs'
import { writeJsonAtomic } from '../scripts/lib-iolock.mjs'

const INPUT = Object.freeze({ configured_leverage: '2', risk_per_trade_bps: '25.125', max_order_notional_usdt: '100', daily_new_notional_cap_usdt: '250', max_managed_notional_usdt: '500', initial_usdt: '1000.123456789012345678', daily_loss_bps: '100', max_drawdown_bps: '300', max_spread_bps: '12.5', max_entry_distance_bps: '40', trigger_slippage_bps: '5.125' })
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-paper-setup-')))
  const template = path.join(root, 'config/tyche.json')
  const local = path.join(root, 'config/tyche.local.json')
  const active = path.join(root, 'data/paper/active.json')
  writeJsonAtomic(template, loadConfig())
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return { root, template, local, active, adapter: createPaperSetupAdapter({ root }) }
}

test('Paper setup requires every value, preserves decimal precision, and reuses the exact account', (t) => {
  const { adapter, template, local, active } = fixture(t)
  const committed = fs.readFileSync(template, 'utf8')
  assert.equal(adapter.status().missing.length, 11)
  assert.throws(() => adapter.setup({}), { code: 'CONTROL_PAPER_FIELDS_REQUIRED' })
  assert.equal(fs.existsSync(local), false)
  assert.equal(fs.existsSync(active), false)
  const ready = adapter.setup(INPUT)
  assert.equal(ready.ready, true)
  assert.equal(ready.values.initial_usdt, INPUT.initial_usdt)
  const config = JSON.parse(fs.readFileSync(local))
  validateConfig(config)
  assert.equal(config.gate.submission_mode, 'locked')
  assert.equal(config.gate.usdm.environment, 'dry-run')
  const ledger = validatePaperLedger(JSON.parse(fs.readFileSync(active)))
  assert.equal(ledger.config_digest, sha256Hex(config))
  const before = fs.readFileSync(active, 'utf8')
  assert.deepEqual(adapter.setup({}), ready)
  assert.deepEqual(adapter.setup(INPUT), ready)
  assert.equal(fs.readFileSync(active, 'utf8'), before)
  assert.equal(fs.readFileSync(template, 'utf8'), committed)
  assert.doesNotMatch(JSON.stringify(ready), /account_id|events|config_digest|pa_|active.json|api_key/)
  assert.equal(fs.statSync(local).mode & 0o777, 0o600)
})

test('Paper setup rejects invalid, partial, extra and conflicting values before writes', (t) => {
  const { adapter, local, active } = fixture(t)
  for (const change of [{ configured_leverage: '4' }, { risk_per_trade_bps: '10001' }, { initial_usdt: '0' }, { initial_usdt: '1e4' }, { initial_usdt: true }, { initial_usdt: {} }, { max_order_notional_usdt: '251' }, { credentials: 'forbidden' }, { configPath: '/elsewhere' }]) {
    assert.throws(() => adapter.setup({ ...INPUT, ...change }))
    assert.equal(fs.existsSync(local), false)
    assert.equal(fs.existsSync(active), false)
  }
  adapter.setup(INPUT)
  const before = fs.readFileSync(active, 'utf8')
  assert.throws(() => adapter.setup({ initial_usdt: '2000' }), { code: 'CONTROL_PAPER_SETTING_CONFLICT' })
  assert.equal(fs.readFileSync(active, 'utf8'), before)
  const changed = JSON.parse(fs.readFileSync(local)); changed.analysis.minimum_rr = 2
  writeJsonAtomic(local, changed)
  assert.equal(adapter.status().code, 'CONTROL_PAPER_CONFIG_DRIFT')
  assert.throws(() => adapter.setup({}), { code: 'CONTROL_PAPER_CONFIG_DRIFT' })
  assert.equal(fs.readFileSync(active, 'utf8'), before)
})

test('existing local limits are preserved and only missing values are populated', (t) => {
  const { root, local } = fixture(t)
  const config = loadConfig(); config.gate.usdm.configured_leverage = '2'; config.gate.usdm.max_order_notional_usdt = '100'
  writeJsonAtomic(local, config)
  const adapter = createPaperSetupAdapter({ root, configPath: local })
  assert.equal(adapter.status().missing.length, 9)
  const { configured_leverage, max_order_notional_usdt, ...missing } = INPUT
  assert.equal(adapter.setup(missing).ready, true)
  const result = JSON.parse(fs.readFileSync(local))
  assert.equal(result.gate.usdm.configured_leverage, configured_leverage)
  assert.equal(result.gate.usdm.max_order_notional_usdt, max_order_notional_usdt)
})

test('custom startup configuration stays selected and is never rewritten', (t) => {
  const { root, local } = fixture(t)
  const custom = path.join(root, 'config/custom.json')
  const config = loadConfig()
  writeJsonAtomic(custom, config)
  const adapter = createPaperSetupAdapter({ root, configPath: custom })
  assert.equal(adapter.status().code, 'CONTROL_PAPER_CUSTOM_CONFIG')
  assert.throws(() => adapter.setup(INPUT), { code: 'CONTROL_PAPER_CUSTOM_CONFIG' })
  for (const key of Object.keys(config.gate.usdm)) if (key in INPUT) config.gate.usdm[key] = INPUT[key]
  writeJsonAtomic(custom, config)
  const before = fs.readFileSync(custom, 'utf8')
  assert.equal(adapter.setup(INPUT).ready, true)
  assert.equal(adapter.configPath(), custom)
  assert.equal(fs.existsSync(local), false)
  assert.equal(fs.readFileSync(custom, 'utf8'), before)
})

test('failed account write rolls back only this operation and permits a safe retry', (t) => {
  for (const existing of [false, true]) {
    const { root, local, active } = fixture(t)
    if (existing) { const config = loadConfig(); config.gate.usdm.configured_leverage = '2'; writeJsonAtomic(local, config) }
    const before = existing ? fs.readFileSync(local, 'utf8') : null
    const adapter = createPaperSetupAdapter({ root, writeJson(file, value, options) { if (file === active) throw new Error('private-path'); writeJsonAtomic(file, value, options) } })
    assert.throws(() => adapter.setup(INPUT), { code: 'CONTROL_PAPER_STORAGE_FAILED' })
    assert.equal(fs.existsSync(active), false)
    assert.equal(fs.existsSync(local) ? fs.readFileSync(local, 'utf8') : null, before)
    assert.equal(createPaperSetupAdapter({ root }).setup(INPUT).ready, true)
  }
})

test('symlink targets or parents and non-paper configurations are refused', (t) => {
  for (const parent of [false, true]) {
    const { root, local, adapter } = fixture(t)
    const target = parent ? path.join(root, 'data') : local
    const other = path.join(root, 'other'); fs.mkdirSync(other)
    fs.symlinkSync(other, target)
    assert.equal(adapter.status().code, 'CONTROL_PAPER_UNSAFE_FILE')
    assert.throws(() => adapter.setup(INPUT), { code: 'CONTROL_PAPER_UNSAFE_FILE' })
    assert.deepEqual(fs.readdirSync(other), [])
  }
  const { adapter, local } = fixture(t)
  const config = loadConfig(); config.gate.usdm.environment = 'testnet'; writeJsonAtomic(local, config)
  assert.equal(adapter.status().code, 'CONTROL_PAPER_SCOPE_INVALID')
  assert.throws(() => adapter.setup(INPUT), { code: 'CONTROL_PAPER_SCOPE_INVALID' })
})

test('independent concurrent initializers converge on one unchanged account', async (t) => {
  const { root, active, local } = fixture(t)
  const script = `import {createPaperSetupAdapter} from ${JSON.stringify(new URL('../scripts/control-paper-setup.mjs', import.meta.url).href)}; const result = createPaperSetupAdapter({root:process.argv[1]}).setup(JSON.parse(process.argv[2])); process.stdout.write(JSON.stringify(result));`
  const run = () => new Promise((resolve, reject) => { const child = spawn(process.execPath, ['--input-type=module', '-e', script, root, JSON.stringify(INPUT)]); let stdout = ''; let stderr = ''; child.stdout.on('data', (value) => { stdout += value }); child.stderr.on('data', (value) => { stderr += value }); child.on('error', reject); child.on('exit', (code) => code ? reject(new Error(stderr)) : resolve(JSON.parse(stdout))) })
  const results = await Promise.all([run(), run()])
  assert.deepEqual(results[0], results[1])
  const ledger = validatePaperLedger(JSON.parse(fs.readFileSync(active)))
  assert.equal(ledger.config_digest, sha256Hex(JSON.parse(fs.readFileSync(local))))
  assert.equal(ledger.events.length, 0)
})

test('every existing malformed Paper account is blocked without changing its bytes', (t) => {
  for (const raw of ['null\n', 'false\n', '0\n', '""\n', '{}\n', '[]\n', '\n', '{broken']) {
    const { adapter, local, active } = fixture(t)
    fs.mkdirSync(path.dirname(active), { recursive: true })
    fs.writeFileSync(active, raw)
    const status = adapter.status()
    assert.equal(status.ready, false)
    assert.equal(status.status, 'blocked')
    assert.throws(() => adapter.setup(INPUT))
    assert.equal(fs.readFileSync(active, 'utf8'), raw)
    assert.equal(fs.existsSync(local), false)
  }
})
