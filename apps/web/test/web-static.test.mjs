import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WORKFLOW_NODES, deriveWorkflowState, normalizeWorkflowStatus } from '../src/workflow.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = path.join(ROOT, 'src')

function sourceFiles(directory = SOURCE) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name)
    return entry.isDirectory() ? sourceFiles(file) : [file]
  }).filter((file) => /\.(?:js|jsx|css|html)$/.test(file))
}

test('safe UI source has no dangerous upstream surfaces or browser credential storage', () => {
  const source = sourceFiles().map((file) => fs.readFileSync(file, 'utf8')).join('\n')
  for (const pattern of [
    /node-pty/i, /xterm/i, /terminal/i, /(?:^|[-_/])git(?:$|[-_/])/im, /plugin/i, /self.?update/i,
    /localStorage/i, /sessionStorage/i,
    /FileReader/i, /readFile/i, /writeFile/i, /createWriteStream/i,
    /child_process/i, /MCP/i, /DSH/i
  ]) assert.doesNotMatch(pattern.source === 'plugin' ? source.replaceAll('remarkPlugins=', 'markdownExtensions=') : source, pattern, String(pattern))
})

test('UI calls only the narrow fixed control-plane routes', () => {
  const source = fs.readFileSync(path.join(SOURCE, 'api.js'), 'utf8')
  for (const route of ['/api/session', '/api/provider', '/api/provider/clear', '/api/status', '/api/cycle', '/api/dag', '/api/paper', '/api/testnet', '/api/events', '/api/executor/status', '/api/executor/arm', '/api/executor/disarm', '/api/executor/plan', '/api/executor/execute', '/api/executor/reconcile']) assert.match(source, new RegExp(route.replaceAll('/', '\\/')))
  assert.doesNotMatch(source, /socketPath|executorSockets|X-Forwarded|host:/i)
})

test('session model form is fixed, ephemeral, and has one complete workflow action', () => {
  const app = fs.readFileSync(path.join(SOURCE, 'App.jsx'), 'utf8')
  const api = fs.readFileSync(path.join(SOURCE, 'api.js'), 'utf8')
  const entry = fs.readFileSync(path.join(SOURCE, 'workflow-entry.js'), 'utf8')
  assert.match(entry, /provider: 'openai-responses-compatible'/)
  assert.match(api, /providerStatus: \(csrf\) => get\('\/api\/provider', csrf\)/)
  assert.match(api, /configureProvider:[^\n]+api_key: apiKey/)
  assert.match(api, /clearProvider: \(csrf\) => post\('\/api\/provider\/clear'/)
  assert.match(app, /type="password"[^\n]+autoComplete="new-password"[^\n]+spellCheck="false"/)
  assert.ok((app.match(/updateConnectionDraft\(\{[^\n]*apiKey: ''/g) || []).length >= 3)
  assert.doesNotMatch(app, /finally\s*\{[^\n]*(?:apiKey: ''|setProviderApiKey)/)
  assert.match(app, /operationRef\.current/)
  assert.match(app, /createWorkflowRunner\(controlApi\)/)
  assert.doesNotMatch(app, /周期备注|<label>Provider|<label>日期|<label>ISO 周/)
  for (const field of ['blocked_stage', 'cycle.code', 'cycle.message']) assert.match(app, new RegExp(field.replace('.', '\\.')))
  assert.doesNotMatch(`${app}\n${api}`, /localStorage|sessionStorage|location\.(?:hash|search)|eventsUrl\([^)]*apiKey/i)
})

test('main chat UI has no testnet execution controls', () => {
  const source = fs.readFileSync(path.join(SOURCE, 'App.jsx'), 'utf8')
  assert.doesNotMatch(source, /controlApi\.(?:arm|execute|plan|disarm|reconcile)\(|onAction\(/)
})

test('workflow topology is fixed, ordered, and localized', () => {
  assert.deepEqual(WORKFLOW_NODES.map(({ role }) => role), [
    'orchestrator', 'preflight', 'btc-analyst', 'eth-analyst', 'synthesizer', 'reviewer'
  ])
  assert.deepEqual(WORKFLOW_NODES.map(({ name }) => name), [
    '流程编排', '前置检查', 'BTC 分析', 'ETH 分析', '汇总研判', '最终复核'
  ])
})

test('workflow statuses normalize every supported backend lifecycle value', () => {
  const expected = {
    unknown: 'waiting', waiting: 'waiting', pending: 'pending', queued: 'pending',
    started: 'running', running: 'running', ok: 'complete', completed: 'complete',
    complete: 'complete', reused: 'complete', blocked: 'blocked', failed: 'failed',
    error: 'failed', timeout: 'timeout'
  }
  for (const [input, output] of Object.entries(expected)) assert.equal(normalizeWorkflowStatus(input), output, input)
})

test('workflow derives honest progress and parallel current agents', () => {
  const unknown = deriveWorkflowState({ dag: { daily: Object.fromEntries(WORKFLOW_NODES.map(({ role }) => [role, 'unknown'])) } })
  assert.ok(unknown.nodes.every(({ status }) => status === 'waiting'))
  assert.deepEqual(unknown.currentAgents, [])
  assert.equal(unknown.currentStage, '等待开始')

  const twoOfSix = deriveWorkflowState({ dag: { daily: {
    orchestrator: 'ok', preflight: 'completed', 'btc-analyst': 'unknown', 'eth-analyst': 'waiting', synthesizer: 'queued', reviewer: 'pending'
  } } })
  assert.equal(twoOfSix.completedCount, 2)
  assert.equal(twoOfSix.totalCount, 6)
  assert.equal(twoOfSix.percent, 33)

  const parallel = deriveWorkflowState({
    dag: { daily: { orchestrator: 'ok', preflight: 'ok' } },
    status: { roles: { orchestrator: 'complete', preflight: 'reused' } },
    events: [{ role: 'btc-analyst', status: 'started' }, { role: 'eth-analyst', status: 'running' }]
  })
  assert.equal(parallel.currentStage, '并行分析')
  assert.deepEqual(parallel.currentAgents, ['btc-analyst', 'eth-analyst'])
})

test('polled terminal states override stale WebSocket progress', () => {
  const completeDag = { daily: Object.fromEntries(WORKFLOW_NODES.map(({ role }) => [role, 'complete'])) }
  const completed = deriveWorkflowState({ dag: completeDag, events: { 'btc-analyst': 'running' } })
  assert.equal(completed.byRole['btc-analyst'].status, 'complete')
  assert.equal(completed.completedCount, 6)
  assert.equal(completed.percent, 100)
  assert.deepEqual(completed.currentAgents, [])

  const running = deriveWorkflowState({
    dag: { daily: { orchestrator: 'complete', preflight: 'complete', 'btc-analyst': 'waiting' } },
    events: { 'btc-analyst': 'running' }
  })
  assert.equal(running.byRole['btc-analyst'].status, 'running')
  assert.deepEqual(running.currentAgents, ['btc-analyst'])

  for (const terminal of ['failed', 'blocked', 'timeout']) {
    const state = deriveWorkflowState({
      dag: { daily: { orchestrator: 'complete', preflight: 'complete', 'btc-analyst': terminal } },
      events: { 'btc-analyst': 'running' }
    })
    assert.equal(state.byRole['btc-analyst'].status, terminal)
    assert.doesNotMatch(state.currentAgents.join(','), /btc-analyst/)
  }
})

test('workflow counts completed and reused roles but preserves failure and timeout', () => {
  const completed = deriveWorkflowState({ dag: { daily: {
    orchestrator: 'reused', preflight: 'complete', 'btc-analyst': 'ok', 'eth-analyst': 'completed', synthesizer: 'reused', reviewer: 'complete'
  } } })
  assert.equal(completed.completedCount, 6)
  assert.equal(completed.percent, 100)
  assert.equal(completed.currentStage, '流程完成')

  const failed = deriveWorkflowState({ dag: { daily: { orchestrator: 'error' } } })
  assert.equal(failed.byRole.orchestrator.status, 'failed')
  assert.equal(failed.currentStage, '执行失败')
  const timedOut = deriveWorkflowState({ dag: { daily: { orchestrator: 'timeout' } } })
  assert.equal(timedOut.byRole.orchestrator.status, 'timeout')
  assert.equal(timedOut.currentStage, '执行超时')
})

test('workflow never advances the merge before both analyst dependencies complete', () => {
  const state = deriveWorkflowState({ dag: { daily: {
    orchestrator: 'ok', preflight: 'ok', 'btc-analyst': 'ok', 'eth-analyst': 'running', synthesizer: 'started'
  } } })
  assert.equal(state.byRole.synthesizer.status, 'blocked')
  assert.equal(state.byRole.synthesizer.statusLabel, '状态冲突')
  assert.equal(state.byRole.synthesizer.conflict, true)
  assert.deepEqual(state.byRole.synthesizer.missingDependencies, ['eth-analyst'])
  assert.equal(state.currentStage, '状态冲突')
})

test('localized shell exposes workflow structure without changing safety controls', () => {
  const app = fs.readFileSync(path.join(SOURCE, 'App.jsx'), 'utf8')
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
  for (const text of ['事件日志', '运行', '模拟设置', '独立测试网', '固定工作流']) assert.match(app, new RegExp(text))
  for (const className of ['workflow-dag', 'sequential-stage', 'parallel-branch', 'merge-stage']) assert.match(app, new RegExp(className))
  assert.match(html, /<html lang="zh-CN">/)
  assert.match(html, /<title>Tyche \/ 分析工作台<\/title>/)
})

test('orbital conversation shell and connected workflow remain accessible and responsive', () => {
  const app = fs.readFileSync(path.join(SOURCE, 'App.jsx'), 'utf8')
  const css = fs.readFileSync(path.join(SOURCE, 'styles.css'), 'utf8') + fs.readFileSync(path.join(SOURCE, 'panels.css'), 'utf8')
  const tokens = fs.readFileSync(path.join(SOURCE, 'tokens.css'), 'utf8')
  for (const token of ['--bg', '--surface', '--fg', '--muted', '--border', '--accent']) assert.ok(tokens.includes(token))
  assert.match(css, /@import '.\/tokens.css'/)
  assert.match(css, /\.desktop-shell\s*\{[^}]*color:\s*var\(--fg\)/s)
  assert.match(app, /useState\('night'\)/)
  assert.match(tokens, /\.theme-light\s*\{[^}]*color-scheme: light/s)
  assert.match(app, /<progress[^>]+aria-label="工作流完成进度"[^>]+max=\{workflow\.totalCount\}[^>]+value=\{workflow\.completedCount\}/)
  assert.match(app, /data-status=\{node\.status\}/)
  assert.match(app, /独立测试网/)
  assert.match(app, /当前阶段/)
  assert.match(css, /\.parallel-branch\s*\{[^}]*grid-template-columns:\s*repeat\(2,/s)
  assert.match(css, /\.parallel-branch::before/)
  assert.match(css, /\.merge-stage::before/)
  for (const state of ['running', 'complete', 'failed', 'blocked', 'timeout']) assert.match(css, new RegExp(`data-status="${state}"`))
  assert.match(css, /grid-template-columns: var\(--actual-sidebar\) minmax\(0,1fr\) var\(--actual-detail\)/)
  assert.match(css, /\.desktop-composer/)
  assert.doesNotMatch(css, /Georgia|Songti|#c96442/i)
  assert.match(css, /@media \(max-width: 900px\)/)
  assert.match(css, /@media \(max-width: 680px\)/)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/)
  assert.match(css, /\.scene-dock|\.login-scene/)
  assert.doesNotMatch(css, /workflow-dag[^{}]*\{[^}]*display:\s*none/s)
})

test('polling never overwrites connection drafts and technical controls are collapsed', () => {
  const app = fs.readFileSync(path.join(SOURCE, 'App.jsx'), 'utf8')
  const refresh = app.slice(app.indexOf('const refresh ='), app.indexOf('const openEvents ='))
  assert.doesNotMatch(refresh, /setProviderEndpoint|setProviderModel|setProviderApiKey|setStrategyDraft|setPaperDraft/)
  assert.match(app, /panel === 'details'/)
  assert.match(app, /<DetailPanel open=\{sidePanel\}/)
  assert.match(app, /<details className="advanced"><summary>会话与测试网状态/)
  assert.match(app, /className="run-button" onClick=\{runCycle\}/)
  assert.doesNotMatch(app, /记录当前周期的备注|运行当前周期|保存连接/)
})
