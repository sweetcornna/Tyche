import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { commitInbox, resetInbox, resolveOutputPath, validateAgentPayload } from '../scripts/agent-write.mjs'
import { readJsonStrict, updateJsonLocked, writeJsonAtomic } from '../scripts/lib-iolock.mjs'
import { renderConciseReport, reportFromAnalysis } from '../scripts/concise-report.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function canonicalAsset(asset) {
  return {
    asset,
    symbol: `${asset}_USDT`,
    summary: `${asset} fixture`,
    spot_bias: 'neutral',
    usdm_bias: 'neutral',
    invalidation: null,
    anchor_week: '2030-W02',
    anchor_fresh: true,
    evidence_refs: [`fixture.${asset}`],
    execution_candidates: [],
    risks: []
  }
}

function canonicalWeekly(overrides = {}) {
  return {
    schema: 'tyche_weekly_strategy/v1',
    date: '2030-01-07',
    iso_week: '2030-W02',
    generated_at: '2030-01-07T12:00:00.000Z',
    status: 'active',
    regime: { label: 'fixture' },
    assets: { BTC: canonicalAsset('BTC'), ETH: canonicalAsset('ETH') },
    execution_candidates: [],
    blockers: [],
    risks: [],
    ...overrides
  }
}

function canonicalCandidate(asset = 'BTC', overrides = {}) {
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
    thesis_invalidation: `${asset} fixture`,
    evidence_refs: [`fixture.${asset}`],
    signal_id: `fixture:${asset.toLowerCase()}`,
    ...overrides
  }
}

function canonicalDaily() {
  const btc = canonicalCandidate('BTC')
  const eth = canonicalCandidate('ETH', { entry_price: 200, stop_price: 180, take_profit_price: 240 })
  return {
    schema: 'tyche_crypto_daily/v1',
    date: '2030-01-07',
    iso_week: '2030-W02',
    generated_at: '2030-01-07T12:00:00.000Z',
    anchored_week: '2030-W02',
    anchor_fresh: true,
    regime: { label: 'fixture' },
    assets: {
      BTC: { ...canonicalAsset('BTC'), execution_candidates: [btc] },
      ETH: { ...canonicalAsset('ETH'), execution_candidates: [eth] }
    },
    execution_candidates: [btc, eth],
    blockers: [],
    risks: []
  }
}

test('zero-byte and corrupt state fail loudly and are never replaced by defaults', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-state-'))
  const zero = path.join(directory, 'zero.json')
  fs.writeFileSync(zero, '')
  assert.throws(() => readJsonStrict(zero, { missingDefault: {} }), { code: 'STATE_ZERO_LENGTH' })
  const corrupt = path.join(directory, 'corrupt.json')
  fs.writeFileSync(corrupt, '{broken')
  assert.throws(() => updateJsonLocked(corrupt, () => ({ replaced: true }), { missingDefault: {} }), { code: 'STATE_JSON_CORRUPT' })
  assert.equal(fs.readFileSync(corrupt, 'utf8'), '{broken')
})

test('locked JSON update preserves append-only caller semantics', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-update-'))
  const target = path.join(directory, 'state.json')
  writeJsonAtomic(target, { rows: [] })
  updateJsonLocked(target, (value) => ({ rows: [...value.rows, 1] }), { missingDefault: { rows: [] } })
  updateJsonLocked(target, (value) => ({ rows: [...value.rows, 2] }), { missingDefault: { rows: [] } })
  assert.deepEqual(readJsonStrict(target), { rows: [1, 2] })
})

test('agent payload validation catches truncation and output path escape', () => {
  assert.throws(() => validateAgentPayload('{"rows":[]}', { mode: 'json', arrayKey: 'rows', expectCount: 1 }), { code: 'AGENT_WRITE_COUNT_MISMATCH' })
  assert.throws(() => resolveOutputPath('../outside.json'), { code: 'AGENT_WRITE_OUTPUT_INVALID' })
})

test('agent inbox commit validates before atomically writing canonical runtime output', () => {
  const name = `unit-${process.pid}-${Date.now()}.json`
  const inbox = `data/_inbox/${name}`
  const output = `data/${name}`
  const inboxAbsolute = path.join(ROOT, inbox)
  const outputAbsolute = path.join(ROOT, output)
  try {
    resetInbox(inbox)
    fs.writeFileSync(inboxAbsolute, JSON.stringify({ schema: 'fixture/v1', iso_week: '2030-W02', rows: [{ id: 1 }] }), 'utf8')
    const result = commitInbox(inbox, output, { mode: 'json', requireKeys: ['schema', 'iso_week', 'rows'], arrayKey: 'rows', expectCount: 1, week: '2030-W02', weekKey: 'iso_week' })
    assert.equal(result.ok, true)
    assert.deepEqual(readJsonStrict(outputAbsolute).rows, [{ id: 1 }])
    assert.equal(fs.existsSync(inboxAbsolute), false)
  } finally {
    fs.rmSync(inboxAbsolute, { force: true })
    fs.rmSync(outputAbsolute, { force: true })
  }
})

test('canonical strategy output validates exact nested assets and persists atomically', () => {
  const inbox = `data/_inbox/crypto-strategy-${process.pid}-${Date.now()}.json`
  const output = 'data/crypto_strategy.json'
  const inboxAbsolute = path.join(ROOT, inbox)
  const outputAbsolute = path.join(ROOT, output)
  const document = canonicalWeekly()
  try {
    resetInbox(inbox)
    fs.writeFileSync(inboxAbsolute, JSON.stringify(document), 'utf8')
    const result = commitInbox(inbox, output, { mode: 'json', requireKeys: ['schema'] })
    assert.equal(result.ok, true)
    assert.deepEqual(readJsonStrict(outputAbsolute), document)
    assert.equal(fs.existsSync(inboxAbsolute), false)
  } finally {
    fs.rmSync(inboxAbsolute, { force: true })
    fs.rmSync(outputAbsolute, { force: true })
  }
})

test('canonical daily output validates its asset and candidate contract before persistence', () => {
  const inbox = `data/_inbox/crypto-daily-${process.pid}-${Date.now()}.json`
  const output = 'data/crypto_daily.json'
  const inboxAbsolute = path.join(ROOT, inbox)
  const outputAbsolute = path.join(ROOT, output)
  const document = canonicalDaily()
  try {
    resetInbox(inbox)
    fs.writeFileSync(inboxAbsolute, JSON.stringify(document), 'utf8')
    const result = commitInbox(inbox, output, { mode: 'json', requireKeys: ['schema'] })
    assert.equal(result.ok, true)
    assert.deepEqual(readJsonStrict(outputAbsolute), document)
    assert.equal(fs.existsSync(inboxAbsolute), false)
  } finally {
    fs.rmSync(inboxAbsolute, { force: true })
    fs.rmSync(outputAbsolute, { force: true })
  }
})

test('canonical persistence cannot be bypassed by top-level key lists or malformed nested assets', () => {
  const inbox = `data/_inbox/crypto-strategy-invalid-${process.pid}-${Date.now()}.json`
  const output = 'data/crypto_strategy.json'
  const inboxAbsolute = path.join(ROOT, inbox)
  const outputAbsolute = path.join(ROOT, output)
  const original = canonicalWeekly()
  const cases = [
    ['missing ETH', (document) => { delete document.assets.ETH }],
    ['malformed BTC', (document) => { delete document.assets.BTC.summary }],
    ['extra asset', (document) => { document.assets.SOL = canonicalAsset('BTC') }]
  ]
  try {
    writeJsonAtomic(outputAbsolute, original)
    for (const [label, mutate] of cases) {
      const document = structuredClone(original)
      mutate(document)
      resetInbox(inbox)
      fs.writeFileSync(inboxAbsolute, JSON.stringify(document), 'utf8')
      assert.throws(
        () => commitInbox(inbox, output, {
          mode: 'json',
          requireKeys: ['schema', 'date', 'iso_week', 'generated_at', 'status', 'regime', 'assets', 'execution_candidates', 'blockers', 'risks']
        }),
        { code: 'AGENT_WRITE_CANONICAL_INVALID' },
        label
      )
      assert.deepEqual(readJsonStrict(outputAbsolute), original, label)
      assert.equal(fs.existsSync(inboxAbsolute), true, label)
      fs.rmSync(inboxAbsolute, { force: true })
    }
  } finally {
    fs.rmSync(inboxAbsolute, { force: true })
    fs.rmSync(outputAbsolute, { force: true })
  }
})

test('canonical daily persistence rejects scope and flattening drift without replacing output', () => {
  const inbox = `data/_inbox/crypto-daily-invalid-${process.pid}-${Date.now()}.json`
  const output = 'data/crypto_daily.json'
  const inboxAbsolute = path.join(ROOT, inbox)
  const outputAbsolute = path.join(ROOT, output)
  const original = canonicalDaily()
  const cases = [
    ['swapped BTC block symbol', (document) => { document.assets.BTC.symbol = 'ETH_USDT' }],
    ['nested asset mismatch', (document) => { document.assets.BTC.execution_candidates[0].asset = 'ETH' }],
    ['top-level omission', (document) => { document.execution_candidates.pop() }],
    ['top-level extra', (document) => { document.execution_candidates.push(canonicalCandidate('BTC', { signal_id: 'fixture:extra' })) }],
    ['top-level duplicate', (document) => { document.execution_candidates = [document.execution_candidates[0], document.execution_candidates[0]] }],
    ['top-level reorder', (document) => { document.execution_candidates.reverse() }],
    ['top-level field drift', (document) => { document.execution_candidates[0] = { ...document.execution_candidates[0], entry_price: 101 } }]
  ]
  try {
    writeJsonAtomic(outputAbsolute, original)
    for (const [label, mutate] of cases) {
      const document = structuredClone(original)
      mutate(document)
      resetInbox(inbox)
      fs.writeFileSync(inboxAbsolute, JSON.stringify(document), 'utf8')
      assert.throws(
        () => commitInbox(inbox, output, { mode: 'json', requireKeys: ['schema'] }),
        { code: 'AGENT_WRITE_CANONICAL_INVALID' },
        label
      )
      assert.deepEqual(readJsonStrict(outputAbsolute), original, label)
      assert.equal(fs.existsSync(inboxAbsolute), true, label)
      fs.rmSync(inboxAbsolute, { force: true })
    }
  } finally {
    fs.rmSync(inboxAbsolute, { force: true })
    fs.rmSync(outputAbsolute, { force: true })
  }
})

test('concise reports refuse unproven fill claims and state no submission truthfully', () => {
  assert.throws(() => renderConciseReport({
    title: 'bad',
    as_of: '2030-01-07T00:00:00.000Z',
    scope: 'test',
    conclusions: [],
    execution: { mode: 'manual_testnet', planned_orders: [], events: [{ status: 'FILLED' }], submitted: 1, filled: 1, rejected: 0, cancelled: 0 },
    recommendations: [], blockers: [], risks: [], audit_artifacts: []
  }), { code: 'REPORT_FILL_PROOF_MISSING' })

  const weekly = {
    schema: 'tyche_weekly_strategy/v1',
    date: '2030-01-07',
    iso_week: '2030-W02',
    generated_at: '2030-01-07T00:00:00.000Z',
    regime: { label: 'not_established' },
    assets: { BTC: { analysis_status: 'gap' }, ETH: { analysis_status: 'gap' } },
    execution_candidates: []
  }
  const markdown = renderConciseReport(reportFromAnalysis(weekly, 'weekly'))
  assert.match(markdown, /No order was sent to a trading venue\./)
  assert.doesNotMatch(markdown, /FILLED/)
})
