export const WORKFLOW_NODES = Object.freeze([
  Object.freeze({ role: 'orchestrator', name: '流程编排' }),
  Object.freeze({ role: 'preflight', name: '前置检查' }),
  Object.freeze({ role: 'btc-analyst', name: 'BTC 分析' }),
  Object.freeze({ role: 'eth-analyst', name: 'ETH 分析' }),
  Object.freeze({ role: 'synthesizer', name: '汇总研判' }),
  Object.freeze({ role: 'reviewer', name: '最终复核' })
])

const ROLE_SET = new Set(WORKFLOW_NODES.map(({ role }) => role))
const COMPLETE = new Set(['ok', 'completed', 'complete', 'reused'])
const FINAL_STATES = new Set(['complete', 'blocked', 'failed', 'timeout'])
const STATUS_RANK = Object.freeze({ waiting: 0, pending: 1, running: 2, complete: 3, blocked: 3, failed: 3, timeout: 3 })
const DEPENDENCIES = Object.freeze({
  orchestrator: [],
  preflight: ['orchestrator'],
  'btc-analyst': ['preflight'],
  'eth-analyst': ['preflight'],
  synthesizer: ['btc-analyst', 'eth-analyst'],
  reviewer: ['synthesizer']
})

export const WORKFLOW_STATUS_LABELS = Object.freeze({
  waiting: '等待',
  pending: '待处理',
  running: '进行中',
  complete: '已完成',
  blocked: '已阻断',
  failed: '失败',
  timeout: '超时'
})

export function normalizeWorkflowStatus(value) {
  const status = String(value ?? '').trim().toLowerCase()
  if (status === 'unknown' || status === 'waiting' || status === '') return 'waiting'
  if (status === 'pending' || status === 'queued') return 'pending'
  if (status === 'started' || status === 'running') return 'running'
  if (COMPLETE.has(status)) return 'complete'
  if (status === 'blocked') return 'blocked'
  if (status === 'failed' || status === 'error') return 'failed'
  if (status === 'timeout') return 'timeout'
  return 'waiting'
}

function roleStatuses(value) {
  if (!value || typeof value !== 'object') return {}
  if (Array.isArray(value)) {
    return Object.fromEntries(value.flatMap((item) => {
      if (typeof item === 'string' && ROLE_SET.has(item)) return [[item, 'unknown']]
      if (ROLE_SET.has(item?.role)) return [[item.role, item.status]]
      return []
    }))
  }
  return Object.fromEntries(WORKFLOW_NODES.flatMap(({ role }) => Object.hasOwn(value, role) ? [[role, value[role]]] : []))
}

function dagStatuses(dag) {
  if (!dag || typeof dag !== 'object') return {}
  if (Array.isArray(dag.roles)) return roleStatuses(dag.roles)
  const direct = roleStatuses(dag)
  if (Object.keys(direct).length) return direct
  const daily = roleStatuses(dag.daily)
  if (Object.keys(daily).length) return daily
  return roleStatuses(dag.weekly)
}

function statusProjection(status) {
  if (!status || typeof status !== 'object') return {}
  const direct = roleStatuses(status)
  if (Object.keys(direct).length) return direct
  for (const projection of [status.roles, status.results, status.attempts, status.provenance?.attempts]) {
    const roles = roleStatuses(projection)
    if (Object.keys(roles).length) return roles
  }
  return dagStatuses(status.dag)
}

function eventStatuses(events) {
  const list = Array.isArray(events) ? events : Object.entries(events || {}).map(([role, status]) => ({ role, status }))
  const output = {}
  for (const event of list) {
    const data = event?.data && typeof event.data === 'object' ? event.data : event
    if (ROLE_SET.has(data?.role)) output[data.role] = data.status
  }
  return output
}

function mergePolledStatus(dagValue, statusValue) {
  if (dagValue === undefined) return statusValue
  if (statusValue === undefined) return dagValue
  const dagStatus = normalizeWorkflowStatus(dagValue)
  const projectedStatus = normalizeWorkflowStatus(statusValue)
  if (FINAL_STATES.has(dagStatus)) return dagValue
  if (FINAL_STATES.has(projectedStatus)) return statusValue
  return STATUS_RANK[projectedStatus] > STATUS_RANK[dagStatus] ? statusValue : dagValue
}

function mergeEventStatus(polledValue, eventValue) {
  if (polledValue === undefined) return eventValue
  if (eventValue === undefined) return polledValue
  const polledStatus = normalizeWorkflowStatus(polledValue)
  const eventStatus = normalizeWorkflowStatus(eventValue)
  if (FINAL_STATES.has(polledStatus)) return polledValue
  return STATUS_RANK[eventStatus] > STATUS_RANK[polledStatus] ? eventValue : polledValue
}

export function deriveWorkflowState({ dag = {}, status = {}, events = [] } = {}) {
  const dagReported = dagStatuses(dag)
  const statusReported = statusProjection(status)
  const eventReported = eventStatuses(events)
  const reported = Object.fromEntries(WORKFLOW_NODES.map(({ role }) => {
    const polled = mergePolledStatus(dagReported[role], statusReported[role])
    return [role, mergeEventStatus(polled, eventReported[role])]
  }))
  const byRole = {}
  const nodes = WORKFLOW_NODES.map((definition) => {
    const normalized = normalizeWorkflowStatus(reported[definition.role])
    const missingDependencies = DEPENDENCIES[definition.role].filter((role) => byRole[role]?.status !== 'complete')
    const conflict = (normalized === 'running' || normalized === 'complete') && missingDependencies.length > 0
    const node = {
      ...definition,
      status: conflict ? 'blocked' : normalized,
      statusLabel: conflict ? '状态冲突' : WORKFLOW_STATUS_LABELS[normalized],
      current: !conflict && normalized === 'running',
      conflict,
      missingDependencies,
      reportedStatus: reported[definition.role] ?? 'unknown'
    }
    byRole[node.role] = node
    return node
  })

  const completedCount = nodes.filter(({ status }) => status === 'complete').length
  const currentAgents = nodes.filter(({ current }) => current).map(({ role }) => role)
  const conflict = nodes.some((node) => node.conflict)
  const failure = nodes.find((node) => ['failed', 'timeout', 'blocked'].includes(node.status))
  let currentStage = '等待开始'
  if (completedCount === WORKFLOW_NODES.length) currentStage = '流程完成'
  else if (conflict) currentStage = '状态冲突'
  else if (failure?.status === 'timeout') currentStage = '执行超时'
  else if (failure?.status === 'failed') currentStage = '执行失败'
  else if (failure) currentStage = '流程受阻'
  else if (currentAgents.includes('btc-analyst') || currentAgents.includes('eth-analyst')) currentStage = '并行分析'
  else if (currentAgents.length) currentStage = byRole[currentAgents[0]].name

  return {
    nodes,
    byRole,
    completedCount,
    totalCount: WORKFLOW_NODES.length,
    percent: Math.round((completedCount / WORKFLOW_NODES.length) * 100),
    currentStage,
    currentAgents,
    conflict
  }
}
