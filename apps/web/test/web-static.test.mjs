import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
    /localStorage/i, /sessionStorage/i, /api.?key/i, /provider.?key/i,
    /FileReader/i, /readFile/i, /writeFile/i, /createWriteStream/i,
    /child_process/i, /MCP/i, /DSH/i
  ]) assert.doesNotMatch(source, pattern, String(pattern))
})

test('UI calls only the narrow fixed control-plane routes', () => {
  const source = fs.readFileSync(path.join(SOURCE, 'api.js'), 'utf8')
  for (const route of ['/api/session', '/api/status', '/api/cycle', '/api/dag', '/api/paper', '/api/testnet', '/api/events', '/api/executor/status', '/api/executor/arm', '/api/executor/disarm', '/api/executor/plan', '/api/executor/execute', '/api/executor/reconcile']) assert.match(source, new RegExp(route.replaceAll('/', '\\/')))
  assert.doesNotMatch(source, /socketPath|executorSockets|X-Forwarded|host:/i)
})

test('VenueCard renders the settled safe plan-summary DTO', () => {
  const source = fs.readFileSync(path.join(SOURCE, 'App.jsx'), 'utf8')
  assert.match(source, /summary\.intents/)
  assert.match(source, /intent\.symbol/)
  assert.match(source, /intent\.action/)
  assert.match(source, /intent\.size/)
  assert.match(source, /intent\.notional/)
  assert.match(source, /protection\.stop/)
  assert.match(source, /protection\.target/)
  assert.match(source, /summary\.risk_policy/)
  assert.match(source, /summary\.risk_policy_digest/)
  assert.match(source, /summary\.blockers/)
  assert.match(source, /NO_ACTION/)
  assert.match(source, /armConfirmations/)
  assert.match(source, /armConfirmation === ARM_PHRASES\[venue\]/)
  assert.match(source, /!armReady/)
  assert.match(source, /setArmConfirmations/)
  assert.doesNotMatch(source, /onAction\('arm', venue, ARM_PHRASES\[venue\]\)/)
  assert.doesNotMatch(source, /summary\.(?:symbol|side|size|notional|risk|protection)\b/)
})
