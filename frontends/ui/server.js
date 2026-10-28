/**
 * Gateway Server with WebSocket Proxy
 *
 * Architecture (following Nemo-Agent-Toolkit-UI pattern):
 * - Runs on port 3000 as the main entry point
 * - Proxies to Next.js server (dev on 3001, or production on same process)
 * - Proxies /websocket to the backend's chat role (BACKEND_CHAT_URL). This is the
 *   only backend traffic this process carries; every HTTP call to the backend is
 *   the BFF's, to the api role (BACKEND_URL).
 *
 * Development:
 *   npm run dev - Runs gateway + Next.js dev server concurrently
 *
 * Production:
 *   npm start - Runs Next.js in production mode with integrated proxy
 *
 * Environment:
 *   BACKEND_CHAT_URL - The backend's chat role, for the WebSocket proxy (e.g.,
 *     http://aiq-agent:8000). Required: it does not fall back to BACKEND_URL,
 *     which is the api role and serves no chat socket (ADR-0082 step B).
 *   PORT - Gateway port (default: 3000)
 *   NEXT_INTERNAL_URL - Next.js server URL (default: http://localhost:3001)
 */

const http = require('http')
const httpProxy = require('http-proxy')
const { parse } = require('url')
const crypto = require('crypto')

// ── Boot identity (ledger item 1) ────────────────────────────────────────────
// One greppable line naming the deployed commit and where the feature flags
// come from (WorkOS, or the fixed defaults of a deployment that signs nobody
// in), printed before this process serves anything. A pilot said a feature did
// not work and nobody could say which build they were on, nor whether that
// feature was switched on for them at all. Rationale in full: `src/lib/boot.ts`.
//
// DUPLICATED from `formatBootLine`/`flagSource`/`deployedSha` in that module,
// for the same reason `src/lib/turns/turn-headers.js` duplicates the envelope builder: this file is
// plain CommonJS (see the `require(...)` calls above) and cannot import a TS
// module. `tests/lib/boot.test.ts` extracts THIS function from the source and
// runs it against the TS one over the same table, so the two cannot print
// different lines. Keep it pure and self-contained — the test instantiates it
// with `new Function`, so a reference to anything outside its own body breaks
// the pin rather than the line.
function bootLogLine(env) {
  const sha = (env.GRID_GIT_SHA || '').trim() || 'unknown'
  const flags = (env.REQUIRE_AUTH || '').toLowerCase() === 'true' ? 'workos' : 'defaults'
  return `[boot] sha=${sha} flags=${flags}`
}

// ── The turn's headers, and the signed context envelope (ADR-0054, ADR-0106) ──
// Every x-grid-* header this file forwards on a chat upgrade, and the one
// consolidated, signed `X-Request-Context` envelope beside them, are built
// by `turnContextHeaders` in `src/lib/turns/turn-headers.js` from the turn
// context `/api/auth/websocket-scope` resolved. The BFF's wake job builds the
// headers of the socket it opens as a person with the same function, so the
// two producers of a chat turn cannot drift. The canonical envelope payload is
// `buildGridRequestContextEnvelopePayload` in `src/lib/request-context.ts`;
// `request-context.spec.ts` pins the CommonJS copy to it.
const { turnContextHeaders } = require('./src/lib/turns/turn-headers.js')

const dev = process.env.NODE_ENV !== 'production'
const hostname = process.env.HOSTNAME || '0.0.0.0'
const port = parseInt(process.env.PORT || '3000', 10)

// The chat role's address. Required and never derived from BACKEND_URL: that is
// the api role, and a socket sent there would connect to nothing that serves
// one. A gateway that cannot say where chat is stops here, not at the first
// reader's upgrade.
const getBackendChatUrl = () => {
  const url = (process.env.BACKEND_CHAT_URL || '').trim()
  if (!url) {
    throw new Error(
      'BACKEND_CHAT_URL is required: the URL of the backend chat role, which the WebSocket proxy dials ' +
        '(e.g. http://aiq-agent:8000). BACKEND_URL is the api role and is not a fallback.',
    )
  }
  return url.replace(/\/$/, '')
}

const BACKEND_CHAT_URL = getBackendChatUrl()
const BACKEND_WS_URL = BACKEND_CHAT_URL.replace(/^http/, 'ws')
const NEXT_INTERNAL_URL = process.env.NEXT_INTERNAL_URL || 'http://localhost:3001'

// ── Conversation affinity (horizontal aiq-agent scaling) ──
// With GRID_CHAT_AFFINITY on (the default, ADR-0028) each conversation is pinned
// to one aiq-agent pod by a stable hash of conversationId -> that pod's stable
// DNS name, so the in-process socket, HITL future and running task are always
// reachable. With it off (ADR-0080) every socket goes to the load-balanced
// Service and the conversation bus decides, per turn, which replica runs it, so
// the backend can autoscale. Either way a single replica, no pod template or no
// conversationId reaches the load-balanced Service. The rule lives in
// src/lib/proxy/backend-target.js.
const { affinityEnabled, createBackendTargetPicker } = require('./src/lib/proxy/backend-target.js')
const BACKEND_REPLICAS = Math.max(1, parseInt(process.env.BACKEND_REPLICAS || '1', 10) || 1)
// Per-pod WS DNS template with a literal `{i}`, e.g.
// an in-cluster headless-service pod address like
// aiq-agent-{i}.aiq-agent-headless:8000 (ws, in-cluster only) supplied via env.
// nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
const BACKEND_POD_WS_TEMPLATE = process.env.BACKEND_POD_WS_TEMPLATE || ''
const CHAT_AFFINITY = affinityEnabled(process.env.GRID_CHAT_AFFINITY)
const pickBackendWsTarget = createBackendTargetPicker({
  replicas: BACKEND_REPLICAS,
  podTemplate: BACKEND_POD_WS_TEMPLATE,
  affinity: CHAT_AFFINITY,
  serviceUrl: BACKEND_WS_URL,
})

// How many frontend replicas this deployment runs (Pulumi passes the min count).
// Used only to loudly flag a multi-replica deploy that is missing the shared
// cache (REDIS_URL) — where the read-through caches and the WS rate limiter
// would silently diverge per pod. Defaults to 1 (single-node / dev).
const FRONTEND_REPLICAS = Math.max(1, parseInt(process.env.FRONTEND_REPLICAS || '1', 10) || 1)

// ── Metrics (OTLP to the collector, which forwards to PostHog Metrics) ──
// Installed before the server listens, so the first request is measured. No-op
// without OTEL_EXPORTER_OTLP_ENDPOINT. Flushed by `exitAfterHooks`.
const { initOtelMetrics, shutdownOtelMetrics } = require('./observability/otel-metrics.js')
const { measureRequest } = require('./observability/http-metrics.js')
initOtelMetrics()

// ── Graceful shutdown / rolling-update drain ──
// How long this process keeps serving after SIGTERM before forcing exit. Chat
// WebSockets are long-lived (a streaming answer can run for minutes), so the
// 2s local default would drop every in-flight response on every rollout. In
// Kubernetes the deployment sets this to the tier's drain budget and sizes
// terminationGracePeriodSeconds above it (deploy/pulumi/src/platform/rollout.ts).
const SHUTDOWN_DRAIN_MS = Math.max(
  0,
  parseInt(process.env.GRID_SHUTDOWN_DRAIN_MS || '', 10) || 2000
)
// The list the app pushes its flush-on-exit functions onto (see cleanExit).
const SHUTDOWN_HOOKS_KEY = '__gridShutdownHooks'
const SHUTDOWN_HOOKS_MS = 2000
// Set once SIGTERM/SIGINT arrives: readiness starts failing and new WebSocket
// upgrades are refused, while everything already in flight runs to completion.
let draining = false

// ── Upstream reachability and teardown ──
// A backend that is not there for an upgrade (rollout, restart: issues #270,
// #272) logs at WARN and is refused with a 502. A peer leaving an
// already-spliced socket (EPIPE, ECONNRESET: #588, #775, #784) logs at WARN
// with the side and the connection's age, and the first close names who
// closed. Neither files an issue per reconnect (ADR-0031); anything else stays
// ERROR. The codes, and why a spliced socket never gets a 502: ws-teardown.js.
const { handleWsProxyError, watchSplicedSockets } = require('./src/lib/proxy/ws-teardown.js')

// ── WebSocket rate limiting (ADR-0020, ADR-0040 layers L2 / L2b) ──
//
// Two limits live here, and the second is the reason this file matters:
//
//   1. **Upgrades, per client.** Every upgrade triggers session resolution, FGA
//      checks and budget reads in the BFF, so a reconnect storm amplifies
//      straight into WorkOS and Postgres. The edge now carries the same budget
//      (`rateLimitAppWsUpgrade`); this one keeps working while that policy is
//      in shadow mode, and covers anything that never crossed the gateway.
//   2. **Frames on an ALREADY-OPEN socket.** Chat is WebSocket-only (ADR-0009),
//      so from the edge's point of view a whole session — every turn, every
//      agent run — is the single upgrade request above. No gateway policy can
//      ever see a chat turn. This process owns the socket, so it is the only
//      place that can count them.
//
// Both use the shared catalog and the shared `rate-limiter-flexible` wiring
// (`src/lib/limits/`), so the WS proxy and the BFF cannot drift into different
// budgets, key prefixes or failure behaviour. Fails open — an abuse bound must
// never be the thing that takes chat down.
const { WS_UPGRADE_LIMIT, CHAT_TURN_LIMIT, WS_CONTROL_LIMIT } = require('./src/lib/limits/rules.js')
const { createLimiter, consumeLimiter } = require('./src/lib/limits/factory.js')
const { createFrameObserver, classifyFrame } = require('./src/lib/limits/ws-frames.js')
// Inbound x-grid-* / authorization are the proxy's to set, never the client's.
const { stripClientContextHeaders, findOversizedWsHeader, withoutSessionCookies } = require('./src/lib/proxy/ws-upgrade-headers.js')

// `GRID_WS_UPGRADE_RATE_LIMIT` predates the catalog and stays honoured: an
// operator who tuned it should not have it silently reverted by this refactor.
// 0 still disables the upgrade limit entirely.
const parsedUpgradeOverride = parseInt(
  process.env.GRID_WS_UPGRADE_RATE_LIMIT || String(WS_UPGRADE_LIMIT.limit),
  10
)
if (!Number.isFinite(parsedUpgradeOverride)) {
  console.warn(
    '[Gateway] invalid GRID_WS_UPGRADE_RATE_LIMIT=%s, using catalog default %d',
    process.env.GRID_WS_UPGRADE_RATE_LIMIT,
    WS_UPGRADE_LIMIT.limit
  )
}
// A typo must not silently switch the limit off. `parseInt('thirty')` is NaN,
// and `NaN > 0` is false — so without this guard a malformed value took the
// `upgradeLimiter = null` path and disabled upgrade limiting with nothing in the
// logs. Only an explicit 0 disables it.
const WS_UPGRADE_OVERRIDE = Number.isFinite(parsedUpgradeOverride)
  ? parsedUpgradeOverride
  : WS_UPGRADE_LIMIT.limit
// Frames per session. 0 disables, for an operator who needs the old behaviour
// back in a hurry.
const WS_MESSAGE_LIMITS_ENABLED = process.env.GRID_WS_MESSAGE_LIMITS !== '0'

let limitStoreClient = null
if (process.env.REDIS_URL) {
  try {
    const { createRedisClient } = require('./src/lib/redis/connect.js')
    limitStoreClient = createRedisClient(process.env.REDIS_URL, 'Gateway', { commandTimeout: 500 })
  } catch (error) {
    console.warn('[Gateway] shared rate limiter unavailable, using per-process buckets:', error.message)
  }
}

const upgradeLimiter =
  WS_UPGRADE_OVERRIDE > 0
    ? createLimiter({ ...WS_UPGRADE_LIMIT, limit: WS_UPGRADE_OVERRIDE }, limitStoreClient)
    : null
const frameLimiters = WS_MESSAGE_LIMITS_ENABLED
  ? {
      'chat-turn': createLimiter(CHAT_TURN_LIMIT, limitStoreClient),
      control: createLimiter(WS_CONTROL_LIMIT, limitStoreClient),
    }
  : null

const getClientKey = (req) => {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim()
  }
  return req.socket?.remoteAddress || 'unknown'
}

/**
 * Bucket key for frames on one socket.
 *
 * The session cookie, hashed — the same idiom `scopeCacheKey` uses below, and
 * for the same reason: it identifies the session stably without putting a
 * credential in a key. Deliberately NOT the client IP: several tabs of one user
 * share a budget (they share an account), while two users behind one NAT do
 * not.
 */
const sessionKey = (req) =>
  crypto.createHash('sha256').update(req.headers.cookie || getClientKey(req)).digest('hex')

async function wsUpgradeAllowed(clientKey) {
  if (!upgradeLimiter) return true
  const outcome = await consumeLimiter(upgradeLimiter, clientKey)
  return outcome.allowed
}

/**
 * Watch one client socket and close it if it exceeds its frame budget.
 *
 * Passive: the observer is an extra `data` listener, so nothing about what gets
 * forwarded changes. Enforcement is necessarily *after the fact* — the frame
 * has already been spliced upstream by the time we finish parsing it — so the
 * action on refusal is to close the connection rather than to drop a message.
 * That is the standard answer for WebSockets, where there is no 429 to send,
 * and it is safe: the client reconnects on its jittered backoff and the
 * upgrade limiter above then paces it.
 */
function watchClientFrames(socket, key) {
  if (!frameLimiters) return null

  let closing = false
  const observer = createFrameObserver((frame) => {
    const kind = classifyFrame(frame)
    // The close handshake is never throttled, or a socket cannot shut down.
    if (kind === 'ignore' || closing) return

    consumeLimiter(frameLimiters[kind], `${kind}:${key}`)
      .then((outcome) => {
        if (outcome.allowed || closing) return
        closing = true
        console.warn('[WS Proxy] frame budget exceeded (%s), closing socket', kind)
        try {
          // Opcode 8, status 1008 "policy violation" — the close reason that
          // tells an honest client this was a rule and not a crash.
          socket.end(Buffer.from([0x88, 0x02, 0x03, 0xf0]))
        } catch {
          socket.destroy()
        }
      })
      .catch(() => {
        // Fail open: a store failure must not sever a live chat.
      })
  })

  socket.on('data', (chunk) => observer.push(chunk))
  return observer
}

// In production, we run Next.js in the same process
let nextApp = null
let nextHandle = null

if (!dev) {
  const next = require('next')
  nextApp = next({ dev: false, hostname, port: 3001 })
  nextHandle = nextApp.getRequestHandler()
}

// Create proxy for Next.js (used in dev mode)
const nextProxy = httpProxy.createProxyServer({
  target: NEXT_INTERNAL_URL,
  changeOrigin: true,
  ws: true,
  xfwd: true,
  preserveHeaderKeyCase: true,
})

// Create proxy for backend
const backendProxy = httpProxy.createProxyServer({
  changeOrigin: true,
  ws: true,
  xfwd: true,
  preserveHeaderKeyCase: true,
})

// Error handling for Next.js proxy
nextProxy.on('error', (err, req, res) => {
  console.error('[Next.js Proxy Error]:', err.message)
  if (res && res.writeHead && !res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'application/json' })
  }
  if (res && !res.writableEnded) {
    res.end(JSON.stringify({ error: 'Next.js server unavailable' }))
  }
})

// Error handling for backend proxy
backendProxy.on('error', (err, req, res) => {
  console.error('[Backend Proxy Error]:', err.message)
  if (res && res.writeHead && !res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'application/json' })
  }
  if (res && !res.writableEnded) {
    res.end(JSON.stringify({ error: 'Backend unavailable' }))
  }
})

// Forward cookies for backend WebSocket, less the AuthKit session the backend
// never reads (`withoutSessionCookies`), and watch the pair once it is spliced.
// http-proxy emits 'proxyReqWs' before it registers its own 'upgrade' listener
// on proxyReq (passes/ws-incoming.js), so the one added here runs first: our
// error and close listeners are in place before the 101 is written and the
// sockets are piped. 'open' fires later and carries only the upstream socket.
backendProxy.on('proxyReqWs', (proxyReq, req, socket) => {
  const cookie = withoutSessionCookies(req.headers.cookie)
  if (cookie) {
    proxyReq.setHeader('Cookie', cookie)
  } else {
    proxyReq.removeHeader('Cookie')
  }
  // Check the emitted headers too: http-proxy adds host/forwarded fields.
  const oversized = findOversizedWsHeader(proxyReq.getHeaders())
  if (oversized) {
    console.warn('[WS Proxy] Header exceeds upstream line budget: %s (%d bytes)', oversized.name, oversized.bytes)
    socket.write('HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n')
    socket.destroy()
    proxyReq.destroy()
    return
  }
  proxyReq.once('upgrade', (_proxyRes, proxySocket) => {
    proxySocket.setKeepAlive?.(true, 15000)
    watchSplicedSockets(socket, proxySocket)
  })
})

const normalizeQueryParam = (value) => {
  if (Array.isArray(value)) return value[0]
  return value || undefined
}

const fetchCollectionScopeHeader = (req, projectId, conversationId) => {
  return new Promise((resolve, reject) => {
    const query = new URLSearchParams()
    if (projectId) query.set('projectId', projectId)
    if (conversationId) query.set('conversationId', conversationId)

    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: `/api/auth/websocket-scope?${query.toString()}`,
        method: 'GET',
        headers: {
          ...(req.headers.cookie ? { Cookie: req.headers.cookie } : {}),
        },
      },
      (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          data += chunk
        })
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const json = JSON.parse(data)
              resolve({ ok: true, status: res.statusCode, header: json.header, data: json })
            } catch (err) {
              console.warn('[WS Proxy] Failed to parse collection scope response:', err.message)
              resolve({ ok: false, status: res.statusCode, header: null, data: null })
            }
          } else {
            resolve({ ok: false, status: res.statusCode, header: null, data: null })
          }
        })
      }
    )

    request.setTimeout(5000, () => {
      request.destroy()
      reject(new Error('Collection scope request timed out'))
    })

    request.on('error', (err) => {
      console.warn('[WS Proxy] Collection scope request failed:', err.message)
      resolve({ ok: false, status: null, header: null, data: null })
    })

    request.end()
  })
}

// ── WS-upgrade admission + scope memoisation ──
// The per-IP limiter above throttles ONE abusive client. It does nothing about
// the herd this deployment creates for itself: a rolling update severs every
// socket on a pod at once, and those clients come back from thousands of
// DISTINCT IPs, so every one of them passes the per-IP check and triggers a
// fresh `/api/auth/websocket-scope` render (session resolution + FGA + budget
// reads — ADR-0020). Two bounds on that amplification:
//
//   1. SINGLE-FLIGHT + short-TTL memo per (session, project, conversation).
//      A client that reconnects within the TTL, or several tabs racing the same
//      upgrade, cost one upstream resolution instead of N.
//   2. A GLOBAL in-flight ceiling. Past it, upgrades are shed with 503 +
//      Retry-After instead of queueing — the pod stays responsive for the
//      connections it already holds, and the client's jittered backoff
//      (`shared/utils/backoff.ts`) spreads the retry.
//
// The memo is per-process and in-memory ON PURPOSE: the payload carries an
// access token, and a shared Dragonfly cache would put bearer credentials in a
// store shared by every tier. Per-pod caching still cuts the amplification
// proportionally, because a given client reconnects to one pod at a time.
// TTL is deliberately short — it bounds how long a revoked session can still
// ride a cached scope. 0 disables the memo entirely.
const WS_UPGRADE_MAX_INFLIGHT = parseInt(process.env.GRID_WS_UPGRADE_MAX_INFLIGHT || '32', 10)
const WS_SCOPE_CACHE_TTL_MS = parseInt(process.env.GRID_WS_SCOPE_CACHE_TTL_MS || '10000', 10)
const WS_SCOPE_CACHE_MAX_ENTRIES = 5000

let inflightScopeResolutions = 0
const scopeCache = new Map()
const scopeInflight = new Map()

const scopeCacheKey = (req, projectId, conversationId) =>
  crypto
    .createHash('sha256')
    .update(
      JSON.stringify([req.headers.cookie || '', projectId ?? null, conversationId ?? null])
    )
    .digest('hex')

/**
 * Resolve the collection scope for an upgrade, memoised and admission-gated.
 *
 * Returns the same shape as `fetchCollectionScopeHeader`, plus `rejected: true`
 * when the global in-flight ceiling shed this upgrade.
 */
const resolveCollectionScope = (req, projectId, conversationId) => {
  // The memo and the admission ceiling are INDEPENDENT bounds: disabling the
  // memo (TTL <= 0, e.g. to force fresh auth) must not also disable the ceiling.
  const cacheEnabled = WS_SCOPE_CACHE_TTL_MS > 0
  const key = cacheEnabled ? scopeCacheKey(req, projectId, conversationId) : null

  if (cacheEnabled) {
    const cached = scopeCache.get(key)
    if (cached && cached.expiresAt > Date.now()) {
      return Promise.resolve(cached.result)
    }

    // Coalesce concurrent upgrades for the same session onto one upstream call.
    const pending = scopeInflight.get(key)
    if (pending) return pending
  }

  if (WS_UPGRADE_MAX_INFLIGHT > 0 && inflightScopeResolutions >= WS_UPGRADE_MAX_INFLIGHT) {
    return Promise.resolve({ ok: false, status: 503, header: null, data: null, rejected: true })
  }

  inflightScopeResolutions += 1
  const request = fetchCollectionScopeHeader(req, projectId, conversationId)
    .then((result) => {
      // Only successes are memoised — a transient failure must not be sticky.
      if (cacheEnabled && result.ok) {
        if (scopeCache.size > WS_SCOPE_CACHE_MAX_ENTRIES) scopeCache.clear()
        scopeCache.set(key, { expiresAt: Date.now() + WS_SCOPE_CACHE_TTL_MS, result })
      }
      return result
    })
    .finally(() => {
      inflightScopeResolutions -= 1
      if (cacheEnabled) scopeInflight.delete(key)
    })

  if (cacheEnabled) scopeInflight.set(key, request)
  return request
}

const startServer = async () => {
  // In production, prepare Next.js
  if (!dev && nextApp) {
    await nextApp.prepare()
  }

  const server = http.createServer(async (req, res) => {
    req.socket.setKeepAlive?.(true, 15000)
    req.socket.setTimeout?.(0)

    let parsedUrl
    try {
      parsedUrl = parse(req.url, true)
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' })
      res.end('Bad Request')
      return
    }
    measureRequest(req, res, parsedUrl.pathname)

    // Draining: fail readiness immediately so the kubelet marks this pod
    // NotReady and the gateway stops sending it new traffic, while requests and
    // WebSockets already in flight keep running to completion. Liveness uses the
    // same path, but a NotReady pod that is already terminating is never
    // restarted for it.
    if (draining && parsedUrl.pathname === '/api/healthz') {
      res.writeHead(503, { 'Content-Type': 'application/json', Connection: 'close' })
      res.end(JSON.stringify({ status: 'draining' }))
      return
    }

    if (dev) {
      // Development: proxy everything to Next.js dev server
      nextProxy.web(req, res, { target: NEXT_INTERNAL_URL })
    } else {
      // Production: handle with Next.js directly
      try {
        await nextHandle(req, res, parsedUrl)
      } catch (err) {
        console.error('Error handling request:', err)
        res.statusCode = 500
        res.end('Internal Server Error')
      }
    }
  })

  // WebSocket upgrade handler
  server.on('upgrade', async (req, socket, head) => {
    socket.setKeepAlive?.(true, 15000)
    socket.setTimeout?.(0)

    let parsedUrl
    try {
      parsedUrl = parse(req.url, true)
    } catch {
      socket.destroy()
      return
    }
    const pathname = parsedUrl.pathname || '/'

    // Refuse NEW sessions while draining — a pod that is going away must not
    // accept a WebSocket it cannot see through. The client reconnects and the
    // gateway routes it to a replica that is staying.
    if (draining) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }

    // Proxy /websocket to backend
    if (pathname === '/websocket' || pathname.startsWith('/websocket')) {
      if (!(await wsUpgradeAllowed(getClientKey(req)))) {
        socket.write(
          'HTTP/1.1 429 Too Many Requests\r\nRetry-After: 60\r\nConnection: close\r\n\r\n'
        )
        socket.destroy()
        return
      }

      const projectId = normalizeQueryParam(parsedUrl.query.projectId)
      const conversationId = normalizeQueryParam(parsedUrl.query.conversationId)
      req.url = '/websocket' + (parsedUrl.search || '')
      // Before anything below writes the context headers: each is set only
      // when the scope has a value, so a client's own header survived every
      // field the scope left empty (model overrides, budget, disabled sources).
      stripClientContextHeaders(req.headers)

      try {
        const result = await resolveCollectionScope(req, projectId, conversationId)
        if (result.rejected) {
          // Shed rather than queue: the pod protects the connections it already
          // holds, and the client retries on a jittered backoff.
          try {
            socket.write(
              'HTTP/1.1 503 Service Unavailable\r\nRetry-After: 5\r\nConnection: close\r\n\r\n'
            )
          } catch {}
          socket.destroy()
          return
        }
        if (result.ok && result.header) {
          if (result.data?.organizationId && result.data?.userId && !process.env.GRID_INTERNAL_API_TOKEN) {
            console.warn('[WS Proxy] Signed turn context unavailable: internal service token is not configured')
            socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
            socket.destroy()
            return
          }
          // SAST: `express-data-exfiltration` fires on remote-looking data
          // reaching `req.headers`. Here the data is not remote. `result` is
          // this server's own `/api/auth/websocket-scope` render (see
          // `resolveCollectionScope` above): same process, same trust domain,
          // and every field is derived server-side from the authenticated
          // session — organization and user from the session itself, the scope
          // from `buildCollectionScopeFromRequest` after its FGA checks, the
          // conversation the one `authorizeConversationScope` ran on. None of
          // it is caller-supplied, and the client cannot influence which fields
          // come back. Suppressed narrowly, by rule id, on this call only — a
          // broader ignore would hide the case where genuinely caller-supplied
          // data starts reaching `req.headers`, which is what the rule is worth
          // having for.
          // nosemgrep: javascript.express.security.express-data-exfiltration.express-data-exfiltration
          Object.assign(
            req.headers,
            turnContextHeaders(result.data, {
              // Minted HERE: the envelope's age is the age of THIS handshake.
              issuedAt: Date.now(),
              secret: process.env.GRID_INTERNAL_API_TOKEN,
            })
          )
        } else if (result.status === 401 || result.status === 403) {
          const statusText = result.status === 401 ? 'Unauthorized' : 'Forbidden'
          try {
            socket.write(`HTTP/1.1 ${result.status} ${statusText}\r\n\r\n`)
          } catch {}
          socket.destroy()
          return
        } else {
          // Fail CLOSED: any other scope-resolution failure (5xx, network
          // error, malformed response) must not proxy the socket to the
          // backend stripped of its collection-scope/auth/org headers.
          console.warn(
            '[WS Proxy] Collection scope unavailable (status: %s), rejecting upgrade',
            result.status
          )
          try {
            socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
          } catch {}
          socket.destroy()
          return
        }
      } catch (err) {
        console.warn('[WS Proxy] Collection scope lookup failed:', err.message)
        try {
          socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n')
        } catch {}
        socket.destroy()
        return
      }

      const oversized = findOversizedWsHeader(req.headers)
      if (oversized) {
        console.warn('[WS Proxy] Header exceeds upstream line budget: %s (%d bytes)', oversized.name, oversized.bytes)
        socket.write('HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }

      // Count what this client sends once the socket is live (ADR-0040 L2b).
      // Attached BEFORE the splice so no frame is missed, and passive, so the
      // proxying below is unchanged.
      const frameObserver = watchClientFrames(socket, sessionKey(req))
      // `head` holds bytes already read off the socket during the upgrade —
      // Node hands them to us rather than leaving them in the stream, and
      // `backendProxy.ws` forwards them upstream. They never arrive as a 'data'
      // event, so an observer that only listens for 'data' would miss them. A
      // partial frame there desynchronises the parser for the life of the
      // connection, and the chat-turn limiter silently stops counting.
      if (frameObserver && head && head.length > 0) frameObserver.push(head)

      // Guard the proxy call itself: http-proxy can throw SYNCHRONOUSLY from
      // ws() (e.g. an invalid header value) and an uncaught throw in the
      // 'upgrade' listener crashes the whole gateway process.
      try {
        backendProxy.ws(
          req,
          socket,
          head,
          // Conversation affinity (GRID_CHAT_AFFINITY): pin this conversation to
          // its owning backend replica, or hand it to the Service when off.
          { target: pickBackendWsTarget(conversationId), changeOrigin: true },
          // http-proxy also calls this AFTER the upgrade, for an upstream socket
          // error; the handler never writes a 502 into a live WebSocket.
          (err) => {
            if (err) handleWsProxyError(err, socket)
          }
        )
      } catch (err) {
        console.error('[WS Proxy] Upgrade failed synchronously:', err.message)
        try {
          socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
        } catch {}
        socket.destroy()
      }
      return
    }

    // All other WebSocket connections (HMR, etc.)
    if (dev) {
      // Development: proxy to Next.js dev server
      nextProxy.ws(req, socket, head, { target: NEXT_INTERNAL_URL }, (err) => {
        if (err) {
          console.error('[Next.js WS] Proxy error:', err.message)
          socket.destroy()
        }
      })
    } else {
      // Production: let Next.js handle it
      const upgradeHandler = nextApp.getUpgradeHandler()
      upgradeHandler(req, socket, head)
    }
  })

  // Server configuration for long-running connections
  server.keepAliveTimeout = 0
  server.headersTimeout = 65000
  server.requestTimeout = 0

  // Multi-replica without a shared cache is a misconfiguration: the read-through
  // caches (ADR-0019) and the WS-upgrade rate limiter fall back to per-process
  // state, so they diverge across pods (e.g. the rate limit becomes N×). Fail
  // open (don't crash — matches the cache/limiter philosophy) but warn loudly so
  // it's caught. Single replica / dev with no REDIS_URL is fine and stays quiet.
  if (FRONTEND_REPLICAS > 1 && !process.env.REDIS_URL) {
    console.error(
      `[Gateway] WARNING: FRONTEND_REPLICAS=${FRONTEND_REPLICAS} but REDIS_URL is unset — ` +
        'the shared cache and WS rate limiter will run per-process and diverge across replicas. ' +
        'Set REDIS_URL (Dragonfly) for correct multi-replica behavior.',
    )
  }

  server.listen(port, hostname, () => {
    // Its own console.log, ahead of the banner and on ONE line: this is the
    // line an operator greps out of a pod log to answer "what is this pilot
    // running", and a line inside a box drawn with ━ is not greppable.
    console.log(bootLogLine(process.env))
    console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Frontend: http://localhost:${port}
  Chat:     ${BACKEND_CHAT_URL}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`)
  })

  // Graceful shutdown. `server.close()` stops accepting new connections and
  // resolves once every existing one (including WebSockets) has ended, so the
  // timer is the hard ceiling on how long a rolling update waits for this pod.
  //
  // Before exiting, run what the app registered to flush (PostHog's queued
  // exceptions, ADR-0100): `src/instrumentation.ts` pushes async functions onto
  // `globalThis.__gridShutdownHooks`, because this file cannot import it. They
  // get SHUTDOWN_HOOKS_MS, on top of the drain, and a hook that fails or hangs
  // never keeps the pod alive.
  let exiting = false
  const exitAfterHooks = () => {
    if (exiting) return
    exiting = true
    const appHooks = Array.isArray(globalThis[SHUTDOWN_HOOKS_KEY]) ? globalThis[SHUTDOWN_HOOKS_KEY] : []
    const hooks = [...appHooks, shutdownOtelMetrics]
    const ceiling = setTimeout(() => process.exit(0), SHUTDOWN_HOOKS_MS)
    Promise.allSettled(hooks.map((hook) => hook())).finally(() => {
      clearTimeout(ceiling)
      process.exit(0)
    })
  }

  const cleanExit = (signal) => {
    if (draining) return
    draining = true
    console.log(`\nShutting down (${signal}) — draining for up to ${SHUTDOWN_DRAIN_MS}ms...`)
    server.close(exitAfterHooks)
    setTimeout(exitAfterHooks, SHUTDOWN_DRAIN_MS)
  }

  process.once('SIGTERM', () => cleanExit('SIGTERM'))
  process.once('SIGINT', () => cleanExit('SIGINT'))
}

startServer().catch((err) => {
  console.error('Failed to start server:', err)
  process.exit(1)
})
