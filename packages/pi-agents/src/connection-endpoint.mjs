// Shared by the browser and server. Inspect the original text before URL can
// erase dot segments, escapes, or noncanonical loopback spellings.
export function normalizeConnectionEndpoint(value, protocol = 'openai-responses') {
  const fail = (code) => { const error = new Error(code); error.code = code; throw error }
  if (!['openai-responses', 'openai-completions', 'anthropic-messages'].includes(protocol)) fail('PI_SESSION_PROTOCOL_UNSUPPORTED')
  if (typeof value !== 'string' || !value) fail('PI_SESSION_ENDPOINT_REQUIRED')
  if (new TextEncoder().encode(value).length > 2048) fail('PI_SESSION_ENDPOINT_TOO_LONG')
  if (value !== value.trim() || /[\s\\\u0000-\u001f\u007f]/u.test(value)) fail('PI_SESSION_ENDPOINT_INVALID')
  if (value.includes('%')) fail('PI_SESSION_ENDPOINT_ENCODING_FORBIDDEN')
  const raw = value.includes('://') ? value : `https://${value}`
  const authority = raw.slice(raw.indexOf('://') + 3).split('/')[0]
  const rawPath = raw.slice(raw.indexOf('://') + 3).replace(/^[^/]*/u, '').split(/[?#]/u)[0]
  if (/(?:^|\/)\.{1,2}(?:\/|$)/u.test(rawPath) || rawPath.includes('//')) fail('PI_SESSION_ENDPOINT_PATH_INVALID')
  let url
  try { url = new URL(raw) } catch { fail('PI_SESSION_ENDPOINT_INVALID') }
  if (!['http:', 'https:'].includes(url.protocol)) fail('PI_SESSION_ENDPOINT_PROTOCOL_FORBIDDEN')
  if (url.username || url.password || authority.includes('@')) fail('PI_SESSION_ENDPOINT_USERINFO_FORBIDDEN')
  if (raw.includes('?')) fail('PI_SESSION_ENDPOINT_QUERY_FORBIDDEN')
  if (raw.includes('#')) fail('PI_SESSION_ENDPOINT_FRAGMENT_FORBIDDEN')
  if (url.hostname === 'localhost' || url.hostname.endsWith('.localhost')) fail('PI_SESSION_ENDPOINT_HOST_FORBIDDEN')
  if (url.protocol === 'http:' && !((url.hostname === [127, 0, 0, 1].join('.') && /^127\.0\.0\.1(?::\d+)?$/u.test(authority)) || (url.hostname === '[::1]' && /^\[::1\](?::\d+)?$/iu.test(authority)))) fail('PI_SESSION_ENDPOINT_HTTP_FORBIDDEN')
  let pathname = url.pathname.replace(/\/$/u, '')
  const suffix = protocol === 'openai-responses' ? '/responses' : protocol === 'openai-completions' ? '/chat/completions' : '/v1/messages'
  if (pathname.endsWith(suffix)) pathname = pathname.slice(0, -suffix.length)
  if (protocol === 'anthropic-messages' && pathname.endsWith('/v1')) pathname = pathname.slice(0, -3)
  if (/(?:\/responses|\/chat\/completions|\/messages)$/u.test(pathname)) fail('PI_SESSION_ENDPOINT_OPERATION_FORBIDDEN')
  if (protocol !== 'anthropic-messages' && !pathname) pathname = '/v1'
  return `${url.origin}${pathname}`
}
