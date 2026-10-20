/**
 * First-party relay to PostHog: what `app/ingest/[...path]/route.ts` runs.
 *
 * The browser SDK talks to this app's own origin (`/ingest/...`) and the app
 * forwards to PostHog. Blockers filter by third-party host, so a same-origin
 * path keeps a large share of the signal that would otherwise vanish, and the
 * page makes no request to a host the legal text has to name.
 *
 * Why a route handler and not the `rewrites` PostHog's Next.js guide shows:
 * a rewrite's destination is fixed in `next.config.ts` when the image is BUILT,
 * and this image is built with no environment (the PostHog host arrives per
 * deployment, at runtime, like every other value in `posthog-config.ts`). A
 * handler reads it per request.
 *
 * The relay is deliberately dumb and deliberately narrow:
 *
 * - **The host is never taken from the request.** The upstream is the configured
 *   host (or its asset sibling for `/static/*` and `/array/*`), joined by string
 *   concatenation, then checked to still be that origin. `//evil.example/x`
 *   under `/ingest` must not become a request to evil.example.
 * - **Headers are an allow-list.** The browser sends this origin's cookies to
 *   `/ingest` (the WorkOS session among them) and an `Authorization` header is
 *   conceivable; none of it may reach a third party, so only the few headers
 *   PostHog needs are forwarded. The client IP rides in `X-Forwarded-For`
 *   (PostHog docs: advanced/proxy/proxy-reference), otherwise every event would
 *   be located at this server.
 * - **The body is streamed.** Replay chunks run to megabytes.
 */

import { posthogAssetHost, POSTHOG_PROXY_PATH, type PostHogConfig } from './posthog-config'

/**
 * Request headers PostHog needs. Everything else, cookies above all, stays here.
 *
 * `x-conversations-token` is the Support widget's public token (the project's
 * `conversations_settings.widget_public_token`, which posthog-js fetches from
 * remote config and sends on every `/api/conversations/v1/widget/*` call).
 * Without it PostHog answers 403, `posthog.conversations.sendMessage` rejects,
 * and no feedback report ever became a Support ticket: the widget still loaded
 * (`$conversations_loaded`), so nothing looked broken.
 */
const FORWARDED_REQUEST_HEADERS = [
  'content-type',
  'accept',
  'accept-language',
  'user-agent',
  'x-conversations-token',
] as const

/**
 * Response headers worth returning. `content-encoding`/`content-length` are
 * excluded on purpose: `fetch` has already decoded the body, so passing the
 * upstream's values would describe bytes this response does not carry.
 */
const RETURNED_RESPONSE_HEADERS = ['content-type', 'cache-control', 'etag', 'last-modified'] as const

/** Paths PostHog Cloud serves from its asset host instead of its ingestion host. */
const ASSET_PATH = /^\/(?:static|array)(?:\/|$)/

const UPSTREAM_TIMEOUT_MS = 30_000

/**
 * The upstream URL for a request to `/ingest/...`, or `null` when it is not
 * one (wrong prefix) or would leave the configured origin.
 */
export const buildUpstreamUrl = (requestUrl: string, host: string): string | null => {
  const incoming = new URL(requestUrl)
  if (incoming.pathname !== POSTHOG_PROXY_PATH && !incoming.pathname.startsWith(`${POSTHOG_PROXY_PATH}/`)) {
    return null
  }
  // Keep the trailing slash: PostHog's endpoints are `/e/`, `/s/`, `/flags/`.
  const rest = incoming.pathname.slice(POSTHOG_PROXY_PATH.length) || '/'
  const base = (ASSET_PATH.test(rest) ? posthogAssetHost(host) : host).replace(/\/+$/, '')
  const candidate = `${base}${rest}${incoming.search}`
  try {
    return new URL(candidate).origin === new URL(base).origin ? candidate : null
  } catch {
    return null
  }
}

const forwardedHeaders = (request: Request): Headers => {
  const headers = new Headers()
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name)
    if (value) headers.set(name, value)
  }
  const clientIp = request.headers.get('x-forwarded-for') ?? request.headers.get('x-real-ip')
  if (clientIp) headers.set('x-forwarded-for', clientIp)
  return headers
}

const returnedHeaders = (upstream: Response): Headers => {
  const headers = new Headers()
  for (const name of RETURNED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name)
    if (value) headers.set(name, value)
  }
  return headers
}

/**
 * Relay one request. `404` when analytics or the proxy is off (the SDK is not
 * configured to call it then, so only a probe lands here), `502` when PostHog
 * cannot be reached (the SDK retries and then drops the batch: analytics never
 * becomes a user-facing error).
 */
export const forwardToPosthog = async (
  request: Request,
  config: PostHogConfig,
  fetchImpl: typeof fetch = fetch
): Promise<Response> => {
  if (!config.proxy || !config.host || !config.projectToken) return new Response(null, { status: 404 })
  const upstreamUrl = buildUpstreamUrl(request.url, config.host)
  if (!upstreamUrl) return new Response(null, { status: 404 })

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
  try {
    const upstream = await fetchImpl(upstreamUrl, {
      method: request.method,
      headers: forwardedHeaders(request),
      body: hasBody ? request.body : undefined,
      // Node's fetch needs this to send a streamed request body.
      ...(hasBody ? { duplex: 'half' } : {}),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    } as RequestInit)
    return new Response(upstream.body, { status: upstream.status, headers: returnedHeaders(upstream) })
  } catch {
    return new Response(null, { status: 502 })
  }
}
