import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { operationDefinitions } from '../scripts/gate-rest.mjs'
import { binanceOperationDefinitions } from '../scripts/binance-rest.mjs'

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
  assert.deepEqual(names.filter((name) => /(^|\/)LICENSE(?:\.|$)/i.test(name)), ['apps/web/LICENSE'])
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
  const sessionProviderModels = new Map([
    ['packages/pi-agents/src/session-provider.mjs', new Set([
      ['gpt', '6', 'astra'].join('-'),
      ['gpt', '5', '6', 'luna'].join('-').replace('-5-6-', '-5.6-'),
      ['gpt', '5', '6', 'sol'].join('-').replace('-5-6-', '-5.6-'),
      ['gpt', '5', '6', 'terra'].join('-').replace('-5-6-', '-5.6-'),
      ['gpt', '5.5'].join('-'),
      ['gpt', '5.4', 'mini'].join('-')
    ])],
    ['packages/pi-agents/test/session-provider.test.mjs', new Set([
      ['gpt', '6', 'astra'].join('-'),
      ['gpt', '5', '6', 'luna'].join('-').replace('-5-6-', '-5.6-'),
      ['gpt', '5', '6', 'sol'].join('-').replace('-5-6-', '-5.6-'),
      ['gpt', '5', '6', 'terra'].join('-').replace('-5-6-', '-5.6-'),
      ['gpt', '5.5'].join('-'),
      ['gpt', '5.4', 'mini'].join('-')
    ])]
  ])
  const ipPattern = /\b(?:\d{1,3}\.){3}\d{1,3}\b/
  const ip = (...octets) => octets.join('.')
  const loopback = ['127', '0', '0', '1'].join('.')
  const wildcard = ['0', '0', '0', '0'].join('.')
  const allowedIpLiterals = new Map([
    ['README.md', new Set([loopback])],
    ['apps/control-plane/src/cli.mjs', new Set([loopback])],
    ['apps/control-plane/src/control-plane.mjs', new Set([loopback])],
    ['apps/control-plane/test/control-plane.test.mjs', new Set([wildcard, loopback])],
    ['apps/web/vite.config.mjs', new Set([loopback])],
    ['packages/pi-agents/src/session-provider.mjs', new Set([
      ip(0, 0, 0, 0), ip(10, 0, 0, 0), ip(100, 64, 0, 0), ip(127, 0, 0, 0), loopback,
      ip(168, 63, 129, 16), ip(169, 254, 0, 0), ip(172, 16, 0, 0), ip(192, 0, 0, 0), ip(192, 0, 2, 0),
      ip(192, 31, 196, 0), ip(192, 52, 193, 0), ip(192, 88, 99, 0), ip(192, 168, 0, 0),
      ip(192, 175, 48, 0), ip(198, 18, 0, 0), ip(198, 51, 100, 0), ip(203, 0, 113, 0),
      ip(224, 0, 0, 0), ip(240, 0, 0, 0)
    ])],
    ['packages/pi-agents/test/session-provider.test.mjs', new Set([
      wildcard, loopback, ip(8, 8, 8, 8), ip(10, 0, 0, 1), ip(10, 0, 0, 2),
      ip(93, 184, 216, 34), ip(100, 64, 0, 1), ip(100, 100, 100, 200),
      ip(168, 63, 129, 16), ip(169, 254, 169, 254), ip(172, 16, 0, 1), ip(192, 0, 2, 1), ip(192, 168, 0, 1),
      ip(192, 168, 1, 2), ip(198, 18, 0, 1), ip(198, 51, 100, 1), ip(203, 0, 113, 1),
      ip(224, 0, 0, 1), ip(255, 255, 255, 255)
    ])]
  ])
  for (const record of records) {
    assert.equal(record.text.includes(homePrefix), false, record.file)
    assert.equal(privateNames.some((name) => record.text.toLowerCase().includes(name)), false, record.file)
    const backendIds = record.text.match(new RegExp(backendPattern.source + '[a-z0-9.-]*', 'ig')) || []
    const allowedBackendIds = sessionProviderModels.get(record.file)
    if (backendIds.length) {
      assert.ok(allowedBackendIds, record.file)
      assert.ok(backendIds.every((id) => allowedBackendIds.has(id.toLowerCase())), record.file)
    }
    if (ipPattern.test(record.text)) {
      const allowed = allowedIpLiterals.get(record.file)
      assert.ok(allowed, record.file)
      assert.ok(record.text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g).every((ip) => allowed.has(ip)), record.file)
    }
  }
})

test('no production USDT-M credential namespace or caller-controlled route exists', () => {
  const forbiddenCredentials = [
    ...['GATE', 'BINANCE'].flatMap((venue) => ['LIVE', 'PROD', 'PRODUCTION'].map((environment) => `${venue}_USDM_${environment}`))
  ]
  for (const record of textFiles()) for (const forbidden of forbiddenCredentials) assert.equal(record.text.includes(forbidden), false, record.file)
  const gateDefinitions = Object.values(operationDefinitions)
  const binanceDefinitions = Object.values(binanceOperationDefinitions)
  assert.ok(gateDefinitions.filter((row) => row.product === 'spot').every((row) => row.method === 'GET' && row.mutation !== true))
  assert.ok(gateDefinitions.filter((row) => row.mutation).every((row) => row.product === 'usdm' && row.environments.join(',') === 'testnet'))
  assert.ok(binanceDefinitions.filter((row) => row.mutation).every((row) => row.environments.join(',') === 'testnet'))
  assert.ok([...gateDefinitions, ...binanceDefinitions].every((row) => !String(row.path).includes(['trans', 'fer'].join(''))))
})

test('runtime dependencies remain explicit and imports stay within their package boundary', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert.equal(manifest.engines.node, '>=22.19.0')
  assert.deepEqual(manifest.dependencies || {}, { ccxt: '4.5.77' })
  assert.deepEqual(manifest.devDependencies || {}, {})
  for (const record of textFiles().filter(({ file }) => file.endsWith('.mjs'))) {
    for (const match of record.text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const externalAllowed = record.file === 'scripts/multi-exchange-market.mjs' && match[1] === 'ccxt'
      const piAllowed = record.file.startsWith('packages/pi-agents/') && [
        '@earendil-works/pi-agent-core',
        '@earendil-works/pi-ai',
        '@earendil-works/pi-ai/api/openai-responses.lazy',
        '@earendil-works/pi-ai/providers/all',
        '@earendil-works/pi-ai/providers/faux'
      ].includes(match[1])
      const controlAllowed = record.file.startsWith('apps/control-plane/') && match[1] === 'ws'
      const webAllowed = record.file.startsWith('apps/web/') && ['react', 'react-dom/client', 'vite', '@vitejs/plugin-react'].includes(match[1])
      assert.ok(externalAllowed || piAllowed || controlAllowed || webAllowed || match[1].startsWith('node:') || match[1].startsWith('./') || match[1].startsWith('../'), `${record.file}: ${match[1]}`)
    }
  }
})

test('multi-exchange adapter exposes public reads without credentials or mutation methods', () => {
  const source = fs.readFileSync(path.join(ROOT, 'scripts', 'multi-exchange-market.mjs'), 'utf8')
  assert.match(source, /loadMarkets/)
  for (const method of ['fetchTicker', 'fetchOrderBook', 'fetchOHLCV', 'fetchTrades', 'fetchFundingRate', 'fetchFundingRateHistory', 'fetchOpenInterest', 'fetchLiquidations']) assert.match(source, new RegExp(method))
  assert.doesNotMatch(source, /createOrder|editOrder|cancelOrder|fetchBalance|fetchPositions|withdraw|deposit|transfer|apiKey|secret|password|privateKey/)
  assert.doesNotMatch(source, /baseURL|hostname|endpoint|headers\s*:/)
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

test('one-shot automation exposes planning but no order-submission route', () => {
  const source = fs.readFileSync(path.join(ROOT, 'scripts', 'crypto-automation.mjs'), 'utf8')
  const paper = fs.readFileSync(path.join(ROOT, 'scripts', 'paper-trade.mjs'), 'utf8')
  assert.match(source, /'plan'/)
  assert.doesNotMatch(source, /['"]execute['"]|--commit|EXECUTE GATE|usdmPlaceOrder|usdmPlacePriceOrder/)
  assert.doesNotMatch(paper, /['"]testnet['"]|api-testnet|--commit|EXECUTE GATE|usdmPlaceOrder|usdmPlacePriceOrder|usdmCancelOrder|usdmCancelPriceOrder/)
  assert.doesNotMatch(paper, /GATE_USDM_TESTNET_(?:API|SECRET)_KEY/)
  assert.match(paper, /environment: 'public'/)
  assert.match(paper, /submitted: 0, filled: 0/)
})

test('automatic order module is isolated, venue-explicit, and contains no production mutation mode', () => {
  const source = fs.readFileSync(path.join(ROOT, 'scripts', 'testnet-trade.mjs'), 'utf8')
  assert.match(source, /automatic_testnet/)
  assert.match(source, /venueName/)
  assert.match(source, /PRODUCTION_EXECUTION_UNSUPPORTED/)
  assert.doesNotMatch(source, /environment:\s*['"](?:live|prod|production)['"]/i)
  assert.doesNotMatch(source, /withdraw|deposit|transfer|cancelAll/i)
})
