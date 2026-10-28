/**
 * The headers a client may NOT hand the backend through the WebSocket proxy.
 *
 * `server.js` forwards the upgrade request's headers to the Python backend and
 * then SETS the `x-grid-*` context headers from `/api/auth/websocket-scope`. It
 * set each one only when the scope response had the field, and deleted none,
 * so a header the client sent itself went through whenever the scope had no
 * value to overwrite it with. The backend reads them as decisions the BFF made:
 * `x-grid-model-overrides` (which model every agent group runs on, at the
 * organization's expense), `x-grid-budget` (how much is left), and
 * `x-grid-disabled-sources` (the sources the organization switched off). A
 * cookie-authenticated client outside a browser could pick all three.
 *
 * So the proxy removes every inbound `x-grid-*` header before it writes its
 * own, and `authorization` too: the backend's identity is the session the BFF
 * resolved for the scope, and a caller-chosen bearer beside that cookie would
 * make the two disagree. `x-internal-token` goes with them for the same reason
 * `x-grid-internal-token` does: no browser-facing request carries the service
 * secret. The Python readers prefer the signed envelope as well
 * (`get_signed_request_context`), so neither layer trusts the other to hold.
 *
 * CommonJS and import-free because `server.js` requires it at startup; the
 * production image copies it in by path (`deploy/Dockerfile`).
 */

const CLIENT_CONTEXT_HEADER_PREFIX = 'x-grid-'
const CLIENT_CREDENTIAL_HEADERS = new Set(['authorization', 'x-internal-token'])

/**
 * The same context headers under their names without the product's (`x-budget`
 * for `x-grid-budget`), which the backend reads beside the old ones from this
 * release (`aiq_api.legacy_headers`). Named one by one: `x-` alone is every
 * proxy's prefix. `tests/test_legacy_headers.py` holds this list and the
 * backend's equal.
 */
const SERVICE_HEADERS = new Set([
  'x-answer-message-id',
  'x-budget',
  'x-collection-scope',
  'x-context-transport',
  'x-disabled-sources',
  'x-feature-memory-reflection',
  'x-locale',
  'x-model-overrides',
  'x-org-instructions',
  'x-organization-id',
  'x-project-context',
  'x-project-id',
  'x-project-memory',
  'x-request-context',
  'x-request-context-sig',
  'x-user-id',
])

/**
 * Delete, in place, every inbound header only the proxy may set.
 *
 * `headers` is Node's `req.headers`, whose names are already lower-case.
 * Returns the names it removed, for a log line or a test.
 *
 * @param {Record<string, string | string[] | undefined>} headers
 * @returns {string[]}
 */
function stripClientContextHeaders(headers) {
  const removed = []
  for (const name of Object.keys(headers)) {
    const lower = name.toLowerCase()
    if (lower.startsWith(CLIENT_CONTEXT_HEADER_PREFIX) || SERVICE_HEADERS.has(lower) || CLIENT_CREDENTIAL_HEADERS.has(lower)) {
      delete headers[name]
      removed.push(lower)
    }
  }
  return removed
}

// websockets 15's parser limits each line to 8192 bytes, not the decoded text.
const WS_HEADER_LINE_MAX_BYTES = 8192

/**
 * @param {Record<string, string | string[] | undefined>} headers
 * @returns {{name: string, bytes: number} | null}
 */
function findOversizedWsHeader(headers) {
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    const values = Array.isArray(value) ? value : [value]
    // Node combines cookie arrays into one line.
    const lines = name.toLowerCase() === 'cookie' ? [values.join('; ')] : values
    for (const line of lines) {
      const bytes = Buffer.byteLength(`${name}: ${line}\r\n`, 'utf8')
      if (bytes > WS_HEADER_LINE_MAX_BYTES) return { name, bytes }
    }
  }
  return null
}

const SESSION_COOKIE_NAME = process.env.WORKOS_COOKIE_NAME || 'wos-session'

function isSessionCookie(name) {
  if (name === SESSION_COOKIE_NAME) return true
  const prefix = `${SESSION_COOKIE_NAME}.`
  return name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length))
}

function cookieName(pair) {
  const separator = pair.indexOf('=')
  return (separator < 0 ? pair : pair.slice(0, separator)).trim()
}

/**
 * The Cookie line for the backend, without the AuthKit session.
 *
 * The backend never reads the session: its identity is the scope the BFF
 * resolved from it, and the cookie it does read is `idToken`. The sealed
 * session is the largest thing in the line, split across `wos-session.0`, `.1`,
 * … once it outgrows one cookie, and every permission or flag WorkOS adds grows
 * it; left in, it would one day take the line past the parser's 8192 bytes and
 * every chat socket would get a 431 while pages still loaded.
 *
 * @param {string | undefined} cookieHeader
 * @returns {string | undefined} undefined when nothing is left to send
 */
function withoutSessionCookies(cookieHeader) {
  if (!cookieHeader) return undefined
  const kept = cookieHeader
    .split(';')
    .map((pair) => pair.trim())
    .filter((pair) => pair && !isSessionCookie(cookieName(pair)))
  return kept.length > 0 ? kept.join('; ') : undefined
}

module.exports = {
  SERVICE_HEADERS,
  stripClientContextHeaders,
  findOversizedWsHeader,
  withoutSessionCookies,
  WS_HEADER_LINE_MAX_BYTES,
  CLIENT_CONTEXT_HEADER_PREFIX,
}
