#!/usr/bin/env node

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadConfig } from './config.mjs'
import { createGateClient } from './gate-rest.mjs'
import { applyFundingPolicy, fundingProjection, normalizeSpotFunding, normalizeUsdmFunding } from './gate-account-context.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function code(value, fallback = 'FUNDING_UNAVAILABLE') {
  const normalized = String(value || '').toUpperCase().replace(/[^A-Z0-9_]/g, '_').replace(/^_+|_+$/g, '').slice(0, 80)
  return normalized || fallback
}

export function blockedFunding(product, environment, reason, now = Date.now) {
  const at = new Date(typeof now === 'function' ? now() : now).toISOString()
  return {
    schema: 'tyche_funding_projection/v1',
    generated_at: at,
    product: String(product || '').toLowerCase(),
    environment: String(environment || '').toLowerCase(),
    status: 'blocked',
    blocker: { code: code(reason) }
  }
}

export async function acquireFunding(options = {}) {
  const product = String(options.product || '').toLowerCase()
  if (!['spot', 'usdm'].includes(product)) return blockedFunding(product, options.environment, 'FUNDING_PRODUCT_UNSUPPORTED', options.now)
  const config = options.config || loadConfig({ filePath: options.configPath })
  const productConfig = config.gate[product]
  const environment = String(options.environment || productConfig.environment).toLowerCase()
  if (product === 'spot' && environment !== 'dry-run') return blockedFunding(product, environment, 'SPOT_ENVIRONMENT_UNSUPPORTED', options.now)
  if (product === 'spot' && productConfig.account_read_enabled !== true) return blockedFunding(product, environment, 'SPOT_ACCOUNT_READ_DISABLED', options.now)
  if (product === 'usdm' && environment !== 'testnet') return blockedFunding(product, environment, 'USDM_TESTNET_ACCOUNT_REQUIRED', options.now)
  const clientFactory = options.clientFactory || ((clientOptions) => createGateClient(clientOptions))
  try {
    const client = await clientFactory({ product, environment, readOnly: true, fetchImpl: options.fetchImpl, now: options.now })
    const response = product === 'spot'
      ? await client.spotAccounts({ currency: 'USDT' })
      : await client.usdmAccount()
    const normalized = product === 'spot'
      ? normalizeSpotFunding(response.data, { now: options.now })
      : normalizeUsdmFunding(response.data, { now: options.now })
    const policy = {
      risk_capital_fraction_bps: productConfig.risk_capital_fraction_bps,
      balance_buffer_bps: productConfig.balance_buffer_bps
    }
    return { ...fundingProjection(applyFundingPolicy(normalized, policy)), status: 'ok' }
  } catch (error) {
    return blockedFunding(product, environment, error?.code || 'FUNDING_UNAVAILABLE', options.now)
  }
}

export function hasPositiveFunding(projection) {
  return projection?.status === 'ok' && /^(?:0*[1-9]\d*(?:\.\d*)?|0*\.\d*[1-9]\d*)$/.test(String(projection.effective_risk_capital || ''))
}

function parseArgs(argv) {
  const values = argv.slice(2)
  const get = (flag, fallback = null) => {
    const index = values.indexOf(flag)
    if (index < 0) return fallback
    const value = values[index + 1]
    if (!value || value.startsWith('--')) throw Object.assign(new Error(`${flag} requires a value`), { code: 'FUNDING_ARGS_INVALID' })
    return value
  }
  return {
    product: get('--product'),
    environment: get('--environment'),
    configPath: get('--config', path.join(ROOT, 'config', 'tyche.json')),
    requirePositive: values.includes('--require-positive')
  }
}

async function cli(argv) {
  const args = parseArgs(argv)
  const projection = await acquireFunding(args)
  process.stdout.write(`${JSON.stringify(projection, null, 2)}\n`)
  if (args.requirePositive && !hasPositiveFunding(projection)) process.exitCode = 2
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  cli(process.argv).catch((error) => {
    process.stdout.write(`${JSON.stringify({ ok: false, code: error.code || 'FUNDING_ERROR', message: String(error.message || error) }, null, 2)}\n`)
    process.exitCode = 1
  })
}
