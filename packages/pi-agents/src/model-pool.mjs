import { createHash } from 'node:crypto'

export const EFFORTS = Object.freeze(['medium', 'high', 'xhigh'])
export const MAX_POOL_MODELS = 12
export function validateModelPool(value) {
  const fail = () => { const error = new Error('PI_MODEL_POOL_INVALID'); error.code = error.message; throw error }
  if (!Array.isArray(value) || !value.length || value.length > MAX_POOL_MODELS) fail()
  const ids = new Set()
  return Object.freeze(value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some((key) => !['id', 'efforts'].includes(key)) || typeof entry.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,95}$/.test(entry.id) || entry.id.includes('://') || ids.has(entry.id) || !Array.isArray(entry.efforts) || !entry.efforts.length || entry.efforts.length > 3 || new Set(entry.efforts).size !== entry.efforts.length || entry.efforts.some((effort) => !EFFORTS.includes(effort))) fail()
    ids.add(entry.id)
    return Object.freeze({ id: entry.id, efforts: Object.freeze(EFFORTS.filter((effort) => entry.efforts.includes(effort))) })
  }))
}
export function modelPoolDigest(pool) {
  return createHash('sha256').update(JSON.stringify([...validateModelPool(pool)].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0))).digest('hex')
}
