import { validateSessionRoleModels, validateSessionRoleEfforts, validateSessionPool } from './session-provider.mjs'

export const PAPER_SETUP_FIELDS = Object.freeze(['configured_leverage', 'risk_per_trade_bps', 'max_order_notional_usdt', 'daily_new_notional_cap_usdt', 'max_managed_notional_usdt', 'initial_usdt', 'daily_loss_bps', 'max_drawdown_bps', 'max_spread_bps', 'max_entry_distance_bps', 'trigger_slippage_bps'])
export const CONVERSATION_SETTING_FIELDS = Object.freeze(['suggested_prompt', 'suggested_role_models', 'suggested_role_efforts', 'paper_settings', 'theme', 'model_settings'])
const bounded = (value, max, empty = false) => typeof value === 'string' && (empty || value.trim()) && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
function fail() { const error = new Error('PI_CONVERSATION_SETTINGS_INVALID'); error.code = error.message; throw error }
function object(value, keys) { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) fail() }
const decimalParts = (value) => { const [whole, fraction = ''] = String(value).split('.'); return [whole, fraction.replace(/0+$/, '')] }
export function comparePaperDecimal(a, b) {
  const [aw, af] = decimalParts(a); const [bw, bf] = decimalParts(b)
  const precision = Math.max(af.length, bf.length)
  const left = BigInt(aw + af.padEnd(precision, '0')); const right = BigInt(bw + bf.padEnd(precision, '0'))
  return left < right ? -1 : left > right ? 1 : 0
}
export function validatePaperSettings(input) {
  object(input, PAPER_SETUP_FIELDS)
  const values = {}
  for (const [key, value] of Object.entries(input)) {
    if (!['string', 'number'].includes(typeof value) || String(value).length > 80 || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(String(value)) || comparePaperDecimal(value, '0') <= 0) fail()
    if (key === 'configured_leverage' && !/^[123](?:\.0+)?$/.test(String(value))) fail()
    if (key.endsWith('_bps') && comparePaperDecimal(value, '10000') > 0) fail()
    values[key] = String(value)
  }
  for (const cap of ['daily_new_notional_cap_usdt', 'max_managed_notional_usdt']) if (values.max_order_notional_usdt && values[cap] && comparePaperDecimal(values.max_order_notional_usdt, values[cap]) > 0) fail()
  return values
}
export function validateConversationOutput(value, pool) {
  object(value, ['reply', 'intent', 'apply_fields', 'allocation_reasons', 'questions', 'assumptions', 'preferences', ...CONVERSATION_SETTING_FIELDS])
  if (!bounded(value.reply, 8000) || (value.intent !== undefined && !['explain', 'clarify', 'configure'].includes(value.intent))) fail()
  if (value.apply_fields !== undefined && (!Array.isArray(value.apply_fields) || value.apply_fields.length > CONVERSATION_SETTING_FIELDS.length || new Set(value.apply_fields).size !== value.apply_fields.length || value.apply_fields.some((field) => !CONVERSATION_SETTING_FIELDS.includes(field)))) fail()
  if (value.intent === 'configure' && (!value.apply_fields?.length || CONVERSATION_SETTING_FIELDS.some((field) => Object.hasOwn(value, field) && !value.apply_fields.includes(field)))) fail()
  if (value.intent === 'configure' && ['suggested_role_models', 'suggested_role_efforts'].some((field) => Object.hasOwn(value, field) && value[field] && typeof value[field] === 'object' && Object.keys(value[field]).length === 0)) fail()
  if (value.preferences !== undefined && !bounded(value.preferences, 2000, true)) fail()
  for (const [key, maxItems, maxText] of [['questions', 2, 240], ['assumptions', 6, 400]]) if (value[key] !== undefined && (!Array.isArray(value[key]) || value[key].length > maxItems || value[key].some((item) => !bounded(item, maxText)))) fail()
  if (value.model_settings !== undefined) {
    object(value.model_settings, ['pool', 'mode', 'bootstrap'])
    if (value.model_settings.pool !== undefined) validateSessionPool(value.model_settings.pool)
    if (value.model_settings.mode !== undefined && !['auto', 'manual'].includes(value.model_settings.mode)) fail()
    if (value.model_settings.bootstrap !== undefined) { object(value.model_settings.bootstrap, ['model', 'effort']); if (typeof value.model_settings.bootstrap.model !== 'string' || !['medium', 'high', 'xhigh'].includes(value.model_settings.bootstrap.effort)) fail() }
  }
  if (value.allocation_reasons !== undefined) {
    const roles = ['orchestrator', 'preflight', 'btc-analyst', 'eth-analyst', 'synthesizer', 'reviewer']
    object(value.allocation_reasons, roles)
    if (Object.keys(value.allocation_reasons).length !== roles.length || Object.values(value.allocation_reasons).some((text) => !bounded(text, 400))) fail()
  }
  if (value.suggested_prompt !== undefined && !bounded(value.suggested_prompt, 8000, true)) fail()
  if (value.suggested_role_models !== undefined) validateSessionRoleModels(value.suggested_role_models, value.model_settings?.pool || pool)
  if (value.suggested_role_efforts !== undefined) validateSessionRoleEfforts(value.suggested_role_efforts)
  if (value.paper_settings !== undefined) validatePaperSettings(value.paper_settings)
  if (value.theme !== undefined && !['light', 'night'].includes(value.theme)) fail()
  return value
}
