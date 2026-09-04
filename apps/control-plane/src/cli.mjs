#!/usr/bin/env node

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createControlPlane, LOOPBACK_HOST } from './control-plane.mjs'

const DEFAULT_STATIC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist')
const FLAGS = new Set(['--host', '--port', '--static-root', '--gate-socket', '--binance-socket'])

function parseArgs(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--help' || flag === '-h') {
      if (argv.length !== 1) throw new Error('CONTROL_CLI_UNKNOWN_ARGUMENT')
      return { help: true }
    }
    if (!FLAGS.has(flag)) throw new Error(`CONTROL_CLI_UNKNOWN_ARGUMENT:${flag}`)
    if (Object.hasOwn(values, flag)) throw new Error(`CONTROL_CLI_DUPLICATE_ARGUMENT:${flag}`)
    const value = argv[++index]
    if (!value || value.startsWith('--')) throw new Error(`CONTROL_CLI_ARGUMENT_VALUE_REQUIRED:${flag}`)
    values[flag] = value
  }
  return values
}

function usage() {
  return 'tyche-control-plane [--host 127.0.0.1] [--port 8788] [--static-root ABSOLUTE_DIST] [--gate-socket ABSOLUTE] [--binance-socket ABSOLUTE]'
}

try {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(`${usage()}\n`)
    process.exit(0)
  }
  const service = createControlPlane({
    host: args['--host'] || LOOPBACK_HOST,
    port: Number(args['--port'] || 8788),
    staticRoot: path.resolve(args['--static-root'] || DEFAULT_STATIC_ROOT),
    executorSockets: {
      ...(args['--gate-socket'] ? { gate: args['--gate-socket'] } : {}),
      ...(args['--binance-socket'] ? { binance: args['--binance-socket'] } : {})
    },
    onBootstrapToken: (value) => process.stderr.write(`bootstrap_token=${value}\n`)
  })
  const info = await service.start()
  process.stdout.write(`${JSON.stringify({ ok: true, host: info.host, port: info.port, origin: info.origin })}\n`)
  const stop = async () => {
    await service.stop()
    process.exit(0)
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
} catch (error) {
  process.stderr.write(`${error.code || 'CONTROL_START_FAILED'}: ${error.message}\n`)
  process.stderr.write(`${usage()}\n`)
  process.exitCode = 1
}
