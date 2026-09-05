import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import {
  PiProtocolError,
  buildWorkerEnv,
  makeJob,
  makeResult,
  promptForJob,
  MAX_OUTPUT_BYTES,
  MAX_PAYLOAD_BYTES,
  SESSION_MODEL_IDS,
  runCluster,
  runPiAgentJob,
  runWorkerProcess,
  validateJob,
  validateResult
} from '../src/index.mjs'

const DATE = '2030-01-07'
const WEEK = '2030-W02'

function job(overrides = {}) {
  return makeJob({
    jobId: 'run:preflight',
    runId: 'run',
    role: 'preflight',
    asset: null,
    tier: 'daily',
    date: DATE,
    isoWeek: WEEK,
    provider: 'fixture',
    model: 'fixture-model',
    attempt: 0,
    timeoutMs: 200,
    input: { evidence: { source: 'fixture', assets: ['BTC', 'ETH'] } },
    ...overrides
  })
}

function ok(jobValue, output = { summary: 'ok' }) {
  return makeResult(jobValue, { status: 'ok', output })
}

function clusterOptions(overrides = {}) {
  return {
    runId: 'cluster-run',
    tier: 'daily',
    date: DATE,
    isoWeek: WEEK,
    provider: 'fixture',
    model: 'fixture-model',
    evidence: { source: 'fixture', assets: { BTC: { source: 'fixture#btc' }, ETH: { source: 'fixture#eth' } } },
    timeoutMs: 200,
    ...overrides
  }
}

function canonicalOutput(tier = 'daily') {
  const asset = (name) => ({
    asset: name,
    symbol: `${name}_USDT`,
    summary: `${name} fixture summary`,
    spot_bias: 'neutral',
    usdm_bias: 'neutral',
    invalidation: null,
    anchor_week: WEEK,
    anchor_fresh: true,
    evidence_refs: [],
    execution_candidates: [],
    risks: []
  })
  return tier === 'weekly'
    ? {
        schema: 'tyche_weekly_strategy/v1', date: DATE, iso_week: WEEK,
        generated_at: '2030-01-07T12:00:00.000Z', status: 'active', regime: {},
        assets: { BTC: asset('BTC'), ETH: asset('ETH') }, execution_candidates: [], blockers: [], risks: []
      }
    : {
        schema: 'tyche_crypto_daily/v1', date: DATE, iso_week: WEEK,
        generated_at: '2030-01-07T12:00:00.000Z', anchored_week: WEEK,
        anchor_fresh: true, regime: {}, assets: { BTC: asset('BTC'), ETH: asset('ETH') },
        execution_candidates: [], blockers: [], risks: []
      }
}

function stageOutput(currentJob) {
  if (currentJob.role === 'synthesizer' || currentJob.role === 'reviewer') return canonicalOutput(currentJob.tier)
  if (currentJob.role === 'preflight') return { status: 'ready', evidence_refs: [], blockers: [] }
  return { role: currentJob.role, semantic: true }
}

test('job and result validators reject unknown fields and roles', () => {
  assert.throws(() => validateJob({ ...job(), unexpected: true }), (error) => error instanceof PiProtocolError && error.code === 'PI_SCHEMA_UNKNOWN_FIELD')
  assert.throws(() => validateJob({ ...job(), role: 'admin' }), (error) => error instanceof PiProtocolError && error.code === 'PI_SCHEMA_ROLE')
  assert.throws(() => validateResult({ ...ok(job()), unexpected: true }), (error) => error instanceof PiProtocolError && error.code === 'PI_SCHEMA_UNKNOWN_FIELD')
})

test('worker boundary rejects credentials and execution state in nested input', () => {
  assert.throws(() => makeJob({ ...job(), input: { evidence: { GATE_USDM_TESTNET_API_KEY: 'secret' } } }), (error) => error.code === 'PI_FORBIDDEN_FIELD')
  assert.throws(() => makeJob({ ...job(), input: { plan: { status: 'READY' } } }), (error) => error.code === 'PI_FORBIDDEN_FIELD')
  assert.throws(() => makeJob({ ...job(), input: { fills: [] } }), (error) => error.code === 'PI_FORBIDDEN_FIELD')
})

test('provider environment is minimal and removes trading credentials', () => {
  const env = buildWorkerEnv({
    provider: 'openai',
    baseEnv: {
      PATH: '/bin',
      HOME: '/private/home',
      OPENAI_BASE_URL: 'https://attacker.invalid',
      GATE_USDM_TESTNET_API_KEY: 'gate-key',
      BINANCE_USDM_TESTNET_SECRET_KEY: 'binance-secret',
      OPENAI_API_KEY: 'model-key',
      AWS_SECRET_ACCESS_KEY: 'not-allowed'
    }
  })
  assert.deepEqual(env, { PATH: '/bin', OPENAI_API_KEY: 'model-key' })
  assert.equal(Object.hasOwn(env, 'OPENAI_BASE_URL'), false)
  assert.throws(() => buildWorkerEnv({ provider: 'openai', providerEnv: { OPENAI_BASE_URL: 'https://attacker.invalid' } }), /PI_PROVIDER_ENV_NOT_ALLOWLISTED/)
  assert.throws(() => buildWorkerEnv({ provider: 'openai', providerEnv: { HOST: 'attacker.invalid' } }), /PI_PROVIDER_ENV_NOT_ALLOWLISTED/)
  assert.throws(() => buildWorkerEnv({ provider: 'openai', providerEnv: { GATE_USDM_TESTNET_API_KEY: 'bad' } }), /PI_CREDENTIAL_ENV_BLOCKED/)
  assert.throws(() => buildWorkerEnv({ provider: 'openai', providerEnv: { UNKNOWN_API_KEY: 'bad' } }), /PI_PROVIDER_ENV_NOT_ALLOWLISTED/)
})

test('Pi 0.84.4 Agent API accepts only submit_analysis and returns validated output', async () => {
  const faux = fauxProvider({ provider: 'fixture', models: [{ id: 'fixture-model' }] })
  faux.setResponses([fauxAssistantMessage(fauxToolCall('submit_analysis', { analysis: { summary: 'agent output' } }))])
  const result = await runPiAgentJob(job(), {
    model: faux.getModel(),
    streamFn: faux.provider.streamSimple.bind(faux.provider)
  })
  assert.equal(result.status, 'ok')
  assert.deepEqual(result.output, { summary: 'agent output' })
  assert.equal(result.provenance.piAgentCore, '0.84.4')
})

test('role prompts fix the weekly/daily responsibilities and reviewer contract', () => {
  const weeklyReviewer = promptForJob(job({ role: 'reviewer', tier: 'weekly', input: { synthesis: {} } }))
  assert.match(weeklyReviewer, /complete canonical document unchanged/i)
  assert.match(promptForJob(job({ role: 'btc-analyst', asset: 'BTC', tier: 'weekly' })), /weekly output must contain zero candidates/i)
  assert.match(promptForJob(job({ role: 'eth-analyst', asset: 'ETH', tier: 'daily' })), /only the supplied ETH asset evidence/i)
})

test('malicious or invalid tool calls fail closed without executing another tool', async () => {
  const malicious = fauxProvider({ provider: 'fixture', models: [{ id: 'fixture-model' }] })
  malicious.setResponses([fauxAssistantMessage(fauxToolCall('bash', { command: 'touch should-not-run' }))])
  const unauthorized = await runPiAgentJob(job(), {
    model: malicious.getModel(),
    streamFn: malicious.provider.streamSimple.bind(malicious.provider)
  })
  assert.equal(unauthorized.status, 'error')

  const invalid = fauxProvider({ provider: 'fixture', models: [{ id: 'fixture-model' }] })
  invalid.setResponses([fauxAssistantMessage(fauxToolCall('submit_analysis', { analysis: 'not-an-object' }))])
  const malformed = await runPiAgentJob(job(), {
    model: invalid.getModel(),
    streamFn: invalid.provider.streamSimple.bind(invalid.provider)
  })
  assert.equal(malformed.status, 'error')
})

test('cluster runs BTC and ETH in parallel and respects the bounded DAG', async () => {
  const calls = []
  let active = 0
  let maxActive = 0
  const result = await runCluster(clusterOptions({
    evidence: {
      source: 'fixture',
      assets: { BTC: { source: 'fixture#btc' }, ETH: { source: 'fixture#eth' } },
      contracts: [{ symbol: 'BTC_USDT', contract_size: 0.001 }],
      trades: [{ price: 100, amount: 1 }],
      positioning: { open_interest: 10 },
      order_book: { bids: [], asks: [] }
    },
    runJob: async (currentJob) => {
      calls.push(`${currentJob.role}:start`)
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, currentJob.role.endsWith('analyst') ? 20 : 1))
      active -= 1
      calls.push(`${currentJob.role}:end`)
      return ok(currentJob, stageOutput(currentJob))
    }
  }))
  assert.equal(result.status, 'ok')
  assert.ok(maxActive >= 2)
  assert.ok(calls.indexOf('orchestrator:end') < calls.indexOf('preflight:start'))
  assert.ok(calls.indexOf('preflight:end') < calls.indexOf('btc-analyst:start'))
  assert.ok(calls.indexOf('btc-analyst:end') < calls.indexOf('synthesizer:start'))
  assert.ok(calls.indexOf('eth-analyst:end') < calls.indexOf('synthesizer:start'))
  assert.ok(calls.indexOf('synthesizer:end') < calls.indexOf('reviewer:start'))
  assert.deepEqual(result.provenance.roles, ['orchestrator', 'preflight', 'btc-analyst', 'eth-analyst', 'synthesizer', 'reviewer'])
})

test('cluster lifecycle events are fixed, ordered, and cannot carry analysis payloads', async () => {
  const events = []
  const result = await runCluster(clusterOptions({
    onEvent: (event) => {
      events.push(event)
      throw new Error('observer must not affect the DAG')
    },
    runJob: async (currentJob) => ok(currentJob, stageOutput(currentJob))
  }))
  assert.equal(result.status, 'ok')
  assert.ok(events.length >= 12)
  for (const event of events) {
    assert.deepEqual(Object.keys(event).sort(), ['asset', 'attempt', 'role', 'runId', 'status', 'tier'])
    assert.ok(['started', 'completed', 'failed'].includes(event.status))
    assert.equal(Object.hasOwn(event, 'output'), false)
    assert.equal(Object.hasOwn(event, 'input'), false)
  }
  assert.deepEqual(events.slice(0, 4).map(({ role, status }) => [role, status]), [
    ['orchestrator', 'started'], ['orchestrator', 'completed'],
    ['preflight', 'started'], ['preflight', 'completed']
  ])
  const analystStarts = events.filter((event) => event.status === 'started' && ['btc-analyst', 'eth-analyst'].includes(event.role))
  assert.deepEqual(analystStarts.map((event) => event.role), ['btc-analyst', 'eth-analyst'])
  const synthesisStart = events.findIndex((event) => event.role === 'synthesizer' && event.status === 'started')
  assert.ok(synthesisStart > events.findIndex((event) => event.role === 'btc-analyst' && event.status === 'completed'))
  assert.ok(synthesisStart > events.findIndex((event) => event.role === 'eth-analyst' && event.status === 'completed'))
})

test('a valid daily semantic candidate survives analyst, synthesis, and review stages', async () => {
  const candidate = (asset) => ({
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
    anchor_week: WEEK,
    anchor_fresh: true,
    thesis_invalidation: `${asset} fixture invalidation`,
    evidence_refs: [`fixture#${asset.toLowerCase()}`],
    signal_id: `fixture:${asset.toLowerCase()}`
  })
  const assetAnalysis = (asset) => ({
    asset,
    symbol: `${asset}_USDT`,
    summary: `${asset} semantic analysis`,
    spot_bias: 'neutral',
    usdm_bias: 'neutral',
    invalidation: null,
    anchor_week: WEEK,
    anchor_fresh: true,
    evidence_refs: [`asset.${asset}`],
    execution_candidates: [candidate(asset)],
    risks: []
  })
  const daily = {
    schema: 'tyche_crypto_daily/v1',
    date: DATE,
    iso_week: WEEK,
    generated_at: '2030-01-07T12:00:00.000Z',
    anchored_week: WEEK,
    anchor_fresh: true,
    regime: { label: 'fixture' },
    assets: { BTC: assetAnalysis('BTC'), ETH: assetAnalysis('ETH') },
    execution_candidates: [candidate('BTC'), candidate('ETH')],
    blockers: [],
    risks: []
  }
  const result = await runCluster(clusterOptions({
    runJob: async (currentJob) => {
      if (currentJob.role === 'orchestrator') return ok(currentJob, { coordination: 'fixed-dag' })
      if (currentJob.role === 'preflight') return ok(currentJob, { status: 'ready', evidence_scope: ['BTC', 'ETH'] })
      if (currentJob.role === 'btc-analyst') return ok(currentJob, assetAnalysis('BTC'))
      if (currentJob.role === 'eth-analyst') return ok(currentJob, assetAnalysis('ETH'))
      return ok(currentJob, daily)
    }
  }))
  assert.equal(result.status, 'ok')
  assert.equal(result.output.execution_candidates[0].position_intent, 'ENTER_LONG')
  assert.equal(result.output.execution_candidates[0].entry_price, 100)
  assert.equal(result.output.assets.BTC.execution_candidates[0].take_profit_price, 120)
})

test('synthesizer and reviewer enforce the nested canonical document contract', async () => {
  const invalidWeekly = canonicalOutput('weekly')
  invalidWeekly.assets.BTC.execution_candidates.push({})
  const blocked = await runCluster(clusterOptions({
    tier: 'weekly',
    runJob: async (currentJob) => currentJob.role === 'synthesizer'
      ? ok(currentJob, invalidWeekly)
      : ok(currentJob, stageOutput(currentJob))
  }))
  assert.equal(blocked.status, 'blocked')
  assert.equal(blocked.blockers[0], 'synthesis_failed')

  const synthesis = canonicalOutput('daily')
  const changed = structuredClone(synthesis)
  changed.regime = { label: 'silently changed' }
  const reviewed = await runCluster(clusterOptions({
    runJob: async (currentJob) => {
      if (currentJob.role === 'synthesizer') return ok(currentJob, synthesis)
      if (currentJob.role === 'reviewer') return ok(currentJob, changed)
      return ok(currentJob, stageOutput(currentJob))
    }
  }))
  assert.equal(reviewed.status, 'blocked')
  assert.equal(reviewed.blockers[0], 'review_output_mismatch')
  assert.equal(reviewed.results.at(-1).role, 'reviewer')
  assert.equal(reviewed.results.at(-1).status, 'ok')
})

test('orchestrator runs first and its coordination context reaches preflight', async () => {
  const inputs = {}
  const result = await runCluster(clusterOptions({
    runJob: async (currentJob) => {
      if (currentJob.role === 'orchestrator') return ok(currentJob, { coordination: 'fixed-dag' })
      if (currentJob.role === 'preflight') {
        inputs.preflight = currentJob.input
        return ok(currentJob, { status: 'ready' })
      }
      return ok(currentJob, stageOutput(currentJob))
    }
  }))
  assert.equal(result.status, 'ok')
  assert.deepEqual(inputs.preflight.coordination, { coordination: 'fixed-dag' })
  assert.equal(result.results[0].role, 'orchestrator')
})

test('asset analysts receive only their corresponding public evidence slice', async () => {
  const inputs = {}
  await runCluster(clusterOptions({
    runJob: async (currentJob) => {
      if (currentJob.role === 'btc-analyst' || currentJob.role === 'eth-analyst') inputs[currentJob.role] = currentJob.input
      if (currentJob.role === 'preflight') return ok(currentJob, {
        status: 'ready',
        evidence_refs: ['public.BTC', 'public.ETH'],
        blockers: [],
        BTC: { evidence: 'must-not-cross' },
        ETH: { evidence: 'must-not-cross' }
      })
      return ok(currentJob, stageOutput(currentJob))
    }
  }))
  assert.deepEqual(inputs['btc-analyst'].assetEvidence, { source: 'fixture#btc' })
  assert.deepEqual(inputs['eth-analyst'].assetEvidence, { source: 'fixture#eth' })
  assert.deepEqual(inputs['btc-analyst'].preflight, { status: 'ready', evidence_refs: ['public.BTC', 'public.ETH'], blockers: [] })
  assert.deepEqual(inputs['eth-analyst'].preflight, { status: 'ready', evidence_refs: ['public.BTC', 'public.ETH'], blockers: [] })
  assert.equal(Object.hasOwn(inputs['btc-analyst'].preflight, 'ETH'), false)
  assert.equal(Object.hasOwn(inputs['eth-analyst'].preflight, 'BTC'), false)
  assert.equal(Object.hasOwn(inputs['btc-analyst'], 'evidence'), false)
  assert.equal(Object.hasOwn(inputs['eth-analyst'], 'evidence'), false)
})

test('orchestrator failure blocks without launching preflight', async () => {
  const calls = []
  const result = await runCluster(clusterOptions({
    runJob: async (currentJob) => {
      calls.push(currentJob.role)
      if (currentJob.role === 'orchestrator') throw new Error('orchestrator crashed')
      return ok(currentJob, stageOutput(currentJob))
    }
  }))
  assert.equal(result.status, 'blocked')
  assert.equal(result.blockers[0], 'orchestrator_failed')
  assert.deepEqual(calls, ['orchestrator', 'orchestrator'])
  assert.deepEqual(result.results.map((item) => item.role), ['orchestrator'])
})

test('execution-owned quantity, leverage, and client identity remain rejected', () => {
  for (const field of ['quantity', 'leverage', 'client_id', 'reduce_only']) {
    assert.throws(() => makeJob({ ...job(), input: { evidence: { [field]: 1 } } }), (error) => error.code === 'PI_FORBIDDEN_FIELD', field)
  }
  for (const field of ['quantity', 'leverage', 'client_id', 'reduce_only']) {
    assert.throws(() => validateResult({ ...ok(job(), { [field]: 1 }) }), (error) => error.code === 'PI_FORBIDDEN_FIELD', field)
  }
})

test('missing model configuration blocks before launching workers', async () => {
  await assert.rejects(runCluster({
    tier: 'daily', date: DATE, isoWeek: WEEK, provider: 'fixture',
    evidence: { source: 'fixture' }, runJob: async () => { throw new Error('must not run') }
  }), /PI_MODEL_REQUIRED/)
})

test('one retry is allowed, then failure is fail-closed', async () => {
  let attempts = 0
  const recovered = await runCluster(clusterOptions({
    runJob: async (currentJob) => {
      if (currentJob.role === 'btc-analyst' && currentJob.attempt === 0) {
        attempts += 1
        throw new Error('transient')
      }
      attempts += 1
      return ok(currentJob, stageOutput(currentJob))
    }
  }))
  assert.equal(recovered.status, 'ok')
  assert.equal(recovered.results.find((item) => item.role === 'btc-analyst').attempt, 1)

  let failedAttempts = 0
  const failed = await runCluster(clusterOptions({
    runJob: async (currentJob) => {
      failedAttempts += 1
      if (currentJob.role === 'eth-analyst') throw new Error('crashed worker')
      return ok(currentJob, stageOutput(currentJob))
    }
  }))
  assert.equal(failed.status, 'blocked')
  assert.equal(failed.blockers[0], 'asset_analysis_failed')
  assert.equal(failedAttempts, 5)
})

test('timeout and duplicate result are bounded and fail closed', async () => {
  let timeoutCalls = 0
  const timedOut = await runCluster(clusterOptions({
    timeoutMs: 10,
    runJob: async (currentJob) => {
      if (currentJob.role === 'btc-analyst') {
        timeoutCalls += 1
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      return ok(currentJob, stageOutput(currentJob))
    }
  }))
  assert.equal(timedOut.status, 'blocked')
  assert.equal(timeoutCalls, 2)

  let duplicateCalls = 0
  const duplicated = await runCluster(clusterOptions({
    runJob: async (currentJob) => {
      duplicateCalls += 1
      return currentJob.role === 'eth-analyst' ? [ok(currentJob), ok(currentJob)] : ok(currentJob, stageOutput(currentJob))
    }
  }))
  assert.equal(duplicated.status, 'blocked')
  assert.equal(duplicateCalls, 5)
})

test('worker process timeout, crash, and duplicate output are reclaimed and rejected', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-pi-agents-'))
  try {
    const timeoutPath = path.join(temporary, 'timeout.mjs')
    fs.writeFileSync(timeoutPath, 'setTimeout(() => {}, 1000)\n')
    await assert.rejects(
      runWorkerProcess(job({ timeoutMs: 20 }), { workerPath: timeoutPath, baseEnv: { PATH: '/bin' } }),
      (error) => error.code === 'PI_WORKER_TIMEOUT'
    )

    const crashPath = path.join(temporary, 'crash.mjs')
    fs.writeFileSync(crashPath, 'process.exit(17)\n')
    await assert.rejects(
      runWorkerProcess(job({ timeoutMs: 200 }), { workerPath: crashPath, baseEnv: { PATH: '/bin' } }),
      (error) => error.code === 'PI_WORKER_EXIT'
    )

    const duplicatePath = path.join(temporary, 'duplicate.mjs')
    const resultText = JSON.stringify(ok(job()))
    fs.writeFileSync(duplicatePath, `process.stdout.write(${JSON.stringify(`${resultText}\n${resultText}\n`)})\n`)
    await assert.rejects(
      runWorkerProcess(job(), { workerPath: duplicatePath, baseEnv: { PATH: '/bin' } }),
      (error) => error.code === 'PI_DUPLICATE_RESULT'
    )
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

test('worker stdin is byte-bounded before JSON parsing and oversized stdout is killed', async () => {
  const workerPath = fileURLToPath(new URL('../src/worker.mjs', import.meta.url))
  const child = spawn(process.execPath, [workerPath], { stdio: ['pipe', 'pipe', 'ignore'] })
  const chunks = []
  child.stdout.on('data', (chunk) => chunks.push(chunk))
  child.stdin.on('error', () => {})
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  child.stdin.end(Buffer.alloc(MAX_PAYLOAD_BYTES + 16 * 1024 + 1, 'x'))
  const exit = await closed
  const stdout = Buffer.concat(chunks).toString('utf8')
  assert.equal(exit.code, 0)
  assert.ok(Buffer.byteLength(stdout, 'utf8') < 4096)
  const result = JSON.parse(stdout)
  assert.equal(result.status, 'error')
  assert.equal(result.error.code, 'PI_INPUT_TOO_LARGE')

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-pi-output-'))
  try {
    const giantPath = path.join(temporary, 'giant.mjs')
    fs.writeFileSync(giantPath, `process.stdout.write("x".repeat(${MAX_OUTPUT_BYTES + 1}))\n`)
    await assert.rejects(
      runWorkerProcess(job({ timeoutMs: 500 }), { workerPath: giantPath, baseEnv: { PATH: '/bin' } }),
      (error) => error.code === 'PI_RESULT_TOO_LARGE'
    )
    await assert.rejects(
      runWorkerProcess(job(), { maxOutputBytes: MAX_OUTPUT_BYTES + 1, baseEnv: { PATH: '/bin' } }),
      (error) => error.code === 'PI_OUTPUT_LIMIT_INVALID'
    )
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

test('worker process receives cancellation and kills the child', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tyche-pi-abort-'))
  try {
    const slowPath = path.join(temporary, 'slow.mjs')
    fs.writeFileSync(slowPath, 'setTimeout(() => {}, 5000)\n')
    const controller = new AbortController()
    const pending = runWorkerProcess(job({ timeoutMs: 1000 }), {
      workerPath: slowPath,
      baseEnv: { PATH: '/bin' },
      signal: controller.signal
    })
    setTimeout(() => controller.abort(), 20)
    await assert.rejects(pending, (error) => error.code === 'PI_WORKER_ABORTED')
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

test('cluster aborts timed-out runners and ignores late results before the next DAG stage', async () => {
  const calls = []
  const events = []
  let aborts = 0
  let lateResults = 0
  const result = await runCluster(clusterOptions({
    timeoutMs: 10,
    onEvent: (event) => events.push(event),
    runJob: async (currentJob, { signal }) => {
      calls.push(currentJob.role)
      signal.addEventListener('abort', () => { aborts += 1 }, { once: true })
      if (currentJob.role === 'orchestrator') {
        await new Promise((resolve) => setTimeout(resolve, 40))
        lateResults += 1
      }
      return ok(currentJob, stageOutput(currentJob))
    }
  }))
  assert.equal(result.status, 'blocked')
  assert.equal(result.blockers[0], 'orchestrator_failed')
  assert.deepEqual(calls, ['orchestrator', 'orchestrator'])
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(aborts, 2)
  assert.equal(lateResults, 2)
  assert.deepEqual(events.map(({ role, status, attempt }) => [role, status, attempt]), [
    ['orchestrator', 'started', 0], ['orchestrator', 'failed', 0],
    ['orchestrator', 'started', 1], ['orchestrator', 'failed', 1]
  ])
})

test('cluster never writes canonical Tyche artifacts', async () => {
  const result = await runCluster(clusterOptions({ runJob: async (currentJob) => ok(currentJob) }))
  assert.equal(result.schema, 'tyche_pi_cluster/v1')
  assert.equal(result.provenance.schema, 'tyche_pi_provenance/v1')
  assert.equal(result.results.every((item) => item.schema === 'tyche_pi_result/v1'), true)
})

test('role-model snapshots select every real job and retries reject results from a different model', async () => {
  const configured = { orchestrator: SESSION_MODEL_IDS[1], 'btc-analyst': SESSION_MODEL_IDS[2], 'eth-analyst': SESSION_MODEL_IDS[3], reviewer: SESSION_MODEL_IDS[4] }
  const expected = { ...configured }
  const seen = []
  const result = await runCluster(clusterOptions({ model: SESSION_MODEL_IDS[0], roleModels: configured, runJob: async (current) => {
    seen.push({ role: current.role, model: current.model, attempt: current.attempt })
    if (current.role === 'orchestrator') configured['btc-analyst'] = 'unsupported-model'
    if (current.role === 'reviewer' && current.attempt === 0) return ok({ ...current, model: SESSION_MODEL_IDS[0] }, stageOutput(current))
    return ok(current, stageOutput(current))
  } }))
  assert.equal(result.status, 'ok')
  for (const current of seen) assert.equal(current.model, expected[current.role] || SESSION_MODEL_IDS[0])
  assert.deepEqual(seen.filter(({ role }) => role === 'reviewer').map(({ attempt }) => attempt), [0, 1])
  assert.equal(result.provenance.default_model, SESSION_MODEL_IDS[0])
  assert.equal(result.provenance.role_models['btc-analyst'], expected['btc-analyst'])
  for (const attempt of result.provenance.attempts) assert.equal(attempt.model, expected[attempt.role] || SESSION_MODEL_IDS[0])
  let called = false
  for (const roleModels of [{ admin: SESSION_MODEL_IDS[0] }, { reviewer: 'unsupported-model' }, []]) await assert.rejects(runCluster(clusterOptions({ roleModels, runJob: async () => { called = true } })), /PI_SESSION_ROLE_MODELS_INVALID/)
  assert.equal(called, false)
})
