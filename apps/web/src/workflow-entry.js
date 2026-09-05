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

export function currentCycleWindow(now = new Date()) {
  const date = now.toISOString().slice(0, 10)
  const thursday = new Date(`${date}T00:00:00.000Z`)
  thursday.setUTCDate(thursday.getUTCDate() + 4 - (thursday.getUTCDay() || 7))
  const year = thursday.getUTCFullYear()
  const week = Math.ceil((((thursday - new Date(Date.UTC(year, 0, 1))) / 86400000) + 1) / 7)
  return { date, isoWeek: `${year}-W${String(week).padStart(2, '0')}` }
}

export function validatePaperDraft(setup, draft) {
  if (!setup || setup.status === 'blocked') throw new Error(setup?.message || '请等待模拟设置检查完成。')
  if (setup.ready) return {}
  const values = { ...setup.values }
  const input = {}
  for (const { key, label, unit } of PAPER_FIELDS) {
    const text = String(values[key] ?? draft[key] ?? '').trim()
    if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text) || text.length > 80 || !Number.isFinite(Number(text)) || Number(text) <= 0) throw new Error(`请填写${label}，使用正十进制数。`)
    if (unit === 'bps' && Number(text) > 10000) throw new Error(`${label}不能超过 10000 bps（100%）。`)
    if (key === 'configured_leverage' && (!Number.isInteger(Number(text)) || Number(text) > 3)) throw new Error('杠杆倍数必须为 1、2 或 3。')
    if (!Object.hasOwn(values, key)) input[key] = text
    values[key] = text
  }
  if (Number(values.max_order_notional_usdt) > Number(values.daily_new_notional_cap_usdt) || Number(values.max_order_notional_usdt) > Number(values.max_managed_notional_usdt)) throw new Error('单笔名义金额不能超过每日新增限额或总持仓限额。')
  return input
}

export function providerRequest(provider, connection) {
  const endpoint = connection.endpoint.trim()
  let url
  try { url = new URL(endpoint) } catch { throw new Error('请填写有效的 API endpoint。') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('API endpoint 须为不含凭据和查询参数的 HTTP(S) 地址。')
  if (!provider.configured && !connection.apiKey.trim()) throw new Error('请填写 API key。')
  if (connection.apiKey && (connection.apiKey !== connection.apiKey.trim() || /[\u0000-\u001f\u007f]/.test(connection.apiKey))) throw new Error('API key 不能包含空白边界或控制字符。')
  if (provider.configured && new URL(provider.endpoint).href === url.href && provider.model === connection.model && !connection.apiKey) return null
  return { provider: 'openai-responses-compatible', model: connection.model, endpoint, ...(connection.apiKey ? { apiKey: connection.apiKey } : {}) }
}

export async function saveConnection(api, csrf, provider, connection) {
  const request = providerRequest(provider, connection)
  return request ? api.configureProvider(request, csrf) : provider
}

export function createWorkflowRunner(api) {
  let running = false
  return async ({ csrf, provider, connection, setup, draft, onPhase, onProvider, onSetup, now = () => new Date() }) => {
    if (running) return null
    running = true
    try {
      const input = validatePaperDraft(setup, draft)
      providerRequest(provider, connection)
      onPhase('正在连接模型…')
      const saved = await saveConnection(api, csrf, provider, connection)
      onProvider(saved)
      onPhase('正在检查模拟设置…')
      const ready = await api.setupPaper(input, csrf)
      onSetup(ready)
      if (!ready.ready) throw new Error(ready.message || '模拟设置未完成，请检查必填参数。')
      onPhase('正在运行 workflow…')
      const { date, isoWeek } = currentCycleWindow(now())
      return await api.runCycle({ date, iso_week: isoWeek }, csrf)
    } finally { running = false }
  }
}
