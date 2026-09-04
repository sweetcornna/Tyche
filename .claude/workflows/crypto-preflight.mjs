export const meta = {
  name: 'crypto-preflight',
  description: 'Validate a caller-produced BTC/ETH public snapshot without credential or mutation access',
  phases: [{ title: 'Configuration', detail: 'Read-only validation review' }, { title: 'Public market snapshot', detail: 'Read-only BTC/ETH evidence check' }]
}

const MUTATION_CREDENTIALS = ['GATE_USDM_TESTNET_API_KEY', 'GATE_USDM_TESTNET_SECRET_KEY']
if (typeof process !== 'object' || !process?.env) throw new Error('WORKFLOW_ENV_UNAVAILABLE')
const inheritedMutationCredentials = MUTATION_CREDENTIALS.filter((name) => String(process.env[name] || '').trim())
if (inheritedMutationCredentials.length) throw new Error(`WORKFLOW_MUTATION_CREDENTIAL_PRESENT:${inheritedMutationCredentials.join(',')}`)

let input = args
if (typeof input === 'string') {
  try { input = JSON.parse(input) } catch { input = {} }
}
input = input || {}
const date = String(input.date || '')
const isoWeek = String(input.isoWeek || '')
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('WORKFLOW_DATE_REQUIRED: date must be YYYY-MM-DD')
if (!/^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/.test(isoWeek)) throw new Error('WORKFLOW_ISOWEEK_REQUIRED: isoWeek must be YYYY-Www')
const configPath = String(input.config || 'config/tyche.json')
if (!/^config\/[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(configPath)) throw new Error('WORKFLOW_CONFIG_PATH_INVALID')

const result = await agent(
  `Read only ${configPath} and data/crypto_market.json. Confirm that the config schema is tyche_config/v1, assets are exactly BTC and ETH, and the market snapshot schema/date/iso_week equal tyche_crypto_market/v1, ${date}, and ${isoWeek}. Confirm both BTC and ETH public blocks exist. Do not run commands, write files, inspect environment variables, read account/plan/ledger data, or call exchange clients. Return the structured result only.`,
  {
    label: 'Tyche read-only preflight',
    phase: 'Public market snapshot',
    agentType: 'crypto-mechanical',
    model: 'sonnet',
    effort: 'low',
    schema: {
      type: 'object',
      required: ['config_ok', 'market_ok', 'snapshot_path'],
      properties: {
        config_ok: { type: 'boolean' },
        market_ok: { type: 'boolean' },
        snapshot_path: { type: 'string', enum: ['data/crypto_market.json'] },
        error: { type: ['string', 'null'] }
      },
      additionalProperties: false
    }
  }
)
if (!result || result.config_ok !== true || result.market_ok !== true) throw new Error(`CRYPTO_PREFLIGHT_FAILED:${result?.error || 'unknown'}`)
return { date, isoWeek, config: configPath, snapshot: result.snapshot_path, credential_boundary: 'mutation_credentials_absent' }
