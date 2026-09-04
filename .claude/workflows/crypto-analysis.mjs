export const meta = {
  name: 'crypto-analysis',
  description: 'Weekly BTC/ETH anchor or daily tactics from public evidence; returns structured output and never persists or submits',
  phases: [
    { title: 'Preflight', detail: 'Read-only configuration and public snapshot validation' },
    { title: 'Analysis', detail: 'BTC and ETH evidence-bound analysis' },
    { title: 'Synthesis', detail: 'Weekly anchor or daily semantic candidates' },
    { title: 'Handoff', detail: 'Structured result for deterministic top-level persistence' }
  ]
}

const MUTATION_CREDENTIALS = ['GATE_USDM_TESTNET_API_KEY', 'GATE_USDM_TESTNET_SECRET_KEY', 'BINANCE_USDM_TESTNET_API_KEY', 'BINANCE_USDM_TESTNET_SECRET_KEY']
if (typeof process !== 'object' || !process?.env) throw new Error('WORKFLOW_ENV_UNAVAILABLE')
const inheritedMutationCredentials = MUTATION_CREDENTIALS.filter((name) => String(process.env[name] || '').trim())
if (inheritedMutationCredentials.length) throw new Error(`WORKFLOW_MUTATION_CREDENTIAL_PRESENT:${inheritedMutationCredentials.join(',')}`)

let input = args
if (typeof input === 'string') {
  try { input = JSON.parse(input) } catch { input = {} }
}
input = input || {}
const tier = String(input.tier || '')
const date = String(input.date || '')
const isoWeek = String(input.isoWeek || '')
if (!['weekly', 'daily'].includes(tier)) throw new Error('CRYPTO_TIER_REQUIRED: tier must be weekly or daily')
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('WORKFLOW_DATE_REQUIRED: date must be YYYY-MM-DD')
if (!/^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/.test(isoWeek)) throw new Error('WORKFLOW_ISOWEEK_REQUIRED: isoWeek must be YYYY-Www')
const configPath = String(input.config || 'config/tyche.json')
if (!/^config\/[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(configPath)) throw new Error('WORKFLOW_CONFIG_PATH_INVALID')

const preflight = await agent(
  `Read only ${configPath}, data/crypto_market.json, and for tier=daily data/crypto_strategy.json if present. Confirm the config and market schemas, exact BTC/ETH scope, and that market date=${date} and iso_week=${isoWeek}. Do not run commands, write files, inspect environment variables, read private account/plan/ledger data, or call exchange clients. Return the structured result only.`,
  {
    label: 'Crypto read-only preflight',
    phase: 'Preflight',
    agentType: 'crypto-mechanical',
    model: 'sonnet',
    effort: 'low',
    schema: {
      type: 'object',
      required: ['config_ok', 'market_ok', 'snapshot_path'],
      properties: {
        config_ok: { type: 'boolean' },
        market_ok: { type: 'boolean' },
        snapshot_path: { type: 'string', enum: ['data/crypto_market.json'] },
        error: { type: ['string', 'null'] }
      },
      additionalProperties: false
    }
  }
)
if (!preflight || preflight.config_ok !== true || preflight.market_ok !== true) throw new Error(`CRYPTO_PREFLIGHT_FAILED:${preflight?.error || 'config_or_market_not_verified'}`)

const CANDIDATE = {
  type: 'object',
  required: ['schema', 'asset', 'product', 'symbol', 'position_intent', 'order_style', 'entry_price', 'stop_price', 'take_profit_price', 'reduce_fraction_bps', 'data_as_of', 'anchor_week', 'anchor_fresh', 'thesis_invalidation', 'evidence_refs', 'signal_id'],
  properties: {
    schema: { type: 'string', enum: ['crypto_execution_candidate/v1'] },
    asset: { type: 'string', enum: ['BTC', 'ETH'] },
    product: { type: 'string', enum: ['spot', 'usdm'] },
    symbol: { type: 'string', enum: ['BTC_USDT', 'ETH_USDT'] },
    position_intent: { type: 'string', enum: ['ENTER_LONG', 'ENTER_SHORT', 'REDUCE_LONG', 'REDUCE_SHORT', 'EXIT_LONG', 'EXIT_SHORT', 'NO_TRADE'] },
    order_style: { type: 'string', enum: ['LIMIT'] },
    entry_price: { type: ['number', 'null'] },
    stop_price: { type: ['number', 'null'] },
    take_profit_price: { type: ['number', 'null'] },
    reduce_fraction_bps: { type: ['integer', 'null'] },
    data_as_of: { type: 'string' },
    anchor_week: { type: 'string' },
    anchor_fresh: { type: 'boolean' },
    thesis_invalidation: { type: 'string' },
    evidence_refs: { type: 'array', items: { type: 'string' } },
    signal_id: { type: 'string' }
  },
  additionalProperties: false
}
const ASSET_RESULT = {
  type: 'object',
  required: ['asset', 'symbol', 'summary', 'spot_bias', 'usdm_bias', 'invalidation', 'anchor_week', 'anchor_fresh', 'evidence_refs', 'execution_candidates', 'risks'],
  properties: {
    asset: { type: 'string', enum: ['BTC', 'ETH'] },
    symbol: { type: 'string', enum: ['BTC_USDT', 'ETH_USDT'] },
    summary: { type: 'string' },
    spot_bias: { type: 'string', enum: ['long', 'neutral', 'reduce'] },
    usdm_bias: { type: 'string', enum: ['long', 'short', 'neutral', 'reduce'] },
    invalidation: { type: ['number', 'null'] },
    anchor_week: { type: 'string' },
    anchor_fresh: { type: 'boolean' },
    evidence_refs: { type: 'array', items: { type: 'string' } },
    execution_candidates: { type: 'array', maxItems: tier === 'weekly' ? 0 : 2, items: CANDIDATE },
    risks: { type: 'array', items: { type: 'string' } }
  },
  additionalProperties: false
}

const assetResults = await Promise.all(['BTC', 'ETH'].map((asset) => agent(
  `Analyze ${asset} for the ${tier} tier dated ${date}, ISO week ${isoWeek}. Read only data/crypto_market.json and, when tier=daily, data/crypto_strategy.json if present.\n\nNo-hallucination veto: every numeric claim and every candidate price must be copied from the current snapshot and cite its exact JSON path. When multi_exchange is present, use its sealed aggregates for cross-venue confirmation, dispersion, best bid/ask context, and median funding context, and state when coverage is partial. Never use a multi-exchange consensus value as an executable price. A candidate may copy one complete Gate level_sets triple under assets; do not calculate new prices. If a complete supported triple is unavailable or inconsistent, return no candidate. Never emit quantity, notional, contracts, leverage, client IDs, reduce_only, methods, paths, hosts, signatures, account values, or execution status.\n\nWeekly must return execution_candidates=[]. Daily entries require an active strategy whose iso_week equals ${isoWeek}. A stale or missing anchor permits only a semantic managed REDUCE/EXIT or NO_TRADE. Spot never permits short entry. Use data/crypto_market.json.generated_at for candidate data_as_of. Return the required structured asset result only; do not write files or call exchange operations.`,
  {
    label: `${tier}:${asset}`,
    phase: 'Analysis',
    agentType: 'crypto-analyst',
    model: 'opus',
    schema: ASSET_RESULT
  }
)))
if (assetResults.some((row) => !row)) throw new Error('CRYPTO_ASSET_ANALYSIS_INCOMPLETE')

const FINAL_SCHEMA = {
  type: 'object',
  required: tier === 'weekly'
    ? ['schema', 'date', 'iso_week', 'generated_at', 'status', 'regime', 'assets', 'execution_candidates', 'blockers', 'risks']
    : ['schema', 'date', 'iso_week', 'generated_at', 'anchored_week', 'anchor_fresh', 'regime', 'assets', 'execution_candidates', 'blockers', 'risks'],
  properties: {
    schema: { type: 'string', enum: [tier === 'weekly' ? 'tyche_weekly_strategy/v1' : 'tyche_crypto_daily/v1'] },
    date: { type: 'string', enum: [date] },
    iso_week: { type: 'string', enum: [isoWeek] },
    generated_at: { type: 'string' },
    status: { type: 'string', enum: ['active'] },
    anchored_week: { type: ['string', 'null'] },
    anchor_fresh: { type: 'boolean' },
    regime: { type: 'object' },
    assets: {
      type: 'object',
      required: ['BTC', 'ETH'],
      properties: { BTC: ASSET_RESULT, ETH: ASSET_RESULT },
      additionalProperties: false
    },
    execution_candidates: { type: 'array', maxItems: tier === 'weekly' ? 0 : 4, items: CANDIDATE },
    blockers: { type: 'array', items: { type: 'object' } },
    risks: { type: 'array', items: { type: 'string' } }
  },
  additionalProperties: false
}
const synthesis = await agent(
  `Synthesize the ${tier} BTC/ETH result for date=${date}, isoWeek=${isoWeek}. Read data/crypto_market.json only to copy generated_at and verify cited fields. For daily, read data/crypto_strategy.json and set anchored_week/anchor_fresh from the file itself; do not infer freshness from prose. Preserve each asset result without inventing numbers. The assets object must contain exactly the two keys BTC and ETH, with no additional or missing asset; each value must preserve the complete asset result contract. Flatten execution_candidates exactly. Weekly candidates must remain empty. Daily candidates must retain the exact semantic schema and must not gain quantity, contracts, leverage, client identity, reduce_only, route, signature, account, or lifecycle fields. Return JSON only and do not write files.\n\nasset_results=${JSON.stringify(assetResults)}`,
  {
    label: `Synthesis:${tier}`,
    phase: 'Synthesis',
    agentType: 'crypto-analyst',
    model: 'opus',
    schema: FINAL_SCHEMA
  }
)

const FINAL_KEYS = new Set([
  'schema', 'date', 'iso_week', 'generated_at', 'status', 'anchored_week', 'anchor_fresh',
  'regime', 'assets', 'execution_candidates', 'blockers', 'risks'
])
const FINAL_ASSET_KEYS = new Set(['asset', 'symbol', 'summary', 'spot_bias', 'usdm_bias', 'invalidation', 'anchor_week', 'anchor_fresh', 'evidence_refs', 'execution_candidates', 'risks'])
const FINAL_CANDIDATE_KEYS = new Set(['schema', 'asset', 'product', 'symbol', 'position_intent', 'order_style', 'entry_price', 'stop_price', 'take_profit_price', 'reduce_fraction_bps', 'data_as_of', 'anchor_week', 'anchor_fresh', 'thesis_invalidation', 'evidence_refs', 'signal_id'])

function synthesisInvalid(reason) {
  throw new Error(`CRYPTO_SYNTHESIS_CONTRACT_INVALID:${reason}`)
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value, required, allowed, label) {
  if (!isObject(value)) synthesisInvalid(`${label}_OBJECT_REQUIRED`)
  const keys = Object.keys(value)
  const missing = required.filter((key) => !Object.prototype.hasOwnProperty.call(value, key))
  const extra = keys.filter((key) => !allowed.has(key))
  if (missing.length) synthesisInvalid(`${label}_MISSING:${missing.join(',')}`)
  if (extra.length) synthesisInvalid(`${label}_EXTRA:${extra.join(',')}`)
}

function stringValue(value, label) {
  if (typeof value !== 'string') synthesisInvalid(`${label}_STRING_REQUIRED`)
}

function booleanValue(value, label) {
  if (typeof value !== 'boolean') synthesisInvalid(`${label}_BOOLEAN_REQUIRED`)
}

function stringArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) synthesisInvalid(`${label}_STRING_ARRAY_INVALID`)
}

function objectArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => !isObject(item))) synthesisInvalid(`${label}_OBJECT_ARRAY_INVALID`)
}

function nullableNumber(value, label) {
  if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) synthesisInvalid(`${label}_NUMBER_INVALID`)
}

function nullableInteger(value, label) {
  if (value !== null && (typeof value !== 'number' || !Number.isInteger(value))) synthesisInvalid(`${label}_INTEGER_INVALID`)
}

function validateFinalCandidate(candidate, label, expectedAsset = null) {
  exactKeys(candidate, [...FINAL_CANDIDATE_KEYS], FINAL_CANDIDATE_KEYS, label)
  if (candidate.schema !== 'crypto_execution_candidate/v1') synthesisInvalid(`${label}_SCHEMA_INVALID`)
  if (!['BTC', 'ETH'].includes(candidate.asset)) synthesisInvalid(`${label}_ASSET_INVALID`)
  if (!['spot', 'usdm'].includes(candidate.product)) synthesisInvalid(`${label}_PRODUCT_INVALID`)
  if (!['BTC_USDT', 'ETH_USDT'].includes(candidate.symbol)) synthesisInvalid(`${label}_SYMBOL_INVALID`)
  if (candidate.symbol !== `${candidate.asset}_USDT`) synthesisInvalid(`${label}_SYMBOL_ASSET_MISMATCH`)
  if (expectedAsset !== null && candidate.asset !== expectedAsset) synthesisInvalid(`${label}_ASSET_SCOPE_INVALID`)
  if (expectedAsset !== null && candidate.symbol !== `${expectedAsset}_USDT`) synthesisInvalid(`${label}_SYMBOL_SCOPE_INVALID`)
  if (!['ENTER_LONG', 'ENTER_SHORT', 'REDUCE_LONG', 'REDUCE_SHORT', 'EXIT_LONG', 'EXIT_SHORT', 'NO_TRADE'].includes(candidate.position_intent)) synthesisInvalid(`${label}_POSITION_INTENT_INVALID`)
  if (candidate.order_style !== 'LIMIT') synthesisInvalid(`${label}_ORDER_STYLE_INVALID`)
  nullableNumber(candidate.entry_price, `${label}.entry_price`)
  nullableNumber(candidate.stop_price, `${label}.stop_price`)
  nullableNumber(candidate.take_profit_price, `${label}.take_profit_price`)
  nullableInteger(candidate.reduce_fraction_bps, `${label}.reduce_fraction_bps`)
  stringValue(candidate.data_as_of, `${label}.data_as_of`)
  stringValue(candidate.anchor_week, `${label}.anchor_week`)
  booleanValue(candidate.anchor_fresh, `${label}.anchor_fresh`)
  stringValue(candidate.thesis_invalidation, `${label}.thesis_invalidation`)
  stringArray(candidate.evidence_refs, `${label}.evidence_refs`)
  stringValue(candidate.signal_id, `${label}.signal_id`)
}

function validateFinalAsset(assetResult, asset, label) {
  exactKeys(assetResult, [...FINAL_ASSET_KEYS], FINAL_ASSET_KEYS, label)
  if (!['BTC', 'ETH'].includes(assetResult.asset)) synthesisInvalid(`${label}.asset_INVALID`)
  if (assetResult.asset !== asset) synthesisInvalid(`${label}.asset_SCOPE_INVALID`)
  if (assetResult.symbol !== `${asset}_USDT`) synthesisInvalid(`${label}.symbol_SCOPE_INVALID`)
  stringValue(assetResult.summary, `${label}.summary`)
  if (!['long', 'neutral', 'reduce'].includes(assetResult.spot_bias)) synthesisInvalid(`${label}.spot_bias_INVALID`)
  if (!['long', 'short', 'neutral', 'reduce'].includes(assetResult.usdm_bias)) synthesisInvalid(`${label}.usdm_bias_INVALID`)
  nullableNumber(assetResult.invalidation, `${label}.invalidation`)
  stringValue(assetResult.anchor_week, `${label}.anchor_week`)
  booleanValue(assetResult.anchor_fresh, `${label}.anchor_fresh`)
  stringArray(assetResult.evidence_refs, `${label}.evidence_refs`)
  if (!Array.isArray(assetResult.execution_candidates) || assetResult.execution_candidates.length > (tier === 'weekly' ? 0 : 2)) synthesisInvalid(`${label}.execution_candidates_INVALID`)
  assetResult.execution_candidates.forEach((candidate, index) => validateFinalCandidate(candidate, `${label}.execution_candidates[${index}]`, asset))
  stringArray(assetResult.risks, `${label}.risks`)
}

function candidateFingerprint(candidate) {
  return JSON.stringify([...FINAL_CANDIDATE_KEYS].map((key) => candidate[key]))
}

function validateFlattenedCandidates(document) {
  const expected = [
    ...document.assets.BTC.execution_candidates,
    ...document.assets.ETH.execution_candidates
  ]
  if (document.execution_candidates.length !== expected.length) synthesisInvalid('document.execution_candidates_FLATTENING_LENGTH_MISMATCH')
  expected.forEach((candidate, index) => {
    if (candidateFingerprint(document.execution_candidates[index]) !== candidateFingerprint(candidate)) {
      synthesisInvalid(`document.execution_candidates_FLATTENING_MISMATCH:${index}`)
    }
  })
}

function validateFinalDocument(document) {
  const required = tier === 'weekly'
    ? ['schema', 'date', 'iso_week', 'generated_at', 'status', 'regime', 'assets', 'execution_candidates', 'blockers', 'risks']
    : ['schema', 'date', 'iso_week', 'generated_at', 'anchored_week', 'anchor_fresh', 'regime', 'assets', 'execution_candidates', 'blockers', 'risks']
  exactKeys(document, required, FINAL_KEYS, 'document')
  const expectedSchema = tier === 'weekly' ? 'tyche_weekly_strategy/v1' : 'tyche_crypto_daily/v1'
  if (document.schema !== expectedSchema) synthesisInvalid('document.schema_INVALID')
  if (document.date !== date) synthesisInvalid('document.date_MISMATCH')
  if (document.iso_week !== isoWeek) synthesisInvalid('document.iso_week_MISMATCH')
  stringValue(document.generated_at, 'document.generated_at')
  if (tier === 'weekly' && document.status !== 'active') synthesisInvalid('document.status_INVALID')
  if (document.status !== undefined && document.status !== 'active') synthesisInvalid('document.status_INVALID')
  if (document.anchored_week !== undefined && document.anchored_week !== null) stringValue(document.anchored_week, 'document.anchored_week')
  if (document.anchor_fresh !== undefined) booleanValue(document.anchor_fresh, 'document.anchor_fresh')
  if (tier === 'daily') {
    if (document.anchored_week !== null && typeof document.anchored_week !== 'string') synthesisInvalid('document.anchored_week_INVALID')
    booleanValue(document.anchor_fresh, 'document.anchor_fresh')
  }
  if (!isObject(document.regime)) synthesisInvalid('document.regime_OBJECT_REQUIRED')
  exactKeys(document.assets, ['BTC', 'ETH'], new Set(['BTC', 'ETH']), 'document.assets')
  validateFinalAsset(document.assets.BTC, 'BTC', 'document.assets.BTC')
  validateFinalAsset(document.assets.ETH, 'ETH', 'document.assets.ETH')
  if (!Array.isArray(document.execution_candidates) || document.execution_candidates.length > (tier === 'weekly' ? 0 : 4)) synthesisInvalid('document.execution_candidates_INVALID')
  document.execution_candidates.forEach((candidate, index) => validateFinalCandidate(candidate, `document.execution_candidates[${index}]`))
  validateFlattenedCandidates(document)
  objectArray(document.blockers, 'document.blockers')
  stringArray(document.risks, 'document.risks')
  return document
}

if (!synthesis) throw new Error('CRYPTO_SYNTHESIS_FAILED')
validateFinalDocument(synthesis)
const inbox = tier === 'weekly' ? 'data/_inbox/crypto-weekly.json' : 'data/_inbox/crypto-daily.json'
const output = tier === 'weekly' ? 'data/crypto_strategy.json' : 'data/crypto_daily.json'
const report = tier === 'weekly' ? `outputs/weekly-${isoWeek}.md` : `outputs/daily-${date}.md`
const requiredKeys = tier === 'weekly'
  ? ['schema', 'date', 'iso_week', 'generated_at', 'status', 'regime', 'assets', 'execution_candidates', 'blockers', 'risks']
  : ['schema', 'date', 'iso_week', 'generated_at', 'anchored_week', 'anchor_fresh', 'regime', 'assets', 'execution_candidates', 'blockers', 'risks']
return {
  tier,
  date,
  isoWeek,
  assets: ['BTC', 'ETH'],
  credential_boundary: 'mutation_credentials_absent',
  document: synthesis,
  persistence: {
    inbox,
    output,
    report,
    required_keys: requiredKeys,
    expected_candidates: synthesis.execution_candidates.length
  },
  planning: tier === 'daily' ? { products: ['spot', 'usdm'], environment: 'dry-run', submitted: 0 } : { products: [], environment: null, submitted: 0 }
}
