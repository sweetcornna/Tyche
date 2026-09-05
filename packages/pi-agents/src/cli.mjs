#!/usr/bin/env node

import { runCluster } from './cluster.mjs'
import { fixtureWorker } from './fixture.mjs'

function parseArgs(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--fixture') {
      result.fixture = true
      continue
    }
    if (arg === '--help' || arg === '-h') {
      result.help = true
      continue
    }
    if (!arg.startsWith('--')) throw new Error(`PI_UNKNOWN_ARGUMENT:${arg}`)
    const key = arg.slice(2)
    const value = argv[++index]
    if (!value || value.startsWith('--')) throw new Error(`PI_ARGUMENT_VALUE_REQUIRED:${arg}`)
    result[key.replaceAll('-', '')] = value
  }
  return result
}

function usage() {
  return 'tyche-pi-cluster --mode weekly|daily --provider <id> --model <id> --date YYYY-MM-DD --iso-week YYYY-Www [--fixture]'
}

try {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(`${usage()}\n`)
  } else {
    const required = ['mode', 'provider', 'model', 'date', 'isoweek']
    const missing = required.filter((key) => !args[key])
    if (missing.length) throw new Error(`PI_ARGUMENT_REQUIRED:${missing.join(',')}`)
    const cluster = await runCluster({
      tier: args.mode,
      provider: args.provider,
      model: args.model,
      date: args.date,
      isoWeek: args.isoweek,
      evidence: args.fixture
        ? { source: 'fixture', assets: { BTC: { source: 'fixture#btc' }, ETH: { source: 'fixture#eth' } } }
        : { source: 'cli', assets: { BTC: {}, ETH: {} } },
      runId: args.runid,
      timeoutMs: args.timeoutms ? Number(args.timeoutms) : undefined,
      runJob: args.fixture ? fixtureWorker : undefined
    })
    process.stdout.write(`${JSON.stringify(cluster, null, 2)}\n`)
    if (cluster.status !== 'ok') process.exitCode = 1
  }
} catch (error) {
  process.stderr.write(`${error.code || 'PI_CLI_FAILED'}: ${error.message}\n`)
  process.stderr.write(`${usage()}\n`)
  process.exitCode = 1
}
