/**
 * Next.js Proxy for WorkOS AuthKit v4 Session Management
 *
 * Uses authkitProxy from @workos-inc/authkit-nextjs to:
 * - Decrypt and refresh the encrypted WorkOS session cookie
 * - Attach the encrypted session to downstream requests via the internal
 *   x-workos-session header
 * - Enforce authentication on protected routes when REQUIRE_AUTH=true
 * - Replace an AuthKit authorization redirect that would fail (no PKCE
 *   verifier cookie) with our own sign-in route; see
 *   {@link rerouteIncompleteSignIn}
 *
 * The Python backend receives the raw WorkOS access token from the v1 API
 * route proxy, which reads the session with withAuth() and forwards it as
 * Authorization: Bearer <access_token>.
 */

import { authkitMiddleware } from '@workos-inc/authkit-nextjs'
import { NextResponse, type NextFetchEvent, type NextRequest } from 'next/server'
import { isAuthRequired } from '@/lib/auth/auth-required'

const middleware = authkitMiddleware({
  debug: process.env.NODE_ENV === 'development',
  middlewareAuth: {
    enabled: isAuthRequired(),
    unauthenticatedPaths: [
      // Root redirect page (sends logged-out visitors to the public landing
      // site via GRID_LANDING_URL). AuthKit compiles these paths with
      // path-to-regexp (anchored), so '/' matches only the root.
      '/',
      // Liveness probe — must return 200 even when auth is required, so the
      // container / Coolify / Traefik health check never redirects to login.
      '/api/healthz',
      '/api/auth/callback',
      // Sign-in entry point behind /?sign-in (the landing site's "Anmelden"
      // target). Like the callback it runs BEFORE a session exists — it mints
      // the AuthKit authorization redirect and its PKCE cookie. Without this
      // entry middlewareAuth would intercept it and 303 to WorkOS itself,
      // bypassing the handler.
      '/api/auth/signin',
      '/api/auth/websocket-scope',
      '/auth/error',
      // Internal service-to-service endpoints (e.g. the backend agent's
      // `remember` tool). These carry no WorkOS session cookie; each route
      // enforces its own shared-token auth (X-Grid-Internal-Token). Without
      // this entry AuthKit 303-redirects the POST to WorkOS sign-in.
      '/api/internal/(.*)',
      // The agent door (ADR-0122): the MCP endpoint and the OAuth discovery
      // documents an MCP client fetches before it has any credential. Clients
      // carry no AuthKit cookie; `/api/mcp` authenticates itself, a WorkOS
      // bearer token for an external agent or the signed request-context
      // envelope for Piloti, and the `.well-known` documents are public by
      // specification (RFC 9728).
      '/api/mcp',
      // The A2A door (ADR-0124): authenticates itself with the same bearer
      // token as `/api/mcp`; the agent card is under `.well-known`.
      '/api/a2a',
      // The platform door (ADR-0126): the operator console's MCP server.
      // Authenticates itself with a bearer token for its own audience, issued
      // in the GRID Platform organization; every operation's route still
      // checks its `platform:*` permission.
      '/api/platform/mcp',
      // PostHog Support's poke that a feedback ticket has a new message
      // (ADR-0118, second amendment). PostHog carries no session; the route
      // reads nothing from the body but a ticket id and reads the thread back
      // from PostHog with the server's key, so a forged poke can only make it
      // re-read a real ticket. Rate limited in the route.
      '/api/webhooks/posthog-support',
      '/.well-known/(.*)',
      // Signed document images. `_next/image` is excluded from the matcher
      // below, but the optimizer does not fetch the underlying route over the
      // network — it re-enters the router server handler in-process, so
      // middleware DOES run on it, with a mocked request that carries no
      // cookies. Without this entry AuthKit 303-redirects our own optimizer to
      // WorkOS sign-in and every document image breaks. The route is not
      // unguarded: it verifies the HMAC signature on the URL itself
      // (`@/lib/images/signed-image-url`), which is the same shape of argument
      // as the internal endpoints above.
      '/api/documents/(.*)/image',
    ],
  },
})

export default async function proxy(request: NextRequest, event: NextFetchEvent) {
  const response = await middleware(request, event)
  if (!response) return response
  warnIfSessionIsDiscarded(request, response)
  return rerouteIncompleteSignIn(request, response)
}

/**
 * A request that carries a session cookie and is still sent to sign in has two
 * causes. Usually the cookie is stale: it expired, or a refresh failed and
 * AuthKit is clearing it on the way — once a week per person, and correct.
 * The other is a cookie that is unusable in a way that outlives every new
 * login, which is the loop dev lived in: 17 successful callbacks in a minute,
 * no page rendered, nothing logged, because AuthKit treats "cookie present but
 * unreadable" as anonymous on purpose.
 *
 * The line names the size and whether the redirect could complete, which is
 * what tells those two apart on the next occurrence. It never carries the
 * value: that is the session.
 */
const SESSION_COOKIE_NAME = process.env.WORKOS_COOKIE_NAME || 'wos-session'

/**
 * The session's cookies as the browser sent them: the whole cookie, or the
 * chunks a session too large for one is split into (`<name>.0`, `<name>.1`, …,
 * patches/@workos-inc%2Fauthkit-nextjs@*.patch).
 */
const SESSION_CHUNK_PREFIX = `${SESSION_COOKIE_NAME}.`

function isSessionCookie(name: string): boolean {
  if (name === SESSION_COOKIE_NAME) return true
  return name.startsWith(SESSION_CHUNK_PREFIX) && /^\d+$/.test(name.slice(SESSION_CHUNK_PREFIX.length))
}

function sessionCookies(request: NextRequest): { name: string; value: string }[] {
  return request.cookies.getAll().filter(({ name }) => isSessionCookie(name))
}

function warnIfSessionIsDiscarded(request: NextRequest, response: Response): void {
  if (!isAuthorizeRedirect(response.headers.get('location'))) return
  const cookies = sessionCookies(request)
  if (cookies.length === 0) return

  console.warn('[auth] session cookie present, but AuthKit is sending the request to sign in again', {
    path: request.nextUrl.pathname,
    cookieBytes: cookies.reduce((bytes, { value }) => bytes + value.length, 0),
    cookieChunks: cookies.length,
    redirectCarriesVerifier: carriesVerifierCookie(response),
    requestKind: request.headers.get('rsc') === '1' ? 'rsc' : request.headers.get('accept') ?? 'unknown',
  })
}

/**
 * AuthKit sends an unauthenticated request to WorkOS, but it mints the PKCE
 * verifier cookie only when that redirect answers an initial document
 * navigation (`isInitialDocumentRequest` in authkit's `pkce.ts`). A client-side
 * navigation asks for the RSC payload instead, and a fetch asks for data: in
 * both, WorkOS gets the redirect, the callback gets no verifier, and
 * `handleAuth` answers "Sign-in session could not be verified".
 *
 * The client router then makes it worse, and this is the loop dev lived in. It
 * does not retry the page it was loading: a redirected RSC fetch whose answer is
 * not a Flight payload becomes an MPA navigation to the *redirect target*
 * (`doMpaNavigation(responseUrl)` in `fetch-server-response.js`), so the browser
 * goes straight to WorkOS and the flow starts that was never given a verifier.
 *
 * A redirect that cannot complete is therefore replaced with our own sign-in
 * route: a Route Handler, where `cookies().set()` writes the verifier whatever
 * kind of request it answers, so the same-origin hop hands the browser the
 * cookie before it continues to WorkOS. Prefetches are left alone — nobody is
 * waiting for a login on a speculative load, and minting a cookie per prefetch
 * would burn AuthKit's five-cookie budget.
 */
const SIGN_IN_PATH = '/api/auth/signin'
const AUTHORIZE_PATH_SUFFIX = '/user_management/authorize'
const VERIFIER_COOKIE_PREFIX = 'wos-auth-verifier'

function isAuthorizeRedirect(location: string | null): boolean {
  if (!location) return false
  try {
    return new URL(location).pathname.endsWith(AUTHORIZE_PATH_SUFFIX)
  } catch {
    return false
  }
}

/**
 * Did AuthKit's response hand the browser the cookie this flow will need back?
 * A deletion (`name=; Max-Age=0`) names the cookie without providing one, so an
 * empty value does not count: the callback would still find nothing to verify.
 */
function carriesVerifierCookie(response: Response): boolean {
  return response.headers.getSetCookie().some((cookie) => {
    const [pair] = cookie.split(';', 1)
    const separator = pair.indexOf('=')
    if (separator < 0) return false
    const name = pair.slice(0, separator).trim()
    const value = pair.slice(separator + 1).trim()
    const isVerifier = name === VERIFIER_COOKIE_PREFIX || name.startsWith(`${VERIFIER_COOKIE_PREFIX}-`)
    return isVerifier && value !== ''
  })
}

function isPrefetch(request: NextRequest): boolean {
  return (
    request.headers.get('purpose') === 'prefetch' ||
    (request.headers.get('sec-purpose') ?? '').includes('prefetch') ||
    request.headers.has('next-router-prefetch')
  )
}

/**
 * Where to send the person back to: the page this request is for. The `_rsc`
 * cache key is not part of the page, and an API path is a fetch from a page
 * rather than a place a person was going.
 */
function returnPathnameFor(request: NextRequest): string | null {
  const { pathname, searchParams } = request.nextUrl
  if (pathname.startsWith('/api/')) return null

  const params = new URLSearchParams(searchParams)
  params.delete('_rsc')
  const query = params.toString()
  return query ? `${pathname}?${query}` : pathname
}

function rerouteIncompleteSignIn(request: NextRequest, response: Response): Response {
  if (response.status < 300 || response.status >= 400) return response
  if (!isAuthorizeRedirect(response.headers.get('location'))) return response
  if (carriesVerifierCookie(response)) return response
  if (isPrefetch(request)) return response

  const returnPathname = returnPathnameFor(request)
  const query = returnPathname ? `?returnPathname=${encodeURIComponent(returnPathname)}` : ''

  // A relative Location: `request.url` is the internal address behind
  // Traefik, exactly as the callback route's baseURL comment warns.
  const rerouted = new NextResponse(null, {
    status: request.method === 'GET' || request.method === 'HEAD' ? 307 : 303,
    headers: { location: `${SIGN_IN_PATH}${query}` },
  })
  // The response we are replacing may be clearing an expired session cookie;
  // carry that, and stay as uncacheable as AuthKit's own redirect.
  for (const cookie of response.headers.getSetCookie()) rerouted.headers.append('set-cookie', cookie)
  rerouted.headers.set('cache-control', 'no-store')
  return rerouted
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico, icon.svg, apple-icon.png, manifest.webmanifest, robots.txt, sw.js
     *   and icons/ (app/ file conventions and public/icons). Each file name is
     *   escaped and anchored (`sw\.js$`): unanchored, `sw.js` also let
     *   `/sw.jsx`, `/swxjs` and `/sw.js/anything` past the session. `sw.js` is the
     *   notification worker: a browser re-fetches it with or without a session,
     *   and an AuthKit redirect to WorkOS would read as a failed update: a signed-out
     *   browser, a crawler or the sign-in page's own tab must get them rather
     *   than a redirect to WorkOS
     * - art/ (public/art, the riso prints): the not-found page shows one, and
     *   a signed-out visitor sees that page too
     * - public folder
     * - ingest/ (the first-party PostHog relay, `app/ingest/[...path]/route.ts`):
     *   the SDK posts from signed-out pages and mid-expiry, where an AuthKit
     *   redirect to WorkOS would answer a beacon with a login page, and the
     *   proxy would buffer megabyte-sized replay bodies against
     *   `proxyClientMaxBodySize`. The route is `publicApiRoute` and forwards no
     *   cookie or credential.
     * - api/internal/signed/ (the RFC 9421 signed internal routes,
     *   `internalApiRoute` with `auth.signature`): a caller outside the cluster
     *   pushes a raw body there, and a proxied body is buffered and, above
     *   `proxyClientMaxBodySize`, handed to the route cut short without an
     *   error. Skipping the proxy hands the route the unbuffered stream, which
     *   `lib/api/bounded-body.ts` holds to the signed length and digest. The
     *   routes authenticate themselves before reading a byte and carry no
     *   session, so AuthKit has nothing to do there. Only this sub-path: the
     *   token-guarded `/api/internal/*` routes stay on the matcher.
     *
     * API auth routes are allow-listed via middlewareAuth.unauthenticatedPaths
     * so AuthKit can complete the OAuth callback without a session.
     *
     * `api/healthz` is excluded from the matcher entirely: the liveness probe
     * must answer 200 purely on "is the Node server up", independent of AuthKit
     * (which otherwise throws on every request when WORKOS_REDIRECT_URI is
     * unset/misconfigured — turning a config gap into a container that never
     * goes healthy).
     */
    '/((?!_next/static|_next/image|favicon\\.ico$|icon\\.svg$|apple-icon\\.png$|manifest\\.webmanifest$|robots\\.txt$|sw\\.js$|icons/|art/|public|api/healthz|ingest/|api/internal/signed/).*)',
  ],
}
