import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

function workflowFunction(name) {
  const source = fs.readFileSync(path.join(ROOT, '.claude', 'workflows', name), 'utf8')
    .replace('export const meta =', 'const meta =')
  return new AsyncFunction('args', 'agent', 'process', source)
}

function candidate(asset = 'BTC', overrides = {}) {
  return {
    schema: 'crypto_execution_candidate/v1',
    asset,
    product: 'usdm',
    symbol: `${asset}_USDT`,
    position_intent: 'ENTER_LONG',
    order_style: 'LIMIT',
    entry_price: 100,
    stop_price: 90,
    take_profit_price: 120,
    reduce_fraction_bps: null,
    data_as_of: '2030-01-07T12:00:00.000Z',
    anchor_week: '2030-W02',
    anchor_fresh: true,
    thesis_invalidation: `${asset} fixture invalidation`,
    evidence_refs: [`candidate.${asset}`],
    signal_id: `fixture:${asset.toLowerCase()}`,
    ...overrides
  }
}

function assetResult(asset, executionCandidates = []) {
  return {
    asset,
    symbol: `${asset}_USDT`,
    summary: `${asset} fixture`,
    spot_bias: 'neutral',
    usdm_bias: 'neutral',
    invalidation: null,
    anchor_week: '2030-W02',
    anchor_fresh: true,
    evidence_refs: [`assets.${asset}`],
    execution_candidates: executionCandidates,
    risks: []
  }
}

function weeklyDocument(overrides = {}) {
  return {
    schema: 'tyche_weekly_strategy/v1',
    date: '2030-01-07',
    iso_week: '2030-W02',
    generated_at: '2030-01-07T12:00:00.000Z',
    status: 'active',
    regime: {},
    assets: { BTC: assetResult('BTC'), ETH: assetResult('ETH') },
    execution_candidates: [],
    blockers: [],
    risks: [],
    ...overrides
  }
}

function dailyDocument(overrides = {}) {
  const btc = candidate('BTC')
  const eth = candidate('ETH')
  return {
    schema: 'tyche_crypto_daily/v1',
    date: '2030-01-07',
    iso_week: '2030-W02',
    generated_at: '2030-01-07T12:00:00.000Z',
    anchored_week: '2030-W02',
    anchor_fresh: true,
    regime: {},
    assets: {
      BTC: assetResult('BTC', [btc]),
      ETH: assetResult('ETH', [eth])
    },
    execution_candidates: [btc, eth],
    blockers: [],
    risks: [],
    ...overrides
  }
}

async function runWeeklyWithSynthesis(document) {
  const run = workflowFunction('crypto-analysis.mjs')
  let calls = 0
  const output = await run(
    { tier: 'weekly', date: '2030-01-07', isoWeek: '2030-W02' },
    async (_prompt, options) => {
      calls += 1
      if (options.phase === 'Preflight') return { config_ok: true, market_ok: true, snapshot_path: 'data/crypto_market.json', error: null }
      if (String(options.label).endsWith(':BTC')) return assetResult('BTC')
      if (String(options.label).endsWith(':ETH')) return assetResult('ETH')
      if (String(options.label).startsWith('Synthesis:')) return document
      throw new Error(`Unexpected agent call: ${options.label}`)
    },
    { env: { GATE_SPOT_READONLY_API_KEY: 'read-only-context' } }
  )
  assert.equal(calls, 4)
  return output
}

async function runDailyWithSynthesis(document) {
  const run = workflowFunction('crypto-analysis.mjs')
  let calls = 0
  const output = await run(
    { tier: 'daily', date: '2030-01-07', isoWeek: '2030-W02' },
    async (_prompt, options) => {
      calls += 1
      if (options.phase === 'Preflight') return { config_ok: true, market_ok: true, snapshot_path: 'data/crypto_market.json', error: null }
      if (String(options.label).endsWith(':BTC')) return assetResult('BTC')
      if (String(options.label).endsWith(':ETH')) return assetResult('ETH')
      if (String(options.label).startsWith('Synthesis:')) return document
      throw new Error(`Unexpected agent call: ${options.label}`)
    },
    { env: { GATE_SPOT_READONLY_API_KEY: 'read-only-context' } }
  )
  assert.equal(calls, 4)
  return output
}

test('preflight rejects inherited USDT-M mutation credentials before launching an agent', async () => {
  const run = workflowFunction('crypto-preflight.mjs')
  let calls = 0
  await assert.rejects(
    run({ date: '2030-01-07', isoWeek: '2030-W02' }, async () => { calls += 1 }, { env: { GATE_USDM_TESTNET_API_KEY: 'present' } }),
    /WORKFLOW_MUTATION_CREDENTIAL_PRESENT:GATE_USDM_TESTNET_API_KEY/
  )
  assert.equal(calls, 0)
})

test('analysis rejects inherited USDT-M mutation credentials before launching an agent', async () => {
  const run = workflowFunction('crypto-analysis.mjs')
  let calls = 0
  await assert.rejects(
    run({ tier: 'weekly', date: '2030-01-07', isoWeek: '2030-W02' }, async () => { calls += 1 }, { env: { GATE_USDM_TESTNET_SECRET_KEY: 'present' } }),
    /WORKFLOW_MUTATION_CREDENTIAL_PRESENT:GATE_USDM_TESTNET_SECRET_KEY/
  )
  assert.equal(calls, 0)
})

test('both workflows reject inherited Binance testnet credentials before launching an agent', async () => {
  for (const [file, input, credential] of [
    ['crypto-preflight.mjs', { date: '2030-01-07', isoWeek: '2030-W02' }, 'BINANCE_USDM_TESTNET_API_KEY'],
    ['crypto-analysis.mjs', { tier: 'daily', date: '2030-01-07', isoWeek: '2030-W02' }, 'BINANCE_USDM_TESTNET_SECRET_KEY']
  ]) {
    const run = workflowFunction(file)
    let calls = 0
    await assert.rejects(run(input, async () => { calls += 1 }, { env: { [credential]: 'present' } }), new RegExp(`WORKFLOW_MUTATION_CREDENTIAL_PRESENT:${credential}`))
    assert.equal(calls, 0)
  }
})

test('read-only public workflow context completes and returns structured data without persistence agents', async () => {
  const preflight = workflowFunction('crypto-preflight.mjs')
  let preflightCalls = 0
  const preflightResult = await preflight(
    { date: '2030-01-07', isoWeek: '2030-W02' },
    async () => { preflightCalls += 1; return { config_ok: true, market_ok: true, snapshot_path: 'data/crypto_market.json', error: null } },
    { env: { GATE_SPOT_READONLY_API_KEY: 'read-only-context' } }
  )
  assert.equal(preflightCalls, 1)
  assert.equal(preflightResult.credential_boundary, 'mutation_credentials_absent')

  const analysis = workflowFunction('crypto-analysis.mjs')
  let analysisCalls = 0
  const document = {
    schema: 'tyche_weekly_strategy/v1',
    date: '2030-01-07',
    iso_week: '2030-W02',
    generated_at: '2030-01-07T12:00:00.000Z',
    status: 'active',
    regime: {},
    assets: { BTC: assetResult('BTC'), ETH: assetResult('ETH') },
    execution_candidates: [],
    blockers: [],
    risks: []
  }
  const analysisResult = await analysis(
    { tier: 'weekly', date: '2030-01-07', isoWeek: '2030-W02' },
    async (_prompt, options) => {
      analysisCalls += 1
      if (options.phase === 'Preflight') return { config_ok: true, market_ok: true, snapshot_path: 'data/crypto_market.json', error: null }
      if (String(options.label).endsWith(':BTC')) return assetResult('BTC')
      if (String(options.label).endsWith(':ETH')) return assetResult('ETH')
      if (String(options.label).startsWith('Synthesis:')) return document
      throw new Error(`Unexpected agent call: ${options.label}`)
    },
    { env: { GATE_SPOT_READONLY_API_KEY: 'read-only-context' } }
  )
  assert.equal(analysisCalls, 4)
  assert.deepEqual(analysisResult.document, document)
  assert.equal(analysisResult.planning.environment, null)
  assert.equal(analysisResult.planning.submitted, 0)
})

test('analysis rejects a preflight missing config_ok or market_ok before launching analysis agents', async () => {
  for (const missing of ['config_ok', 'market_ok']) {
    const run = workflowFunction('crypto-analysis.mjs')
    let calls = 0
    await assert.rejects(
      run(
        { tier: 'weekly', date: '2030-01-07', isoWeek: '2030-W02' },
        async (_prompt, options) => {
          calls += 1
          if (options.phase === 'Preflight') {
            return missing === 'config_ok'
              ? { market_ok: true, snapshot_path: 'data/crypto_market.json', error: null }
              : { config_ok: true, snapshot_path: 'data/crypto_market.json', error: null }
          }
          throw new Error('analysis agent must not launch')
        },
        { env: {} }
      ),
      /CRYPTO_PREFLIGHT_FAILED/
    )
    assert.equal(calls, 1, missing)
  }
})

test('synthesis requires exactly BTC and ETH complete asset results', async () => {
  const cases = [
    ['missing ETH', (document) => { delete document.assets.ETH }],
    ['malformed BTC', (document) => { delete document.assets.BTC.summary }],
    ['extra asset', (document) => { document.assets.SOL = assetResult('BTC') }]
  ]
  for (const [label, mutate] of cases) {
    const document = weeklyDocument()
    mutate(document)
    await assert.rejects(runWeeklyWithSynthesis(document), /CRYPTO_SYNTHESIS_CONTRACT_INVALID/, label)
  }
})

test('valid exact BTC and ETH synthesis is accepted without persistence or execution agents', async () => {
  const result = await runWeeklyWithSynthesis(weeklyDocument())
  assert.deepEqual(result.document.assets, { BTC: assetResult('BTC'), ETH: assetResult('ETH') })
  assert.deepEqual(result.document.execution_candidates, [])
  assert.equal(result.credential_boundary, 'mutation_credentials_absent')
})

test('daily synthesis enforces asset symbols, nested scope, and exact BTC-then-ETH flattening', async () => {
  const cases = [
    ['swapped BTC block symbol', (document) => { document.assets.BTC.symbol = 'ETH_USDT' }],
    ['nested asset mismatch', (document) => { document.assets.BTC.execution_candidates[0].asset = 'ETH' }],
    ['top-level omission', (document) => { document.execution_candidates.pop() }],
    ['top-level extra', (document) => { document.execution_candidates.push(candidate('BTC', { signal_id: 'fixture:extra' })) }],
    ['top-level duplicate', (document) => { document.execution_candidates = [document.execution_candidates[0], document.execution_candidates[0]] }],
    ['top-level reorder', (document) => { document.execution_candidates.reverse() }],
    ['top-level field drift', (document) => { document.execution_candidates[0] = { ...document.execution_candidates[0], entry_price: 101 } }]
  ]
  for (const [label, mutate] of cases) {
    const document = dailyDocument()
    mutate(document)
    await assert.rejects(runDailyWithSynthesis(document), /CRYPTO_SYNTHESIS_CONTRACT_INVALID/, label)
  }
})

test('valid daily synthesis requires the exact BTC-then-ETH flattened candidate sequence', async () => {
  const document = dailyDocument()
  const result = await runDailyWithSynthesis(document)
  assert.deepEqual(result.document.execution_candidates, [
    document.assets.BTC.execution_candidates[0],
    document.assets.ETH.execution_candidates[0]
  ])
  assert.equal(result.document.assets.BTC.symbol, 'BTC_USDT')
  assert.equal(result.document.assets.ETH.symbol, 'ETH_USDT')
})
