const JSON_HEADERS = Object.freeze({ 'Content-Type': 'application/json' })

async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'include',
    ...options,
    headers: { ...(options.body ? JSON_HEADERS : {}), ...(options.headers || {}) }
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(body.message || `控制平面返回状态 ${response.status}`)
    error.status = response.status
    error.code = body.code
    throw error
  }
  return body
}

export function isSessionFailure(error) {
  return (error?.status === 401 && error.code === 'CONTROL_SESSION_REQUIRED') || (error?.status === 403 && error.code === 'CONTROL_CSRF_REJECTED')
}

function get(path, csrf) {
  return request(path, { headers: csrf ? { 'X-CSRF-Token': csrf } : {} })
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
  resumeSession: () => request('/api/session', { headers: { 'X-Tyche-Session': 'resume' }, cache: 'no-store' }),
  logout: (csrf) => post('/api/logout', {}, csrf),
  providerStatus: (csrf) => get('/api/provider', csrf),
  configureProvider: ({ provider, protocol, model, endpoint, apiKey }, csrf) => post('/api/provider', { provider, protocol, model, endpoint, api_key: apiKey }, csrf),
  discoverProvider: ({ provider, protocol, endpoint, apiKey }, csrf) => post('/api/provider/discover', { provider, protocol, endpoint, api_key: apiKey }, csrf),
  clearProvider: (csrf) => post('/api/provider/clear', {}, csrf),
  status: (csrf) => get('/api/status', csrf),
  cycle: (csrf) => get('/api/cycle', csrf),
  dag: (csrf) => get('/api/dag', csrf),
  paper: (csrf) => get('/api/paper', csrf),
  paperSetup: (csrf) => get('/api/paper/setup', csrf),
  setupPaper: (input, csrf) => post('/api/paper/setup', input, csrf),
  strategy: (csrf) => get('/api/strategy', csrf),
  models: (csrf) => get('/api/models', csrf),
  applyModels: (configuration, csrf) => post('/api/models', configuration, csrf),
  applyStrategy: (prompt, csrf) => post('/api/strategy', { prompt }, csrf),
  discussStrategy: (message, csrf, allocate = false) => post('/api/strategy/discuss', { message, ...(allocate ? { allocate: true } : {}) }, csrf),
  testnet: (csrf) => get('/api/testnet', csrf),
  runCycle: (input, csrf) => post('/api/cycle', input, csrf),
  executorStatus: (venue, csrf) => get(`/api/executor/status?venue=${encodeURIComponent(venue)}`, csrf),
  arm: (venue, confirmation, csrf) => post('/api/executor/arm', { venue, confirmation }, csrf),
  disarm: (venue, csrf) => post('/api/executor/disarm', { venue }, csrf),
  plan: (venue, date, isoWeek, csrf) => post('/api/executor/plan', { venue, date, iso_week: isoWeek }, csrf),
  execute: (venue, planHash, confirmation, csrf) => post('/api/executor/execute', { venue, plan_hash: planHash, confirmation }, csrf),
  reconcile: (venue, planHash, csrf) => post('/api/executor/reconcile', planHash ? { venue, plan_hash: planHash } : { venue }, csrf)
})

export function eventsUrl() {
  return `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/api/events`
}
