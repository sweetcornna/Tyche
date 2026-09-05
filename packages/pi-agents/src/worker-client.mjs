import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildWorkerEnv } from './env.mjs'
import {
  MAX_PAYLOAD_BYTES,
  assertResultMatchesJob,
  errorCode,
  errorMessage,
  validateJob
} from './protocol.mjs'

export const MAX_OUTPUT_BYTES = MAX_PAYLOAD_BYTES + 16 * 1024
const WORKER_PATH = fileURLToPath(new URL('./worker.mjs', import.meta.url))

export class WorkerProcessError extends Error {
  constructor(code, message) {
    super(message || code)
    this.name = 'WorkerProcessError'
    this.code = code
  }
}

function fail(code, message) {
  throw new WorkerProcessError(code, message)
}

function parseWorkerOutput(stdout, job) {
  const lines = stdout.split('\n').filter((line) => line.trim())
  if (lines.length === 0) fail('PI_RESULT_MISSING', 'worker produced no result')
  if (lines.length !== 1) fail('PI_DUPLICATE_RESULT', 'worker produced more than one result line')
  let result
  try {
    result = JSON.parse(lines[0])
  } catch (error) {
    fail('PI_RESULT_JSON_INVALID', error.message)
  }
  try {
    return assertResultMatchesJob(result, job)
  } catch (error) {
    fail(errorCode(error), errorMessage(error))
  }
}

export function runWorkerProcess(inputJob, options = {}) {
  const job = validateJob(inputJob)
  const timeoutMs = options.timeoutMs ?? job.timeoutMs
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) return Promise.reject(new WorkerProcessError('PI_TIMEOUT_INVALID', 'worker timeout must be a positive integer'))
  if (options.maxOutputBytes !== undefined && (!Number.isInteger(options.maxOutputBytes) || options.maxOutputBytes < 1 || options.maxOutputBytes > MAX_OUTPUT_BYTES)) {
    return Promise.reject(new WorkerProcessError('PI_OUTPUT_LIMIT_INVALID', `worker output limit must be between 1 and ${MAX_OUTPUT_BYTES} bytes`))
  }
  if (options.signal?.aborted) return Promise.reject(new WorkerProcessError('PI_WORKER_ABORTED', 'worker was aborted'))
  const env = buildWorkerEnv({
    provider: job.provider,
    baseEnv: options.env || options.baseEnv || process.env,
    providerEnv: options.providerEnv || {}
  })
  const executable = options.execPath || process.execPath
  const workerPath = options.workerPath || WORKER_PATH
  const cwd = options.cwd || path.dirname(workerPath)
  const maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES
  const signal = options.signal

  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(executable, [workerPath], {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true
      })
    } catch (error) {
      reject(new WorkerProcessError('PI_SPAWN_FAILED', errorMessage(error)))
      return
    }

    let stdout = ''
    let stdoutBytes = 0
    let settled = false
    let timer
    let detachAbort = () => {}
    const settleReject = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      detachAbort()
      reject(error instanceof WorkerProcessError ? error : new WorkerProcessError(errorCode(error), errorMessage(error)))
    }
    const settleResolve = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      detachAbort()
      resolve(result)
    }
    const kill = () => {
      try { child.kill('SIGKILL') } catch {}
    }

    child.on('error', (error) => {
      settleReject(new WorkerProcessError('PI_WORKER_EXIT', errorMessage(error)))
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      const chunkBytes = Buffer.byteLength(chunk, 'utf8')
      if (stdoutBytes + chunkBytes > maxOutputBytes) {
        kill()
        settleReject(new WorkerProcessError('PI_RESULT_TOO_LARGE', 'worker output exceeded the protocol limit'))
        return
      }
      stdoutBytes += chunkBytes
      stdout += chunk
    })
    child.stdin.on('error', (error) => {
      settleReject(new WorkerProcessError('PI_WORKER_WRITE', errorMessage(error)))
    })
    child.on('close', (code, signal) => {
      if (settled) return
      if (code !== 0) {
        settleReject(new WorkerProcessError('PI_WORKER_EXIT', `worker exited with ${signal || `code ${code}`}`))
        return
      }
      try {
        settleResolve(parseWorkerOutput(stdout, job))
      } catch (error) {
        settleReject(error)
      }
    })

    const abort = () => {
      if (settled) return
      kill()
      settleReject(new WorkerProcessError('PI_WORKER_ABORTED', 'worker was aborted'))
    }
    if (signal) {
      signal.addEventListener('abort', abort, { once: true })
      detachAbort = () => signal.removeEventListener('abort', abort)
      if (signal.aborted) abort()
    }

    if (!settled) {
      timer = setTimeout(() => {
        kill()
        settleReject(new WorkerProcessError('PI_WORKER_TIMEOUT', `worker exceeded ${timeoutMs}ms`))
      }, timeoutMs)
    }

    try {
      child.stdin.end(`${JSON.stringify(job)}\n`)
    } catch (error) {
      kill()
      settleReject(new WorkerProcessError('PI_WORKER_WRITE', errorMessage(error)))
    }
  })
}
