const JSON_HEADERS = Object.freeze({ 'Content-Type': 'application/json' })

async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'include',
    ...options,
    headers: { ...(options.body ? JSON_HEADERS : {}), ...(options.headers || {}) }
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.message || `控制平面返回状态 ${response.status}`)
  return body
}

function post(path, body, csrf) {
  return request(path, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: csrf ? { 'X-CSRF-Token': csrf } : {}
  })
}

export const controlApi = Object.freeze({
  session: (bootstrapToken) => post('/api/session', { bootstrap_token: bootstrapToken }),
  logout: (csrf) => post('/api/logout', {}, csrf),
  status: () => request('/api/status'),
  cycle: () => request('/api/cycle'),
  dag: () => request('/api/dag'),
  paper: () => request('/api/paper'),
  testnet: () => request('/api/testnet'),
  runCycle: (input, csrf) => post('/api/cycle', input, csrf),
  executorStatus: (venue) => request(`/api/executor/status?venue=${encodeURIComponent(venue)}`),
  arm: (venue, confirmation, csrf) => post('/api/executor/arm', { venue, confirmation }, csrf),
  disarm: (venue, csrf) => post('/api/executor/disarm', { venue }, csrf),
  plan: (venue, date, isoWeek, csrf) => post('/api/executor/plan', { venue, date, iso_week: isoWeek }, csrf),
  execute: (venue, planHash, confirmation, csrf) => post('/api/executor/execute', { venue, plan_hash: planHash, confirmation }, csrf),
  reconcile: (venue, planHash, csrf) => post('/api/executor/reconcile', planHash ? { venue, plan_hash: planHash } : { venue }, csrf)
})

export function eventsUrl() {
  return `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/api/events`
}
