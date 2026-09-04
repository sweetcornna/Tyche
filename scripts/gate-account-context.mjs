import { createHash } from 'node:crypto'

const DECIMAL = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))$/
const SUPPORTED = new Set(['BTC_USDT', 'ETH_USDT'])

function error(code, message) {
  const value = new Error(message || code)
  value.code = code
  return value
}

function parts(raw, label = 'decimal', options = {}) {
  const text = String(raw ?? '').trim()
  const match = text.match(DECIMAL)
  if (!match) throw error('DECIMAL_INVALID', `${label} must be a plain decimal`)
  const negative = match[1] === '-'
  const whole = match[2] || '0'
  const fraction = match[3] !== undefined ? match[3] : (match[4] || '')
  const integer = BigInt((whole + fraction).replace(/^0+(?=\d)/, '') || '0') * (negative ? -1n : 1n)
  if (options.nonNegative !== false && integer < 0n) throw error('DECIMAL_NEGATIVE', `${label} must be non-negative`)
  return { integer, scale: fraction.length }
}

function ten(scale) {
  if (!Number.isInteger(scale) || scale < 0 || scale > 100) throw error('DECIMAL_SCALE_INVALID', 'Decimal scale is outside the supported range')
  return 10n ** BigInt(scale)
}

function aligned(a, b) {
  const scale = Math.max(a.scale, b.scale)
  return [a.integer * ten(scale - a.scale), b.integer * ten(scale - b.scale), scale]
}

function render(integer, scale) {
  const negative = integer < 0n
  let digits = (negative ? -integer : integer).toString().padStart(scale + 1, '0')
  if (scale > 0) digits = `${digits.slice(0, -scale)}.${digits.slice(-scale)}`
  digits = digits.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
  if (!digits) digits = '0'
  return negative && digits !== '0' ? `-${digits}` : digits
}

export function decimalCompare(left, right) {
  const [a, b] = aligned(parts(left, 'left', { nonNegative: false }), parts(right, 'right', { nonNegative: false }))
  return a < b ? -1 : a > b ? 1 : 0
}

export function decimalAdd(left, right) {
  const [a, b, scale] = aligned(parts(left, 'left', { nonNegative: false }), parts(right, 'right', { nonNegative: false }))
  return render(a + b, scale)
}

export function decimalSubtract(left, right) {
  const value = parts(right, 'right', { nonNegative: false })
  return decimalAdd(left, render(-value.integer, value.scale))
}

export function decimalMultiply(left, right) {
  const a = parts(left, 'left', { nonNegative: false })
  const b = parts(right, 'right', { nonNegative: false })
  return render(a.integer * b.integer, a.scale + b.scale)
}

export function decimalAbs(value) {
  const parsed = parts(value, 'value', { nonNegative: false })
  return render(parsed.integer < 0n ? -parsed.integer : parsed.integer, parsed.scale)
}

export function decimalPositive(value) {
  try { return parts(value, 'value', { nonNegative: false }).integer > 0n } catch { return false }
}

export function quantizeDown(value, step) {
  const a = parts(value, 'value')
  const b = parts(step, 'step')
  if (b.integer <= 0n) throw error('DECIMAL_STEP_INVALID', 'Step must be positive')
  const scale = Math.max(a.scale, b.scale)
  const scaledValue = a.integer * ten(scale - a.scale)
  const scaledStep = b.integer * ten(scale - b.scale)
  return render((scaledValue / scaledStep) * scaledStep, scale)
}

export function quantizeUp(value, step) {
  const a = parts(value, 'value')
  const b = parts(step, 'step')
  if (b.integer <= 0n) throw error('DECIMAL_STEP_INVALID', 'Step must be positive')
  const scale = Math.max(a.scale, b.scale)
  const scaledValue = a.integer * ten(scale - a.scale)
  const scaledStep = b.integer * ten(scale - b.scale)
  let units = scaledValue / scaledStep
  if (scaledValue % scaledStep !== 0n) units += 1n
  return render(units * scaledStep, scale)
}

export function divideToStep(numerator, denominator, step) {
  const a = parts(numerator, 'numerator')
  const b = parts(denominator, 'denominator')
  const s = parts(step, 'step')
  if (b.integer <= 0n || s.integer <= 0n) throw error('DECIMAL_DIVISION_INVALID', 'Denominator and step must be positive')
  const unitsNumerator = a.integer * ten(b.scale) * ten(s.scale)
  const unitsDenominator = ten(a.scale) * b.integer * s.integer
  const units = unitsNumerator / unitsDenominator
  return decimalMultiply(units.toString(), step)
}

export function ratioAtLeast(reward, risk, minimum) {
  const a = parts(reward, 'reward')
  const b = parts(risk, 'risk')
  const m = parts(minimum, 'minimum')
  if (a.integer <= 0n || b.integer <= 0n || m.integer <= 0n) return false
  return a.integer * ten(b.scale) * ten(m.scale) >= b.integer * ten(a.scale) * m.integer
}

function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
}

function digest(value) {
  return createHash('sha256').update(stable(value), 'utf8').digest('hex')
}

function iso(now = Date.now) {
  const time = typeof now === 'function' ? now() : now
  const value = new Date(time).toISOString()
  if (!Number.isFinite(Date.parse(value))) throw error('ACCOUNT_TIME_INVALID', 'Account timestamp is invalid')
  return value
}

function symbol(value) {
  const normalized = String(value || '').trim().toUpperCase()
  if (!SUPPORTED.has(normalized)) throw error('ACCOUNT_SYMBOL_UNSUPPORTED', 'Account context supports BTC_USDT and ETH_USDT only')
  return normalized
}

export function normalizeSpotFunding(payload, options = {}) {
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.accounts) ? payload.accounts : null
  if (!rows) throw error('SPOT_ACCOUNT_PAYLOAD_INVALID', 'Spot account response must be an array')
  const usdt = rows.find((row) => String(row?.currency || '').toUpperCase() === 'USDT')
  if (!usdt) throw error('SPOT_USDT_ROW_MISSING', 'Spot USDT account row is missing')
  const available = render(parts(usdt.available, 'spot USDT available').integer, parts(usdt.available, 'spot USDT available').scale)
  return {
    schema: 'tyche_funding_context/v1',
    product: 'spot',
    environment: 'dry-run',
    funding_source: 'spot_readonly_available',
    wallet: 'SPOT',
    asset: 'USDT',
    available_quote: available,
    generated_at: iso(options.now)
  }
}

export function normalizeUsdmFunding(payload, options = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw error('USDM_ACCOUNT_PAYLOAD_INVALID', 'USDT-M account response must be an object')
  if (payload.currency !== undefined && String(payload.currency).toUpperCase() !== 'USDT') throw error('USDM_ACCOUNT_ASSET_INVALID', 'USDT-M account must use USDT')
  const parsed = parts(payload.available, 'USDT-M available')
  return {
    schema: 'tyche_funding_context/v1',
    product: 'usdm',
    environment: 'testnet',
    funding_source: 'usdm_testnet_available',
    wallet: 'USDT_FUTURES_TESTNET',
    asset: 'USDT',
    available_quote: render(parsed.integer, parsed.scale),
    one_way_proof: payload.in_dual_mode === false,
    generated_at: iso(options.now)
  }
}

export function normalizeUsdmPositionReadiness(payload, options = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw error('USDM_POSITION_PAYLOAD_INVALID', 'USDT-M position response must be an object')
  const pair = symbol(payload.contract || payload.symbol)
  if (String(payload.mode || '').trim().toLowerCase() !== 'single') throw error('ONE_WAY_POSITION_UNPROVEN', `${pair} position response does not prove one-way mode`)
  if (String(payload.pos_margin_mode || '').trim().toLowerCase() !== 'isolated') throw error('ISOLATED_MARGIN_MODE_UNPROVEN', `${pair} position response does not prove isolated margin mode`)
  const configured = parts(options.configuredLeverage, 'configured leverage')
  const actual = parts(payload.lever, 'position lever')
  const configuredText = render(configured.integer, configured.scale)
  const actualText = render(actual.integer, actual.scale)
  if (configured.integer <= 0n || actual.integer <= 0n || decimalCompare(actualText, configuredText) > 0) {
    throw error('ISOLATED_LEVERAGE_UNPROVEN', `${pair} position leverage exceeds or does not prove the configured limit`)
  }
  return {
    schema: 'tyche_usdm_position_readiness/v1',
    symbol: pair,
    one_way: true,
    margin_mode: 'isolated',
    actual_leverage: actualText,
    configured_leverage: configuredText
  }
}

export function applyFundingPolicy(funding, policy = {}) {
  if (funding?.schema !== 'tyche_funding_context/v1') throw error('FUNDING_CONTEXT_INVALID', 'Funding context schema is invalid')
  const fraction = parts(policy.risk_capital_fraction_bps ?? 10000, 'risk_capital_fraction_bps')
  const buffer = parts(policy.balance_buffer_bps ?? 0, 'balance_buffer_bps')
  if (fraction.integer <= 0n || decimalCompare(render(fraction.integer, fraction.scale), '10000') > 0) throw error('FUNDING_FRACTION_INVALID', 'Risk capital fraction must be in (0, 10000]')
  if (buffer.integer < 0n || decimalCompare(render(buffer.integer, buffer.scale), '10000') >= 0) throw error('FUNDING_BUFFER_INVALID', 'Balance buffer must be in [0, 10000)')
  const afterBuffer = decimalMultiply(funding.available_quote, decimalMultiply(decimalSubtract('10000', render(buffer.integer, buffer.scale)), '0.0001'))
  const effective = decimalMultiply(afterBuffer, decimalMultiply(render(fraction.integer, fraction.scale), '0.0001'))
  return {
    ...funding,
    available_quote: afterBuffer,
    effective_risk_capital: effective,
    policy: {
      risk_capital_fraction_bps: Number(render(fraction.integer, fraction.scale)),
      balance_buffer_bps: Number(render(buffer.integer, buffer.scale))
    }
  }
}

function plansByIntent(ledger) {
  const map = new Map()
  for (const plan of ledger?.plans || []) for (const intent of plan?.intents || []) map.set(intent.intent_id, { plan, intent })
  return map
}

function fillContracts(fill) {
  for (const key of ['contracts', 'size', 'quantity', 'amount']) {
    if (fill?.[key] !== undefined && decimalPositive(decimalAbs(fill[key]))) return decimalAbs(fill[key])
  }
  return '0'
}

function contractsByIntent(ledger) {
  const result = new Map()
  for (const fill of ledger.fills || []) {
    const quantity = fillContracts(fill)
    if (!decimalPositive(quantity)) continue
    result.set(fill.intent_id, decimalAdd(result.get(fill.intent_id) || '0', quantity))
  }
  return result
}

function proportionalNotional(intent, contracts) {
  const quantity = decimalAbs(intent.quantity || '0')
  const wanted = decimalAbs(contracts || '0')
  if (!decimalPositive(quantity) || !decimalPositive(wanted) || !decimalPositive(intent.estimated_notional)) return '0'
  if (decimalCompare(wanted, quantity) >= 0) return String(intent.estimated_notional)
  return divideToStep(decimalMultiply(String(intent.estimated_notional), wanted), quantity, '0.000000000000000001')
}

export function reservationEntries(ledger = {}, product = '') {
  const wanted = String(product || '').toLowerCase()
  const filledByIntent = contractsByIntent(ledger)
  const output = []
  for (const plan of ledger.plans || []) {
    if (String(plan.product || '').toLowerCase() !== wanted) continue
    for (const intent of plan.intents || []) {
      if (intent.role !== 'ENTRY' || !decimalPositive(intent.quantity) || !decimalPositive(intent.estimated_notional)) continue
      const events = (ledger.events || []).filter((event) => event.intent_id === intent.intent_id)
      if (!events.some((event) => event.state === 'SUBMISSION_RESERVED')) continue
      const filled = filledByIntent.get(intent.intent_id) || '0'
      let target = '0'
      let reservationAt = null
      let latestAt = null
      let state = 'PLANNED'
      for (const event of events) {
        state = String(event.state || state)
        latestAt = event.at || latestAt
        if (state === 'SUBMISSION_RESERVED') {
          target = String(intent.quantity)
          reservationAt = event.at || reservationAt
        } else if (state === 'RESERVATION_RELEASED' || state === 'REJECTED' || state === 'BLOCKED') {
          target = '0'
        } else if (['SUBMITTED', 'PARTIALLY_FILLED', 'CANCEL_REQUESTED', 'SUBMISSION_AMBIGUOUS'].includes(state)) {
          target = String(intent.quantity)
        } else if (state === 'FILLED') {
          target = decimalPositive(event.executed_contracts) ? decimalAbs(event.executed_contracts) : String(intent.quantity)
        } else if (state === 'CANCELLED') {
          target = decimalPositive(event.executed_contracts) ? decimalAbs(event.executed_contracts) : '0'
        } else if (state === 'PROTECTION_PENDING' || state === 'PROTECTED') {
          target = filled
        }
      }
      const remaining = decimalCompare(target, filled) > 0 ? decimalSubtract(target, filled) : '0'
      output.push({
        plan,
        intent,
        state,
        reservation_at: reservationAt,
        latest_at: latestAt,
        filled_contracts: filled,
        pending_contracts: remaining,
        filled_notional: proportionalNotional(intent, filled),
        pending_notional: proportionalNotional(intent, remaining)
      })
    }
  }
  return output
}

export function managedQuantities(ledger = {}, product = '') {
  const wanted = String(product || '').toLowerCase()
  const intents = plansByIntent(ledger)
  const result = {}
  for (const fill of ledger.fills || []) {
    const match = intents.get(fill.intent_id)
    if (!match) {
      if (fill?.ledger_role !== 'EMERGENCY_REDUCTION') continue
      const parent = intents.get(fill.parent_intent_id)
      const quantity = fillContracts(fill)
      const signed = String(fill.signed_contracts ?? '')
      if (!parent || String(parent.plan.product || '').toLowerCase() !== wanted || parent.plan.plan_id !== fill.plan_id || parent.intent.symbol !== fill.symbol || !fill.cause_id || !fill.cause_intent_id || !/^-?\d+$/.test(signed) || !decimalPositive(decimalAbs(signed)) || decimalCompare(decimalAbs(signed), quantity) !== 0) {
        throw error('EMERGENCY_FILL_INVALID', 'Emergency reduction fill is not bound to a sealed parent plan and exact signed quantity')
      }
      const action = String(parent.intent.action || '').toUpperCase()
      const correctSign = action === 'ENTER_LONG' ? signed.startsWith('-') : action === 'ENTER_SHORT' ? !signed.startsWith('-') : false
      if (!correctSign) throw error('EMERGENCY_FILL_DIRECTION_INVALID', 'Emergency reduction fill does not reduce its sealed parent exposure')
      const pair = symbol(parent.intent.symbol)
      result[pair] = decimalAdd(result[pair] || '0', signed)
      continue
    }
    if (String(match.plan.product || '').toLowerCase() !== wanted) continue
    const pair = symbol(match.intent.symbol)
    const quantity = fillContracts(fill)
    if (!decimalPositive(quantity)) continue
    const action = String(match.intent.action || '').toUpperCase()
    const sign = ['ENTER_LONG', 'REDUCE_SHORT', 'EXIT_SHORT'].includes(action) ? 1 : -1
    result[pair] = decimalAdd(result[pair] || '0', sign > 0 ? quantity : decimalSubtract('0', quantity))
  }
  return result
}

export function dailyUsage(ledger = {}, product = '', now = Date.now) {
  const day = iso(now).slice(0, 10)
  let notional = '0'
  let count = 0
  for (const entry of reservationEntries(ledger, product)) {
    if (String(entry.reservation_at || '').slice(0, 10) !== day) continue
    const used = decimalAdd(entry.filled_notional, entry.pending_notional)
    if (!decimalPositive(used)) continue
    notional = decimalAdd(notional, used)
    count += 1
  }
  return { daily_new_notional_used: notional, daily_order_count: count }
}

export function buildAccountEpochs(funding, options = {}) {
  if (funding?.schema !== 'tyche_funding_context/v1' || !decimalPositive(funding.effective_risk_capital ?? funding.available_quote)) {
    throw error('ACCOUNT_FUNDING_UNAVAILABLE', 'Positive product-local funding is required')
  }
  const symbols = [...new Set((options.symbols || []).map(symbol))]
  if (!symbols.length) throw error('ACCOUNT_SYMBOLS_REQUIRED', 'At least one supported symbol is required')
  const managed = managedQuantities(options.ledger || {}, funding.product)
  const usage = dailyUsage(options.ledger || {}, funding.product, options.now)
  const output = {}
  for (const pair of symbols) {
    const identity = {
      product: funding.product,
      environment: funding.environment,
      funding_source: funding.funding_source,
      wallet: funding.wallet,
      asset: funding.asset,
      symbol: pair,
      generated_at: funding.generated_at,
      available_quote: funding.available_quote,
      effective_risk_capital: funding.effective_risk_capital ?? funding.available_quote,
      managed_quantity: managed[pair] || '0',
      ...usage
    }
    output[`${funding.product}:${pair}`] = {
      schema: 'tyche_account_epoch/v1',
      account_epoch_id: `tae_${digest(identity).slice(0, 24)}`,
      ...identity
    }
  }
  return output
}

export function fundingProjection(funding) {
  if (funding?.schema !== 'tyche_funding_context/v1') throw error('FUNDING_CONTEXT_INVALID', 'Funding context schema is invalid')
  return {
    schema: 'tyche_funding_projection/v1',
    generated_at: funding.generated_at,
    product: funding.product,
    environment: funding.environment,
    funding_source: funding.funding_source,
    wallet: funding.wallet,
    asset: funding.asset,
    available_quote: funding.available_quote,
    effective_risk_capital: funding.effective_risk_capital ?? null
  }
}
