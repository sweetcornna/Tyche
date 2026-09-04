#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { withFileLock, writeJsonAtomic, writeTextAtomic } from './lib-iolock.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const INBOX = path.join(ROOT, 'data', '_inbox')
const SLOT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:json|md)$/
const WEEKLY_SCHEMA = 'tyche_weekly_strategy/v1'
const DAILY_SCHEMA = 'tyche_crypto_daily/v1'
const CANDIDATE_SCHEMA = 'crypto_execution_candidate/v1'
const FINAL_KEYS = new Set([
  'schema', 'date', 'iso_week', 'generated_at', 'status', 'anchored_week', 'anchor_fresh',
  'regime', 'assets', 'execution_candidates', 'blockers', 'risks'
])
const ASSET_KEYS = new Set(['asset', 'symbol', 'summary', 'spot_bias', 'usdm_bias', 'invalidation', 'anchor_week', 'anchor_fresh', 'evidence_refs', 'execution_candidates', 'risks'])
const CANDIDATE_KEYS = new Set(['schema', 'asset', 'product', 'symbol', 'position_intent', 'order_style', 'entry_price', 'stop_price', 'take_profit_price', 'reduce_fraction_bps', 'data_as_of', 'anchor_week', 'anchor_fresh', 'thesis_invalidation', 'evidence_refs', 'signal_id'])

export class AgentWriteError extends Error {
  constructor(code, message) {
    super(message || code)
    this.name = 'AgentWriteError'
    this.code = code
  }
}

function reject(code, message) {
  throw new AgentWriteError(code, message)
}

function within(base, candidate) {
  const relative = path.relative(base, candidate)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

export function resolveInboxPath(input) {
  const raw = String(input || '').trim()
  if (!raw) reject('AGENT_WRITE_INBOX_INVALID', 'Inbox path is required')
  const absolute = path.resolve(path.isAbsolute(raw) ? raw : path.join(ROOT, raw))
  if (path.dirname(absolute) !== INBOX || !SLOT_NAME.test(path.basename(absolute))) {
    reject('AGENT_WRITE_INBOX_INVALID', 'Inbox files must be flat .json or .md files directly under data/_inbox')
  }
  return absolute
}

export function resolveOutputPath(input) {
  const raw = String(input || '').trim()
  if (!raw) reject('AGENT_WRITE_OUTPUT_INVALID', 'Output path is required')
  const absolute = path.resolve(path.isAbsolute(raw) ? raw : path.join(ROOT, raw))
  const dataRoot = path.join(ROOT, 'data')
  const outputRoot = path.join(ROOT, 'outputs')
  if (!within(dataRoot, absolute) && !within(outputRoot, absolute)) {
    reject('AGENT_WRITE_OUTPUT_INVALID', 'Canonical agent output must remain under data/ or outputs/')
  }
  if (!/\.(?:json|md)$/.test(absolute)) reject('AGENT_WRITE_OUTPUT_INVALID', 'Output must use .json or .md')
  return absolute
}

export function resetInbox(input) {
  const target = resolveInboxPath(input)
  fs.mkdirSync(INBOX, { recursive: true, mode: 0o700 })
  let removed = false
  try {
    fs.unlinkSync(target)
    removed = true
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  return { ok: true, inbox: path.relative(ROOT, target).split(path.sep).join('/'), removed }
}

export function validateAgentPayload(text, options = {}) {
  const raw = String(text ?? '')
  if (!raw.trim()) reject('AGENT_WRITE_EMPTY', 'Agent output is empty')
  const bytes = Buffer.byteLength(raw, 'utf8')
  if (options.minBytes && bytes < Number(options.minBytes)) reject('AGENT_WRITE_TOO_SHORT', `Agent output has ${bytes} bytes; expected at least ${options.minBytes}`)
  if (options.mode === 'text') return { mode: 'text', value: raw, bytes }

  let value
  try {
    value = JSON.parse(raw.replace(/^﻿/, ''))
  } catch (error) {
    reject('AGENT_WRITE_JSON_INVALID', error.message)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject('AGENT_WRITE_JSON_INVALID', 'Top-level JSON must be an object')
  const required = options.requireKeys || []
  const missing = required.filter((key) => !Object.prototype.hasOwnProperty.call(value, key))
  if (missing.length) reject('AGENT_WRITE_KEYS_MISSING', `Missing keys: ${missing.join(', ')}`)
  if (options.arrayKey) {
    const rows = value[options.arrayKey]
    if (!Array.isArray(rows)) reject('AGENT_WRITE_ARRAY_INVALID', `${options.arrayKey} must be an array`)
    if (options.expectCount !== null && options.expectCount !== undefined && rows.length !== Number(options.expectCount)) {
      reject('AGENT_WRITE_COUNT_MISMATCH', `${options.arrayKey} has ${rows.length} rows; expected ${options.expectCount}`)
    }
  }
  if (options.week) {
    const actual = value[options.weekKey || 'iso_week']
    if (actual !== options.week) reject('AGENT_WRITE_WEEK_MISMATCH', `Expected ${options.week}; got ${actual ?? '(missing)'}`)
  }
  if (options.date && value[options.dateKey || 'date'] !== options.date) reject('AGENT_WRITE_DATE_MISMATCH', `Expected ${options.date}`)
  return { mode: 'json', value, bytes }
}

function canonicalReject(message) {
  reject('AGENT_WRITE_CANONICAL_INVALID', message)
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function exactCanonicalKeys(value, required, allowed, label) {
  if (!isObject(value)) canonicalReject(`${label} must be an object`)
  const missing = required.filter((key) => !Object.prototype.hasOwnProperty.call(value, key))
  const extra = Object.keys(value).filter((key) => !allowed.has(key))
  if (missing.length) canonicalReject(`${label} is missing: ${missing.join(', ')}`)
  if (extra.length) canonicalReject(`${label} contains unsupported keys: ${extra.join(', ')}`)
}

function canonicalString(value, label) {
  if (typeof value !== 'string') canonicalReject(`${label} must be a string`)
}

function canonicalBoolean(value, label) {
  if (typeof value !== 'boolean') canonicalReject(`${label} must be boolean`)
}

function canonicalStringArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) canonicalReject(`${label} must be an array of strings`)
}

function canonicalObjectArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => !isObject(item))) canonicalReject(`${label} must be an array of objects`)
}

function canonicalNullableNumber(value, label) {
  if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) canonicalReject(`${label} must be a finite number or null`)
}

function canonicalNullableInteger(value, label) {
  if (value !== null && (typeof value !== 'number' || !Number.isInteger(value))) canonicalReject(`${label} must be an integer or null`)
}

function canonicalDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function canonicalWeek(value) {
  return /^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/.test(String(value || ''))
}

function validateCanonicalCandidate(candidate, label, expectedAsset = null) {
  exactCanonicalKeys(candidate, [...CANDIDATE_KEYS], CANDIDATE_KEYS, label)
  if (candidate.schema !== CANDIDATE_SCHEMA) canonicalReject(`${label}.schema is invalid`)
  if (!['BTC', 'ETH'].includes(candidate.asset)) canonicalReject(`${label}.asset is invalid`)
  if (!['spot', 'usdm'].includes(candidate.product)) canonicalReject(`${label}.product is invalid`)
  if (!['BTC_USDT', 'ETH_USDT'].includes(candidate.symbol)) canonicalReject(`${label}.symbol is invalid`)
  if (candidate.symbol !== `${candidate.asset}_USDT`) canonicalReject(`${label}.symbol does not match asset`)
  if (expectedAsset !== null && candidate.asset !== expectedAsset) canonicalReject(`${label}.asset does not match containing asset`)
  if (expectedAsset !== null && candidate.symbol !== `${expectedAsset}_USDT`) canonicalReject(`${label}.symbol does not match containing asset`)
  if (!['ENTER_LONG', 'ENTER_SHORT', 'REDUCE_LONG', 'REDUCE_SHORT', 'EXIT_LONG', 'EXIT_SHORT', 'NO_TRADE'].includes(candidate.position_intent)) canonicalReject(`${label}.position_intent is invalid`)
  if (candidate.order_style !== 'LIMIT') canonicalReject(`${label}.order_style is invalid`)
  canonicalNullableNumber(candidate.entry_price, `${label}.entry_price`)
  canonicalNullableNumber(candidate.stop_price, `${label}.stop_price`)
  canonicalNullableNumber(candidate.take_profit_price, `${label}.take_profit_price`)
  canonicalNullableInteger(candidate.reduce_fraction_bps, `${label}.reduce_fraction_bps`)
  canonicalString(candidate.data_as_of, `${label}.data_as_of`)
  canonicalString(candidate.anchor_week, `${label}.anchor_week`)
  canonicalBoolean(candidate.anchor_fresh, `${label}.anchor_fresh`)
  canonicalString(candidate.thesis_invalidation, `${label}.thesis_invalidation`)
  canonicalStringArray(candidate.evidence_refs, `${label}.evidence_refs`)
  canonicalString(candidate.signal_id, `${label}.signal_id`)
}

function validateCanonicalAsset(assetResult, asset, tier, label) {
  exactCanonicalKeys(assetResult, [...ASSET_KEYS], ASSET_KEYS, label)
  if (!['BTC', 'ETH'].includes(assetResult.asset) || assetResult.asset !== asset) canonicalReject(`${label}.asset is invalid`)
  if (assetResult.symbol !== `${asset}_USDT`) canonicalReject(`${label}.symbol does not match containing asset`)
  canonicalString(assetResult.summary, `${label}.summary`)
  if (!['long', 'neutral', 'reduce'].includes(assetResult.spot_bias)) canonicalReject(`${label}.spot_bias is invalid`)
  if (!['long', 'short', 'neutral', 'reduce'].includes(assetResult.usdm_bias)) canonicalReject(`${label}.usdm_bias is invalid`)
  canonicalNullableNumber(assetResult.invalidation, `${label}.invalidation`)
  canonicalString(assetResult.anchor_week, `${label}.anchor_week`)
  canonicalBoolean(assetResult.anchor_fresh, `${label}.anchor_fresh`)
  canonicalStringArray(assetResult.evidence_refs, `${label}.evidence_refs`)
  if (!Array.isArray(assetResult.execution_candidates) || assetResult.execution_candidates.length > (tier === 'weekly' ? 0 : 2)) canonicalReject(`${label}.execution_candidates exceeds its limit`)
  assetResult.execution_candidates.forEach((candidate, index) => validateCanonicalCandidate(candidate, `${label}.execution_candidates[${index}]`, asset))
  canonicalStringArray(assetResult.risks, `${label}.risks`)
}

function canonicalCandidateFingerprint(candidate) {
  return JSON.stringify([...CANDIDATE_KEYS].map((key) => candidate[key]))
}

function validateFlattenedCandidates(document) {
  const expected = [
    ...document.assets.BTC.execution_candidates,
    ...document.assets.ETH.execution_candidates
  ]
  if (document.execution_candidates.length !== expected.length) canonicalReject('document.execution_candidates does not exactly flatten BTC then ETH candidates')
  expected.forEach((candidate, index) => {
    if (canonicalCandidateFingerprint(document.execution_candidates[index]) !== canonicalCandidateFingerprint(candidate)) {
      canonicalReject(`document.execution_candidates does not match flattened candidate at index ${index}`)
    }
  })
}

export function validateCanonicalDocument(document, tier) {
  if (!['weekly', 'daily'].includes(tier)) canonicalReject('tier must be weekly or daily')
  const required = tier === 'weekly'
    ? ['schema', 'date', 'iso_week', 'generated_at', 'status', 'regime', 'assets', 'execution_candidates', 'blockers', 'risks']
    : ['schema', 'date', 'iso_week', 'generated_at', 'anchored_week', 'anchor_fresh', 'regime', 'assets', 'execution_candidates', 'blockers', 'risks']
  exactCanonicalKeys(document, required, FINAL_KEYS, 'canonical document')
  if (document.schema !== (tier === 'weekly' ? WEEKLY_SCHEMA : DAILY_SCHEMA)) canonicalReject('canonical document schema is invalid')
  if (!canonicalDate(document.date)) canonicalReject('canonical document date is invalid')
  if (!canonicalWeek(document.iso_week)) canonicalReject('canonical document iso_week is invalid')
  canonicalString(document.generated_at, 'canonical document generated_at')
  if (tier === 'weekly' && document.status !== 'active') canonicalReject('weekly status must be active')
  if (document.status !== undefined && document.status !== 'active') canonicalReject('status must be active')
  if (document.anchored_week !== undefined && document.anchored_week !== null) canonicalString(document.anchored_week, 'anchored_week')
  if (document.anchor_fresh !== undefined) canonicalBoolean(document.anchor_fresh, 'anchor_fresh')
  if (tier === 'daily') {
    if (document.anchored_week !== null && typeof document.anchored_week !== 'string') canonicalReject('daily anchored_week must be a string or null')
    canonicalBoolean(document.anchor_fresh, 'daily anchor_fresh')
  }
  if (!isObject(document.regime)) canonicalReject('regime must be an object')
  exactCanonicalKeys(document.assets, ['BTC', 'ETH'], new Set(['BTC', 'ETH']), 'assets')
  validateCanonicalAsset(document.assets.BTC, 'BTC', tier, 'assets.BTC')
  validateCanonicalAsset(document.assets.ETH, 'ETH', tier, 'assets.ETH')
  if (!Array.isArray(document.execution_candidates) || document.execution_candidates.length > (tier === 'weekly' ? 0 : 4)) canonicalReject('document.execution_candidates exceeds its limit')
  document.execution_candidates.forEach((candidate, index) => validateCanonicalCandidate(candidate, `document.execution_candidates[${index}]`))
  validateFlattenedCandidates(document)
  canonicalObjectArray(document.blockers, 'blockers')
  canonicalStringArray(document.risks, 'risks')
  return document
}

function canonicalTierForOutput(output) {
  const relative = path.relative(ROOT, output).split(path.sep).join('/')
  if (relative === 'data/crypto_strategy.json') return 'weekly'
  if (relative === 'data/crypto_daily.json') return 'daily'
  return null
}

export function commitInbox(inboxPath, outputPath, options = {}) {
  const inbox = resolveInboxPath(inboxPath)
  const output = resolveOutputPath(outputPath)
  let raw
  try {
    raw = fs.readFileSync(inbox, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') reject('AGENT_WRITE_INBOX_MISSING', 'Agent did not write the expected inbox file')
    throw error
  }
  const validated = validateAgentPayload(raw, options)
  const canonicalTier = canonicalTierForOutput(output)
  if (canonicalTier) {
    if (validated.mode !== 'json') canonicalReject('canonical strategy and daily outputs require JSON mode')
    validateCanonicalDocument(validated.value, canonicalTier)
  }
  withFileLock(output, () => {
    if (validated.mode === 'json') writeJsonAtomic(output, validated.value)
    else writeTextAtomic(output, validated.value)
  })
  fs.unlinkSync(inbox)
  return {
    ok: true,
    inbox: path.relative(ROOT, inbox).split(path.sep).join('/'),
    output: path.relative(ROOT, output).split(path.sep).join('/'),
    mode: validated.mode,
    bytes: validated.bytes
  }
}

function parseArgs(argv) {
  const values = argv.slice(2)
  const get = (flag, fallback = null) => {
    const index = values.indexOf(flag)
    if (index < 0) return fallback
    const value = values[index + 1]
    if (!value || value.startsWith('--')) reject('AGENT_WRITE_ARGS_INVALID', `${flag} requires a value`)
    return value
  }
  return {
    reset: get('--inbox-reset'),
    inbox: get('--inbox'),
    output: get('--out'),
    mode: values.includes('--text') ? 'text' : 'json',
    requireKeys: String(get('--require-keys', '')).split(',').map((value) => value.trim()).filter(Boolean),
    arrayKey: get('--array'),
    expectCount: get('--expect-count'),
    week: get('--require-week'),
    weekKey: get('--week-key', 'iso_week'),
    date: get('--require-date'),
    dateKey: get('--date-key', 'date'),
    minBytes: Number(get('--min-bytes', '0'))
  }
}

function cli(argv) {
  const options = parseArgs(argv)
  const result = options.reset
    ? resetInbox(options.reset)
    : commitInbox(options.inbox, options.output, options)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    cli(process.argv)
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, code: error.code || 'AGENT_WRITE_ERROR', message: String(error.message || error) }, null, 2)}\n`)
    process.exitCode = 1
  }
}
