import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { operationDefinitions } from '../scripts/gate-rest.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SKIP = new Set(['.git', 'node_modules', 'data', 'outputs', 'logs', 'plans', '.cache', 'coverage'])

function files(directory = ROOT) {
  const output = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) output.push(...files(absolute))
    else output.push(absolute)
  }
  return output
}

function relative(file) {
  return path.relative(ROOT, file).split(path.sep).join('/')
}

function textFiles() {
  return files().filter((file) => !file.endsWith('package-lock.json')).map((file) => ({ file: relative(file), text: fs.readFileSync(file, 'utf8') }))
}

test('bootstrap contains no excluded platform or generated-source surfaces', () => {
  const names = files().map(relative)
  assert.ok(!names.some((name) => name.startsWith('.github/')))
  assert.ok(!names.some((name) => /(^|\/)LICENSE(?:\.|$)/i.test(name)))
  assert.ok(!names.some((name) => name.endsWith('.py')))
  assert.ok(!names.some((name) => /\.(?:zip|tar|gz|sqlite|db)$/i.test(name)))
  const excludedNames = [
    ['board', 'data'].join('_'),
    ['holdings', 'master'].join('_'),
    ['seren', 'ity'].join(''),
    ['x', 'stocks'].join(''),
    ['sched', 'uler'].join('-'),
    ['deploy', 'ment'].join('-')
  ]
  assert.deepEqual(names.filter((name) => excludedNames.some((fragment) => name.toLowerCase().includes(fragment))), [])
})

test('source text has no private path, private infrastructure name, backend model ID, or hard-coded IP', () => {
  const records = textFiles()
  const homePrefix = ['/', 'Users', '/'].join('')
  const privateNames = [
    ['fin', 'harness'].join('-'),
    ['open', 'claude', 'code'].join('-'),
    ['cord', 'is'].join(''),
    ['sub', '2', 'api'].join('')
  ]
  const backendPattern = new RegExp(['g', 'p', 't', '-'].join('') + '\\d', 'i')
  const ipPattern = /\b(?:\d{1,3}\.){3}\d{1,3}\b/
  for (const record of records) {
    assert.equal(record.text.includes(homePrefix), false, record.file)
    assert.equal(privateNames.some((name) => record.text.toLowerCase().includes(name)), false, record.file)
    assert.equal(backendPattern.test(record.text), false, record.file)
    assert.equal(ipPattern.test(record.text), false, record.file)
  }
})

test('no production USDT-M credential namespace or caller-controlled route exists', () => {
  const forbiddenCredential = ['GATE', 'USDM', 'LIVE'].join('_')
  for (const record of textFiles()) assert.equal(record.text.includes(forbiddenCredential), false, record.file)
  const definitions = Object.values(operationDefinitions)
  assert.ok(definitions.filter((row) => row.product === 'spot').every((row) => row.method === 'GET' && row.mutation !== true))
  assert.ok(definitions.filter((row) => row.mutation).every((row) => row.product === 'usdm' && row.environments.join(',') === 'testnet'))
  assert.ok(definitions.every((row) => !String(row.path).includes(['trans', 'fer'].join(''))))
})

test('package has no runtime dependency and imports only built-ins or local files', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert.equal(manifest.engines.node, '>=20')
  assert.deepEqual(manifest.dependencies || {}, {})
  assert.deepEqual(manifest.devDependencies || {}, {})
  for (const record of textFiles().filter(({ file }) => file.endsWith('.mjs'))) {
    for (const match of record.text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      assert.ok(match[1].startsWith('node:') || match[1].startsWith('./') || match[1].startsWith('../'), `${record.file}: ${match[1]}`)
    }
  }
})

test('workflows guard credentials before agents, pin models, and expose no mutation surface', () => {
  const workflowFiles = files(path.join(ROOT, '.claude', 'workflows')).filter((file) => file.endsWith('.mjs'))
  assert.equal(workflowFiles.length, 2)
  for (const file of workflowFiles) {
    const source = fs.readFileSync(file, 'utf8')
    assert.match(source, /input\.date/)
    assert.match(source, /input\.isoWeek/)
    const firstAgent = source.indexOf('agent(')
    const credentialGuard = source.indexOf('WORKFLOW_MUTATION_CREDENTIAL_PRESENT')
    assert.ok(credentialGuard >= 0 && credentialGuard < firstAgent, relative(file))
    assert.doesNotMatch(source, /gate-(?:trade|rest)\.mjs|agent-write\.mjs|child_process/)
    assert.doesNotMatch(source, /--commit|EXECUTE GATE TESTNET|usdmPlaceOrder|usdmPlacePriceOrder/)
    assert.doesNotMatch(source, /\/Users\//)
    const calls = [...source.matchAll(/agent\s*\(/g)].length
    const pins = [...source.matchAll(/model:\s*['"](?:sonnet|opus)['"]/g)].length
    assert.equal(pins, calls, relative(file))
  }
})

test('custom workflow agents have no Bash or Write tool capability', () => {
  const agentFiles = files(path.join(ROOT, '.claude', 'agents')).filter((file) => file.endsWith('.md'))
  assert.ok(agentFiles.length > 0)
  for (const file of agentFiles) {
    const source = fs.readFileSync(file, 'utf8')
    const tools = source.match(/^tools:\s*(.+)$/m)?.[1] || ''
    assert.ok(tools, relative(file))
    assert.doesNotMatch(tools, /(?:^|,\s*)(?:Bash|Write)(?:,|$)/)
  }
})

test('examples contain no market values, account identities, balances, secret values, or strategy actions', () => {
  const examples = files(path.join(ROOT, 'examples')).filter((file) => file.endsWith('.json'))
  for (const file of examples) {
    const document = JSON.parse(fs.readFileSync(file, 'utf8'))
    const serialized = JSON.stringify(document)
    assert.doesNotMatch(serialized, /"(?:price|entry_price|stop_price|take_profit_price|balance|available|account_id)"/i)
    assert.doesNotMatch(serialized, /"(?:ENTER|EXIT|REDUCE)_[A-Z]+"/)
    assert.doesNotMatch(serialized, /"(?:long|short)"/i)
    assert.doesNotMatch(serialized, /-----BEGIN|Bearer\s|sk-[A-Za-z0-9]/)
  }
})

test('example environment file contains only read-only credential names and no values', () => {
  const lines = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8').split(/\r?\n/).filter((line) => line && !line.startsWith('#'))
  assert.deepEqual(lines, ['GATE_SPOT_READONLY_API_KEY=', 'GATE_SPOT_READONLY_SECRET_KEY='])
  assert.ok(lines.every((line) => /^[A-Z0-9_]+=$/.test(line)))
})

test('source has no finance execution variable or runtime scheduler-marker coupling', () => {
  const financePrefix = ['F', 'I', 'N', '_'].join('')
  const schedulerMarker = ['.', 'scheduler', '_'].join('')
  for (const record of textFiles()) {
    assert.equal(record.text.includes(financePrefix), false, record.file)
    assert.equal(record.text.includes(schedulerMarker), false, record.file)
  }
})
