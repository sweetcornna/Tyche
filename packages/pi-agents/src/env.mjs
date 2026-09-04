const SAFE_BASE_ENV = Object.freeze(['PATH', 'LANG', 'LC_ALL', 'TZ'])

const PROVIDER_ENV_ALLOWLIST = Object.freeze({
  openai: ['OPENAI_API_KEY', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID'],
  anthropic: ['ANTHROPIC_API_KEY'],
  google: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
  'google-vertex': ['GOOGLE_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION'],
  xai: ['XAI_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  groq: ['GROQ_API_KEY'],
  together: ['TOGETHER_API_KEY'],
  fireworks: ['FIREWORKS_API_KEY'],
  cerebras: ['CEREBRAS_API_KEY'],
  nvidia: ['NVIDIA_API_KEY'],
  huggingface: ['HF_TOKEN', 'HUGGINGFACE_API_KEY'],
  minimax: ['MINIMAX_API_KEY'],
  'minimax-cn': ['MINIMAX_API_KEY'],
  moonshotai: ['MOONSHOT_API_KEY'],
  'moonshotai-cn': ['MOONSHOT_API_KEY'],
  qwen: ['DASHSCOPE_API_KEY'],
  'qwen-token-plan': ['DASHSCOPE_API_KEY'],
  'qwen-token-plan-cn': ['DASHSCOPE_API_KEY'],
  'qwen-token-plan-individual': ['DASHSCOPE_API_KEY'],
  zai: ['ZAI_API_KEY'],
  'zai-coding-cn': ['ZAI_API_KEY'],
  cohere: ['COHERE_API_KEY'],
  opencode: ['OPENCODE_API_KEY'],
  'opencode-go': ['OPENCODE_API_KEY'],
  fixture: []
})

const ALWAYS_BLOCKED = /^(?:GATE|BINANCE|BYBIT|OKX|KRAKEN|COINBASE|KUCOIN|MEXC|BITGET|DERIBIT|TRADING|EXCHANGE)(?:_|$)/i

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function providerEnvAllowlist(provider) {
  return Object.freeze([...(PROVIDER_ENV_ALLOWLIST[provider] || [])])
}

export function assertNoTradingCredentials(env) {
  for (const key of Object.keys(env || {})) {
    if (ALWAYS_BLOCKED.test(key)) throw new Error(`PI_CREDENTIAL_ENV_BLOCKED:${key}`)
  }
  return env
}

export function buildWorkerEnv({ provider, baseEnv = process.env, providerEnv = {} } = {}) {
  if (typeof provider !== 'string' || !provider.trim()) throw new Error('PI_PROVIDER_REQUIRED')
  if (!isRecord(baseEnv) || !isRecord(providerEnv)) throw new Error('PI_ENV_OBJECT_REQUIRED')

  const allowed = new Set(PROVIDER_ENV_ALLOWLIST[provider] || [])
  for (const key of Object.keys(providerEnv)) {
    if (ALWAYS_BLOCKED.test(key)) throw new Error(`PI_CREDENTIAL_ENV_BLOCKED:${key}`)
    if (!allowed.has(key)) throw new Error(`PI_PROVIDER_ENV_NOT_ALLOWLISTED:${key}`)
  }

  const env = {}
  for (const key of SAFE_BASE_ENV) {
    if (typeof baseEnv[key] === 'string' && baseEnv[key]) env[key] = baseEnv[key]
  }
  for (const key of allowed) {
    const value = Object.prototype.hasOwnProperty.call(providerEnv, key) ? providerEnv[key] : baseEnv[key]
    if (typeof value === 'string' && value) env[key] = value
  }
  assertNoTradingCredentials(env)
  return env
}

export { PROVIDER_ENV_ALLOWLIST }
