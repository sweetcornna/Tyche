import net from 'node:net'

function ipv4Number(address) {
  if (net.isIP(address) !== 4) return null
  const octets = address.split('.').map(Number)
  return (((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3]) >>> 0
}

function inV4Cidr(value, base, prefix) {
  const address = ipv4Number(value)
  const network = ipv4Number(base)
  if (address === null || network === null) return false
  if (prefix === 0) return true
  const mask = (0xffffffff << (32 - prefix)) >>> 0
  return (address & mask) === (network & mask)
}

const BLOCKED_V4 = Object.freeze([
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['168.63.129.16', 32],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.31.196.0', 24],
  ['192.52.193.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['192.175.48.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
])

function parseIpv6(address) {
  let value = String(address).toLowerCase()
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1)
  if (value.includes('%')) return null

  const mapped = value.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) {
    const v4 = ipv4Number(mapped[2])
    if (v4 === null) return null
    value = `${mapped[1]}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`
  }

  const halves = value.split('::')
  if (halves.length > 2) return null
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  if (halves.length === 1 && left.length !== 8) return null
  const omitted = 8 - left.length - right.length
  if (omitted < (halves.length === 2 ? 1 : 0)) return null
  const groups = [...left, ...Array(omitted).fill('0'), ...right]
  if (groups.length !== 8 || groups.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null
  return groups.map((part) => Number.parseInt(part, 16))
}

function isPublicIpv4(address) {
  return net.isIP(address) === 4 && !BLOCKED_V4.some(([base, prefix]) => inV4Cidr(address, base, prefix))
}

function isPublicIpv6(address) {
  const groups = parseIpv6(address)
  if (!groups) return false

  // IPv4-mapped IPv6 must inherit the IPv4 classification.
  if (groups.slice(0, 5).every((part) => part === 0) && groups[5] === 0xffff) {
    const mapped = `${groups[6] >>> 8}.${groups[6] & 255}.${groups[7] >>> 8}.${groups[7] & 255}`
    return isPublicIpv4(mapped)
  }

  // Conservatively permit global unicast only. Exclude documentation,
  // benchmarking, ORCHID, Teredo, and 6to4 ranges from that space.
  if ((groups[0] & 0xe000) !== 0x2000) return false
  if (groups[0] === 0x2001 && groups[1] <= 0x01ff) return false
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return false
  if (groups[0] === 0x2002) return false
  if (groups[0] === 0x3fff && groups[1] <= 0x0fff) return false
  return true
}

export function isPublicSessionAddress(address) {
  const kind = net.isIP(address)
  if (kind === 4) return isPublicIpv4(address)
  if (kind === 6) return isPublicIpv6(address)
  return false
}


export function isSyntheticSessionAddress(address) { return inV4Cidr(address, '198.18.0.0', 15) }
