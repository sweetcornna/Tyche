#!/usr/bin/env node

import { runPiAgentJob } from './pi-adapter.mjs'
import {
  errorCode,
  errorMessage,
  makeJob,
  makeResult,
  MAX_PAYLOAD_BYTES,
  validateResult
} from './protocol.mjs'

const FALLBACK_DATE = '1970-01-01'
const FALLBACK_WEEK = '1970-W01'
const MAX_STDIN_BYTES = MAX_PAYLOAD_BYTES + 16 * 1024

async function readInput() {
  process.stdin.setEncoding('utf8')
  let text = ''
  let bytes = 0
  for await (const chunk of process.stdin) {
    bytes += Buffer.byteLength(chunk, 'utf8')
    if (bytes > MAX_STDIN_BYTES) {
      process.stdin.destroy()
      throw new Error(`PI_INPUT_TOO_LARGE:${MAX_STDIN_BYTES}`)
    }
    text += chunk
  }
  const lines = text.split('\n').filter((line) => line.trim())
  if (lines.length !== 1) throw new Error(lines.length > 1 ? 'PI_DUPLICATE_JOB' : 'PI_JOB_MISSING')
  return JSON.parse(lines[0])
}

function fallback(error) {
  const now = new Date().toISOString()
  const job = makeJob({
    jobId: 'invalid-job',
    runId: 'invalid-run',
    role: 'orchestrator',
    asset: null,
    tier: 'daily',
    date: FALLBACK_DATE,
    isoWeek: FALLBACK_WEEK,
    provider: 'invalid',
    model: 'invalid',
    attempt: 0,
    timeoutMs: 1,
    input: {}
  })
  return makeResult(job, {
    status: 'error',
    code: errorCode(error),
    message: errorMessage(error),
    startedAt: now,
    finishedAt: now
  })
}

try {
  const job = await readInput()
  const result = await runPiAgentJob(job)
  process.stdout.write(`${JSON.stringify(validateResult(result))}\n`)
} catch (error) {
  process.stdout.write(`${JSON.stringify(fallback(error))}\n`)
}
