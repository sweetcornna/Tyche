#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readJsonStrict, writeTextAtomic } from './lib-iolock.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SECRET_KEY = /(?:api.?key|secret|token|password|credential|signature|authorization|cookie|private.?key)/i
const SECRET_TEXT = /(?:Bearer\s+[A-Za-z0-9._~+/=-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:api.?key|secret|token|authorization)\s*[:=]\s*\S+)/i

export class ReportError extends Error {
  constructor(code, message) {
    super(message || code)
    this.name = 'ReportError'
    this.code = code
  }
}

function fail(code, message) {
  throw new ReportError(code, message)
}

function clean(value, limit = 240) {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
  const clipped = [...text].slice(0, limit).join('')
  return clipped.replace(/([\\`*_[\]<>|])/g, '\\$1')
}

function scan(value, location = '$', seen = new Set()) {
  if (typeof value === 'string') {
    if (SECRET_TEXT.test(value)) fail('REPORT_SECRET_FORBIDDEN', `${location} contains secret-shaped text`)
    return
  }
  if (value === null || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) fail('REPORT_SECRET_FORBIDDEN', `${location}.${key} is secret-shaped`)
    scan(child, `${location}.${key}`, seen)
  }
}

function itemLine(value) {
  if (typeof value === 'string') return clean(value)
  if (!value || typeof value !== 'object') return clean(value)
  const label = value.asset || value.symbol || value.code || value.label || ''
  const body = value.summary || value.reason || value.message || value.action || value.text || ''
  return clean([label, body].filter(Boolean).join(' — '))
}

function list(lines, fallback) {
  const usable = (lines || []).filter((item) => item !== null && item !== undefined).slice(0, 8)
  return usable.length ? usable.map((item) => `- ${itemLine(item)}`).join('\n') : `- ${clean(fallback)}`
}

function candidateLine(candidate) {
  const pieces = [candidate.asset, candidate.product, candidate.position_intent]
  if (candidate.entry_price !== null && candidate.entry_price !== undefined) pieces.push(`entry ${candidate.entry_price}`)
  if (candidate.stop_price !== null && candidate.stop_price !== undefined) pieces.push(`stop ${candidate.stop_price}`)
  if (candidate.take_profit_price !== null && candidate.take_profit_price !== undefined) pieces.push(`target ${candidate.take_profit_price}`)
  return clean(pieces.filter(Boolean).join(' · '), 280)
}

function assertNoFalseLifecycle(report) {
  const execution = report.execution || {}
  const events = Array.isArray(execution.events) ? execution.events : []
  const postSubmit = events.filter((event) => {
    const status = String(event?.status || '').toUpperCase()
    return ['SUBMITTED', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED'].includes(status) || (status === 'REJECTED' && event.venue_reached === true)
  })
  if (Number(execution.submitted || 0) === 0 && postSubmit.length) fail('REPORT_LIFECYCLE_CONFLICT', 'Lifecycle events claim submission while submitted=0')
  for (const event of events) {
    const state = String(event?.status || '').toUpperCase()
    if (['PARTIALLY_FILLED', 'FILLED'].includes(state)) {
      if (!event.fill_id || !(Number(event.filled_quantity) > 0) || !(Number(event.average_fill_price) > 0)) {
        fail('REPORT_FILL_PROOF_MISSING', `${state} requires fill identity, quantity, and price`)
      }
    }
  }
}

export function renderConciseReport(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) fail('REPORT_INVALID', 'Report input must be an object')
  scan(report)
  assertNoFalseLifecycle(report)
  const execution = report.execution || {}
  const submitted = Number(execution.submitted || 0)
  const executionSentence = submitted > 0
    ? `${submitted} order intent(s) reached the venue; lifecycle details below are exchange-derived.`
    : 'No order was sent to a trading venue.'
  const planned = (execution.planned_orders || []).slice(0, 8)
  const events = (execution.events || []).slice(0, 10)
  const title = clean(report.title || 'Tyche report', 120)
  const asOf = clean(report.as_of || '', 60)
  const scope = clean(typeof report.scope === 'string' ? report.scope : JSON.stringify(report.scope || {}), 180)

  return `# ${title}\n\nAs of: ${asOf}\n\nScope: ${scope}\n\n## Conclusions\n\n${list(report.conclusions, 'No conclusion was produced.')}\n\n## Execution result\n\n- ${clean(executionSentence)}\n- Mode: ${clean(execution.mode || 'not_executed', 60)}\n- Planned: ${planned.length}; submitted: ${submitted}; filled: ${Number(execution.filled || 0)}; rejected: ${Number(execution.rejected || 0)}; cancelled: ${Number(execution.cancelled || 0)}\n${events.length ? `\n${events.map((event) => `- ${itemLine({ label: event.status, summary: [event.symbol, event.intent_id, event.fill_id].filter(Boolean).join(' · ') })}`).join('\n')}` : ''}\n\n## Plans and recommendations\n\n${planned.length ? planned.map((order) => `- ${candidateLine(order)}`).join('\n') : list(report.recommendations, 'No executable plan was produced.')}\n\n## Blockers and risks\n\n${list([...(report.blockers || []).slice(0, 5), ...(report.risks || []).slice(0, 5)], 'No additional blocker was recorded.')}\n\n## Audit artifacts\n\n${list(report.audit_artifacts, 'No audit path was supplied.')}\n`
}

export function reportFromAnalysis(document, kind) {
  scan(document)
  const candidates = Array.isArray(document.execution_candidates) ? document.execution_candidates : []
  if (kind === 'weekly' && candidates.length !== 0) fail('WEEKLY_EXECUTION_FORBIDDEN', 'Weekly report cannot contain execution candidates')
  const assets = ['BTC', 'ETH'].map((asset) => {
    const row = document.assets?.[asset] || {}
    return `${asset}: ${row.summary || row.analysis_status || row.spot_bias || 'no verified conclusion'}`
  })
  return {
    title: kind === 'weekly' ? `Tyche weekly strategy ${document.iso_week}` : `Tyche daily analysis ${document.date}`,
    as_of: document.generated_at || document.date,
    scope: { assets: ['BTC', 'ETH'], tier: kind },
    conclusions: [document.regime?.summary || document.regime?.label || 'Regime not established', ...assets].slice(0, 3),
    execution: {
      mode: 'signal_only',
      planned_orders: candidates,
      events: [],
      submitted: 0,
      filled: 0,
      rejected: 0,
      cancelled: 0
    },
    recommendations: candidates,
    blockers: document.blockers || [],
    risks: document.risks || ['Crypto and derivatives can produce rapid losses; analysis is not execution truth.'],
    audit_artifacts: [{ label: 'Analysis JSON', path: kind === 'weekly' ? 'data/crypto_strategy.json' : 'data/crypto_daily.json' }]
  }
}

export function reportFromExecution(result) {
  scan(result)
  const events = Array.isArray(result.lifecycle) ? result.lifecycle : []
  return {
    title: `Gate testnet execution ${result.outcome || 'UNKNOWN'}`,
    as_of: result.as_of || new Date().toISOString(),
    scope: { product: result.product || 'usdm', environment: result.environment || 'testnet' },
    conclusions: [result.outcome || 'UNKNOWN', result.message || result.code || 'See lifecycle details'],
    execution: {
      mode: result.environment === 'testnet' ? (result.execution_mode || 'manual_testnet') : 'not_executed',
      planned_orders: result.planned_orders || [],
      events,
      submitted: Number(result.counts?.submitted || 0),
      filled: Number(result.counts?.filled || 0),
      rejected: Number(result.counts?.rejected || 0),
      cancelled: Number(result.counts?.cancelled || 0)
    },
    recommendations: [],
    blockers: result.blockers || [],
    risks: result.sticky_red ? ['Reconciliation is sticky red; stop all later submissions and review local state against testnet.'] : [],
    audit_artifacts: [{ label: 'Plan', path: result.plan_path || '' }, { label: 'Ledger', path: 'data/gate_order_ledger.json' }]
  }
}

function resolveOutput(input) {
  const absolute = path.resolve(path.isAbsolute(input) ? input : path.join(ROOT, input))
  const base = path.join(ROOT, 'outputs')
  const relative = path.relative(base, absolute)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !absolute.endsWith('.md')) {
    fail('REPORT_OUTPUT_INVALID', 'Report output must be a .md file under outputs/')
  }
  return absolute
}

function parseArgs(argv) {
  const values = argv.slice(2)
  const kind = values[0]
  const get = (flag) => {
    const index = values.indexOf(flag)
    if (index < 0 || !values[index + 1] || values[index + 1].startsWith('--')) fail('REPORT_ARGS_INVALID', `${flag} is required`)
    return values[index + 1]
  }
  if (!['weekly', 'daily', 'execution'].includes(kind)) fail('REPORT_ARGS_INVALID', 'First argument must be weekly, daily, or execution')
  return { kind, source: get('--source'), output: get('--out') }
}

function cli(argv) {
  const args = parseArgs(argv)
  const source = path.resolve(path.isAbsolute(args.source) ? args.source : path.join(ROOT, args.source))
  const data = readJsonStrict(source)
  const model = args.kind === 'execution' ? reportFromExecution(data) : reportFromAnalysis(data, args.kind)
  const markdown = renderConciseReport(model)
  const output = resolveOutput(args.output)
  writeTextAtomic(output, markdown)
  process.stdout.write(`${JSON.stringify({ ok: true, report: path.relative(ROOT, output).split(path.sep).join('/') }, null, 2)}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    cli(process.argv)
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, code: error.code || 'REPORT_ERROR', message: String(error.message || error) }, null, 2)}\n`)
    process.exitCode = 1
  }
}
