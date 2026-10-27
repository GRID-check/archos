/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { artImage } from '@/lib/art'

const mockMiddleware = vi.fn()
const mockAuthkitMiddleware = vi.fn(() => mockMiddleware)

vi.doMock('@workos-inc/authkit-nextjs', () => ({
  authkitMiddleware: mockAuthkitMiddleware,
}))

describe('AuthKit v4 proxy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockMiddleware.mockReset()
    vi.resetModules()
  })

  test('configures authkitMiddleware with public landing, AuthKit callback, and error pages allow-listed', async () => {
    await import('./proxy')

    expect(mockAuthkitMiddleware).toHaveBeenCalledWith(
      expect.objectContaining({
        middlewareAuth: expect.objectContaining({
          unauthenticatedPaths: [
            '/',
            '/api/healthz',
            '/api/auth/callback',
            '/api/auth/signin',
            '/api/auth/websocket-scope',
            '/auth/error',
            '/api/internal/(.*)',
            // The MCP server checks its own bearer token or envelope (ADR-0122);
            // the OAuth protected-resource metadata is public by RFC 9728.
            '/api/mcp',
            // The A2A server checks the same bearer token (ADR-0124).
            '/api/a2a',
            // The platform door checks a bearer token for its own audience (ADR-0126).
            '/api/platform/mcp',
            // PostHog's poke carries only a ticket id; the route re-reads the
            // thread with its own key and rate-limits (ADR-0118, second amendment).
            '/api/webhooks/posthog-support',
            '/.well-known/(.*)',
            // The image optimizer re-enters the router in-process, so
            // middleware runs on this route with a cookie-less mocked request.
            '/api/documents/(.*)/image',
          ],
        }),
      })
    )
  })

  test('leaves icons, riso art, manifest and robots.txt outside the auth redirect', async () => {
    const { config } = await import('./proxy')
    const matcher = new RegExp(`^${config.matcher[0]}$`)
    const publicFiles = [
      '/favicon.ico',
      '/icon.svg',
      '/apple-icon.png',
      '/manifest.webmanifest',
      '/robots.txt',
      '/sw.js',
      '/icons/icon-192.png',
      // by id, as the app reaches art: a literal /art/ path fails the riso check
      new URL(artImage('vignetten/bauplatz/empty').src, 'http://localhost').pathname,
    ]

    for (const path of publicFiles) expect(matcher.test(path), path).toBe(false)
    expect(matcher.test('/app/projects')).toBe(true)
  })

  // Unescaped and unanchored, `sw.js` let any path starting `sw`, one character,
  // `js` past the session; the same held for every file name in the list.
  test('lets only the exact public file names past, not paths that start like them', async () => {
    const { config } = await import('./proxy')
    const matcher = new RegExp(`^${config.matcher[0]}$`)
    for (const path of ['/sw.jsx', '/swxjs', '/sw.js/x', '/robots.txt.bak', '/favicon.ico/x', '/faviconxico', '/manifest.webmanifest/x']) {
      expect(matcher.test(path), path).toBe(true)
    }
  })

  // The SDK posts from signed-out pages and mid-expiry; AuthKit would answer a
  // beacon with a redirect to the WorkOS login page and lose the event.
  test('leaves the first-party PostHog relay outside the auth redirect', async () => {
    const { config } = await import('./proxy')
    const matcher = new RegExp(`^${config.matcher[0]}$`)

    for (const path of ['/ingest/e/', '/ingest/s/', '/ingest/flags/', '/ingest/static/recorder.js', '/ingest/array/phc_x/config.js']) {
      expect(matcher.test(path), path).toBe(false)
    }
    // Only the relay's prefix: a page that merely starts with the word is still guarded.
    expect(matcher.test('/ingestion')).toBe(true)
    expect(matcher.test('/app/ingest/x')).toBe(true)
  })

  test('delegates requests to the authkitMiddleware', async () => {
    const { default: proxy } = await import('./proxy')
    const request = { url: 'http://localhost:3000/api/v1/collections' } as never
    const event = {} as never

    await proxy(request, event)

    expect(mockMiddleware).toHaveBeenCalledWith(request, event)
  })
})

const AUTHORIZE =
  'https://api.workos.com/user_management/authorize?client_id=test&redirect_uri=https%3A%2F%2Fapp.dev.piloti.at%2Fapi%2Fauth%2Fcallback'
const VERIFIER_COOKIE = 'wos-auth-verifier-1a2b3c4d=sealed-state; Path=/; Max-Age=600; Secure; HttpOnly; SameSite=lax'

function authkitRedirect(cookies: string[] = []): Response {
  const headers = new Headers({ location: AUTHORIZE })
  for (const cookie of cookies) headers.append('set-cookie', cookie)
  return new Response(null, { status: 307, headers })
}

type ProxyResponse = Response | null | undefined | void

async function throughProxy(request: NextRequest, response: Response): Promise<ProxyResponse> {
  const { default: proxy } = await import('./proxy')
  mockMiddleware.mockResolvedValue(response)
  return proxy(request, {} as never)
}

/** The Location, resolved the way a browser reads a relative one. */
function locationOf(response: ProxyResponse): URL {
  return new URL(response?.headers.get('location') ?? '', 'https://app.dev.piloti.at')
}

/**
 * AuthKit mints the PKCE verifier cookie only when the redirect answers an
 * initial document navigation (`isInitialDocumentRequest` in its `pkce.ts`). A
 * client-side navigation is redirected to WorkOS anyway, so its callback can
 * never match code to verifier and the browser bounces: the dev loop of Oct
 * 2026, 3–5 `user_signed_in` per WorkOS session.
 */
describe('a redirect that cannot complete', () => {
  test('is replaced by our sign-in route when a client-side navigation asks for the page', async () => {
    const request = new NextRequest('https://app.dev.piloti.at/app/projects/abc/chat?_rsc=1x&tab=files', {
      headers: { accept: 'text/x-component', rsc: '1' },
    })

    const response = await throughProxy(request, authkitRedirect())

    expect(response?.status).toBe(307)
    expect(locationOf(response).pathname).toBe('/api/auth/signin')
    // The RSC cache key is not part of the page; the tab is.
    expect(locationOf(response).searchParams.get('returnPathname')).toBe('/app/projects/abc/chat?tab=files')
  })

  test('is replaced for a fetch that expects data but got a login page', async () => {
    const request = new NextRequest('https://app.dev.piloti.at/app/projects', {
      headers: { accept: 'application/json' },
    })

    const response = await throughProxy(request, authkitRedirect())

    expect(locationOf(response).pathname).toBe('/api/auth/signin')
  })

  test('is replaced even when AuthKit only clears a stale verifier', async () => {
    const request = new NextRequest('https://app.dev.piloti.at/app/projects')
    const clearing = 'wos-auth-verifier-1a2b3c4d=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=lax'

    const response = await throughProxy(request, authkitRedirect([clearing]))

    expect(locationOf(response).pathname).toBe('/api/auth/signin')
  })

  test('is answered 303 for a non-GET so the browser fetches the sign-in page with GET', async () => {
    const request = new NextRequest('https://app.dev.piloti.at/app/projects', { method: 'POST' })

    const response = await throughProxy(request, authkitRedirect())

    expect(response?.status).toBe(303)
  })

  test('carries what AuthKit was setting, and stays uncacheable', async () => {
    const request = new NextRequest('https://app.dev.piloti.at/app/projects')
    const clearing = 'wos-session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=lax'

    const response = await throughProxy(request, authkitRedirect([clearing]))

    expect(response?.headers.getSetCookie()).toEqual([clearing])
    expect(response?.headers.get('cache-control')).toBe('no-store')
  })
})

describe('a redirect that can complete', () => {
  test('is left to AuthKit when it carries the verifier cookie', async () => {
    const request = new NextRequest('https://app.dev.piloti.at/app/projects', { headers: { accept: 'text/html' } })

    const response = await throughProxy(request, authkitRedirect([VERIFIER_COOKIE]))

    expect(response?.headers.get('location')).toBe(AUTHORIZE)
  })

  test('is left alone when it is a prefetch: nobody is waiting for a login on a speculative load', async () => {
    const request = new NextRequest('https://app.dev.piloti.at/app/projects', {
      headers: { 'next-router-prefetch': '1' },
    })

    const response = await throughProxy(request, authkitRedirect())

    expect(response?.headers.get('location')).toBe(AUTHORIZE)
  })

  test('is left alone when it is not a WorkOS authorization redirect', async () => {
    const request = new NextRequest('https://app.dev.piloti.at/app/projects')
    const landing = () => new Response(null, { status: 307, headers: { location: 'https://dev.piloti.at/sign-in' } })

    const response = await throughProxy(request, landing())

    expect(response?.headers.get('location')).toBe('https://dev.piloti.at/sign-in')
  })
})

/**
 * The loop of Oct 2026 that rerouting does not explain: every callback
 * succeeded, the browser rendered nothing and started another flow. Nothing
 * said so, so the only trace was a burst of `user_signed_in` in PostHog. A
 * cookie that arrives and is still treated as anonymous now says so, and never
 * carries the sealed value.
 */
describe('a request that carries a session and is still sent to sign in', () => {
  const SESSION = 'sealed-session-value'
  const withSession = () =>
    new NextRequest('https://app.dev.piloti.at/app/projects', { headers: { cookie: `wos-session=${SESSION}` } })

  test('is reported with its size, its kind and whether the redirect can complete', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await throughProxy(withSession(), authkitRedirect([VERIFIER_COOKIE]))

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('session cookie present'),
      expect.objectContaining({
        path: '/app/projects',
        cookieBytes: SESSION.length,
        redirectCarriesVerifier: true,
      })
    )
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SESSION)
    warn.mockRestore()
  })

  test('counts a session split across chunks as one, with its whole size', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const chunked = new NextRequest('https://app.dev.piloti.at/app/projects', {
      headers: { cookie: 'wos-session.0=aaaa; wos-session.1=bb; wos-session-other=x' },
    })

    await throughProxy(chunked, authkitRedirect([VERIFIER_COOKIE]))

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('session cookie present'),
      expect.objectContaining({ cookieBytes: 6, cookieChunks: 2 })
    )
    warn.mockRestore()
  })

  test('stays quiet for a signed-out request, which is the ordinary case', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await throughProxy(
      new NextRequest('https://app.dev.piloti.at/app/projects'),
      authkitRedirect([VERIFIER_COOKIE])
    )

    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  test('stays quiet when the redirect is not to WorkOS', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const landing = new Response(null, { status: 307, headers: { location: 'https://dev.piloti.at/sign-in' } })

    await throughProxy(withSession(), landing)

    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
