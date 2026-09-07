import { normalizeConnectionEndpoint } from '../../../packages/pi-agents/src/connection-endpoint.mjs'
export { normalizeConnectionEndpoint, inferConnectionProtocol } from '../../../packages/pi-agents/src/connection-endpoint.mjs'

export const PAPER_FIELDS = Object.freeze([
  { key: 'initial_usdt', label: '初始模拟资金', unit: 'USDT', group: '模拟资金' },
  { key: 'configured_leverage', label: '杠杆倍数', unit: '1–3 倍', group: '模拟资金' },
  { key: 'risk_per_trade_bps', label: '每笔风险比例', unit: 'bps', group: '交易限额' },
  { key: 'max_order_notional_usdt', label: '单笔名义金额上限', unit: 'USDT', group: '交易限额' },
  { key: 'daily_new_notional_cap_usdt', label: '每日新增名义金额上限', unit: 'USDT', group: '交易限额' },
  { key: 'max_managed_notional_usdt', label: '总持仓名义金额上限', unit: 'USDT', group: '交易限额' },
  { key: 'daily_loss_bps', label: '每日亏损上限', unit: 'bps', group: '成交与止损约束' },
  { key: 'max_drawdown_bps', label: '最大回撤上限', unit: 'bps', group: '成交与止损约束' },
  { key: 'max_spread_bps', label: '最大买卖价差', unit: 'bps', group: '成交与止损约束' },
  { key: 'max_entry_distance_bps', label: '最大入场偏离', unit: 'bps', group: '成交与止损约束' },
  { key: 'trigger_slippage_bps', label: '止损触发滑点', unit: 'bps', group: '成交与止损约束' }
])

export const CONNECTION_PROTOCOLS = Object.freeze([
  { id: 'openai-responses', label: 'OpenAI Responses', example: 'https://example.com/v1', hint: '可填域名、基础地址或 /responses 完整地址；会自动补全并显示实际地址。' },
  { id: 'openai-completions', label: 'OpenAI Chat Completions', example: 'https://example.com/v1', hint: '可填域名、基础地址或 /chat/completions 完整地址；会自动补全并显示实际地址。' },
  { id: 'anthropic-messages', label: 'Anthropic Messages', example: 'https://example.com', hint: '可填域名、网关前缀或 /v1/messages 完整地址；自动检测目录，只使用本机支持的 Claude 原生 effort。' }
])

export function currentCycleWindow(now = new Date()) {
  const date = now.toISOString().slice(0, 10)
  const thursday = new Date(`${date}T00:00:00.000Z`)
  thursday.setUTCDate(thursday.getUTCDate() + 4 - (thursday.getUTCDay() || 7))
  const year = thursday.getUTCFullYear()
  const week = Math.ceil((((thursday - new Date(Date.UTC(year, 0, 1))) / 86400000) + 1) / 7)
  return { date, isoWeek: `${year}-W${String(week).padStart(2, '0')}` }
}

export function providerRequest(provider, connection) {
  const protocol = connection.protocol ?? CONNECTION_PROTOCOLS[0].id
  if (!CONNECTION_PROTOCOLS.some(({ id }) => id === protocol)) throw new Error('请选择支持的 API 协议。')
  let endpoint
  try { endpoint = normalizeConnectionEndpoint(connection.endpoint.trim(), protocol) } catch { throw new Error('请填写有效的 API 基础地址：域名或 HTTP(S) 地址，不含凭据、查询、编码、点段或其他协议操作路径。') }
  const sameEndpoint = provider.configured && normalizeConnectionEndpoint(provider.endpoint, provider.protocol ?? CONNECTION_PROTOCOLS[0].id) === endpoint && (provider.protocol ?? CONNECTION_PROTOCOLS[0].id) === protocol
  if (!sameEndpoint && !connection.apiKey.trim()) throw new Error(provider.configured ? '更换 API 地址或协议时，请填写与该连接对应的 API key。' : '请填写 API key。')
  if (connection.apiKey && (connection.apiKey !== connection.apiKey.trim() || /[\u0000-\u001f\u007f]/.test(connection.apiKey))) throw new Error('API key 不能包含空白边界或控制字符。')
  if (sameEndpoint && provider.model === connection.model && !connection.apiKey) return null
  return { provider: 'openai-responses-compatible', protocol, model: connection.model, endpoint, ...(connection.apiKey ? { apiKey: connection.apiKey } : {}) }
}

export async function saveConnection(api, csrf, provider, connection) {
  const request = providerRequest(provider, connection)
  return request ? api.configureProvider(request, csrf) : provider
}

export function createWorkflowRunner(api) {
  let running = false
  return async ({ csrf, provider, connection, setup, onPhase, onProvider, onSetup, now = () => new Date() }) => {
    if (running) return null
    running = true
    try {
      if (!setup?.ready) throw new Error(setup?.message || '请先与主 Agent 讨论模拟起点，或委托它配置。')
      providerRequest(provider, connection)
      onPhase('正在连接模型…')
      const saved = await saveConnection(api, csrf, provider, connection)
      onProvider(saved)
      onPhase('正在检查模拟设置…')
      const ready = await api.paperSetup(csrf)
      onSetup(ready)
      if (!ready.ready) throw new Error(ready.message || '模拟设置未完成，请与主 Agent 继续讨论。')
      onPhase('正在运行 workflow…')
      const { date, isoWeek } = currentCycleWindow(now())
      return await api.runCycle({ date, iso_week: isoWeek }, csrf)
    } finally { running = false }
  }
}

export function discoveryRequest(provider, connection) {
  const request = providerRequest(provider, connection) || { provider: 'openai-responses-compatible', protocol: connection.protocol ?? CONNECTION_PROTOCOLS[0].id, endpoint: normalizeConnectionEndpoint(connection.endpoint.trim(), connection.protocol) }
  const { model, ...discovery } = request
  return discovery
}
