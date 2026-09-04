import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export class StateFileError extends Error {
  constructor(code, message) {
    super(message || code)
    this.name = 'StateFileError'
    this.code = code
  }
}

function missing(error) {
  return error?.code === 'ENOENT' || error?.code === 'ENOTDIR'
}

export function readJsonStrict(filePath, options = {}) {
  let text
  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    if (missing(error) && Object.prototype.hasOwnProperty.call(options, 'missingDefault')) return structuredClone(options.missingDefault)
    throw new StateFileError('STATE_READ_FAILED', `Cannot read state file ${filePath}: ${error?.code || error}`)
  }
  if (text.length === 0 || !text.trim()) throw new StateFileError('STATE_ZERO_LENGTH', `State file ${filePath} is empty`)
  try {
    return JSON.parse(text.replace(/^﻿/, ''))
  } catch (error) {
    throw new StateFileError('STATE_JSON_CORRUPT', `State file ${filePath} is not valid JSON: ${error.message}`)
  }
}

function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function ownerPath(lockPath) {
  return path.join(lockPath, 'owner.json')
}

function acquireLock(targetPath, options = {}) {
  const lockPath = `${targetPath}.lock`
  const waitMs = Number(options.waitMs ?? 15000)
  const staleMs = Number(options.staleMs ?? 60000)
  const intervalMs = Number(options.intervalMs ?? 50)
  if (![waitMs, staleMs, intervalMs].every((value) => Number.isFinite(value) && value > 0)) {
    throw new StateFileError('LOCK_OPTIONS_INVALID', 'Lock timing values must be positive')
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 })
  const deadline = Date.now() + waitMs
  while (Date.now() <= deadline) {
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 })
      const owner = { token: randomUUID(), pid: process.pid, acquired_at: new Date().toISOString() }
      fs.writeFileSync(ownerPath(lockPath), JSON.stringify(owner), { encoding: 'utf8', mode: 0o600 })
      return { lockPath, owner, staleMs }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw new StateFileError('LOCK_CREATE_FAILED', `Cannot acquire lock for ${targetPath}: ${error?.code || error}`)
      try {
        const age = Date.now() - fs.statSync(lockPath).mtimeMs
        if (age > staleMs) {
          fs.rmSync(lockPath, { recursive: true, force: true })
          continue
        }
      } catch (statError) {
        if (!missing(statError)) throw statError
      }
      pause(intervalMs)
    }
  }
  throw new StateFileError('LOCK_TIMEOUT', `Timed out waiting for ${targetPath}`)
}

function startHeartbeat(lock) {
  const timer = setInterval(() => {
    try {
      const now = new Date()
      fs.utimesSync(lock.lockPath, now, now)
    } catch {
      // Ownership is checked again during release. A missing lock cannot be safely recreated here.
    }
  }, Math.max(1000, Math.floor(lock.staleMs / 3)))
  timer.unref?.()
  return timer
}

function releaseLock(lock) {
  let current = null
  try {
    current = JSON.parse(fs.readFileSync(ownerPath(lock.lockPath), 'utf8'))
  } catch {
    current = null
  }
  if (!current || current.token !== lock.owner.token) {
    process.stderr.write(`[iolock] ownership changed; not removing ${lock.lockPath}\n`)
    return
  }
  fs.rmSync(lock.lockPath, { recursive: true, force: true })
}

export function withFileLock(targetPath, callback, options = {}) {
  if (typeof callback !== 'function') throw new StateFileError('LOCK_CALLBACK_INVALID', 'Lock callback must be a function')
  const lock = acquireLock(targetPath, options)
  const heartbeat = startHeartbeat(lock)
  try {
    const result = callback()
    if (result && typeof result.then === 'function') throw new StateFileError('LOCK_ASYNC_CALLBACK', 'Use withFileLockAsync for asynchronous callbacks')
    return result
  } finally {
    clearInterval(heartbeat)
    releaseLock(lock)
  }
}

export async function withFileLockAsync(targetPath, callback, options = {}) {
  if (typeof callback !== 'function') throw new StateFileError('LOCK_CALLBACK_INVALID', 'Lock callback must be a function')
  const lock = acquireLock(targetPath, options)
  const heartbeat = startHeartbeat(lock)
  try {
    return await callback()
  } finally {
    clearInterval(heartbeat)
    releaseLock(lock)
  }
}

function uniqueTemp(targetPath) {
  return `${targetPath}.tmp.${process.pid}.${randomUUID()}`
}

export function writeTextAtomic(targetPath, text, options = {}) {
  const directory = path.dirname(targetPath)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = uniqueTemp(targetPath)
  let descriptor
  try {
    descriptor = fs.openSync(temporary, 'wx', options.mode ?? 0o600)
    fs.writeFileSync(descriptor, String(text), 'utf8')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.renameSync(temporary, targetPath)
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor) } catch {}
    }
    try { fs.unlinkSync(temporary) } catch (error) { if (!missing(error)) throw error }
  }
}

export function writeJsonAtomic(targetPath, value, options = {}) {
  const indent = Number.isInteger(options.indent) ? options.indent : 2
  writeTextAtomic(targetPath, `${JSON.stringify(value, null, indent)}\n`, options)
}

export function updateJsonLocked(targetPath, mutate, options = {}) {
  if (typeof mutate !== 'function') throw new StateFileError('STATE_MUTATOR_INVALID', 'State mutator must be a function')
  return withFileLock(targetPath, () => {
    const current = readJsonStrict(targetPath, { missingDefault: options.missingDefault })
    const next = mutate(current)
    const value = next === undefined ? current : next
    writeJsonAtomic(targetPath, value, options)
    return value
  }, options)
}
