// @vitest-environment node
/**
 * The AuthKit session cookie is split once it outgrows one cookie
 * (`patches/@workos-inc%2Fauthkit-nextjs@*.patch`, workos/authkit-nextjs#404).
 *
 * Dev looped through sign-in for every new browser: the sealed session carries
 * the access token, the token carries every permission and feature flag WorkOS
 * grants (18 and 33 for an admin of GRID Test), and the cookie came to about
 * 4.2 KB. A browser drops a cookie over 4096 bytes without a word, so the next
 * request had no session and AuthKit sent it back to WorkOS, which was still
 * signed in and sent it straight back.
 *
 * These run the INSTALLED package, so an upgrade that leaves the patch behind
 * fails here rather than on the next sign-in.
 */

import path from 'node:path'
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { sealData } from 'iron-session'

type CookieOptions = { maxAge?: number; path?: string; domain?: string }
type Stored = { name: string; value: string; options?: CookieOptions }

const store = new Map<string, Stored>()
const jar = {
  get: (name: string) => store.get(name),
  getAll: () => [...store.values()],
  set: (name: string, value: string, options?: CookieOptions) => {
    store.set(name, { name, value, options })
  },
  delete: (name: string | { name: string }) => {
    store.delete(typeof name === 'string' ? name : name.name)
  },
}

vi.mock('next/headers', () => ({
  cookies: async () => jar,
  headers: async () => new Headers({ 'x-url': 'https://app.dev.piloti.at/app/projects' }),
}))
// `saveSession` verifies the access token against WorkOS's JWKS before sealing it,
// with the `jose` AuthKit ships beside itself rather than ours.
vi.mock('../../../node_modules/@workos-inc/authkit-nextjs/node_modules/jose/dist/node/esm/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('jose')>()),
  createRemoteJWKSet: () => () => Promise.resolve(undefined),
  jwtVerify: async () => ({ payload: {}, protectedHeader: { alg: 'RS256' } }),
}))

const PASSWORD = 'a-test-cookie-password-of-32-chars-or-more'
const BROWSER_COOKIE_LIMIT = 4096

/** A token as large as an admin's in GRID Test, or larger. */
const accessToken = (claimBytes: number): string => {
  const encode = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'RS256' })}.${encode({ sub: 'user_1', org_id: 'org_1', padding: 'x'.repeat(claimBytes) })}.${'s'.repeat(342)}`
}
const user = { object: 'user', id: 'user_1', email: 'anna@example.com', firstName: 'Anna', lastName: 'Berger' }

type AuthKit = typeof import('@workos-inc/authkit-nextjs')
type SessionModule = { getSessionFromCookie: (request: NextRequest) => Promise<{ accessToken: string } | undefined> }
type ChunkModule = {
  appendSessionSetCookies: (
    headers: Headers,
    request: NextRequest,
    name: string,
    value: string,
    options: CookieOptions,
    serialize: (name: string, value: string, options: CookieOptions) => string,
  ) => void
}

const DIST = path.resolve(__dirname, '../../../node_modules/@workos-inc/authkit-nextjs/dist/esm')
let authkit: AuthKit
let sessionModule: SessionModule
let chunks: ChunkModule

beforeAll(async () => {
  vi.stubEnv('WORKOS_COOKIE_PASSWORD', PASSWORD)
  vi.stubEnv('WORKOS_CLIENT_ID', 'client_test')
  vi.stubEnv('WORKOS_API_KEY', 'sk_test')
  vi.stubEnv('WORKOS_REDIRECT_URI', 'https://app.dev.piloti.at/api/auth/callback')
  authkit = await import('@workos-inc/authkit-nextjs')
  sessionModule = (await import(path.join(DIST, 'session.js'))) as SessionModule
  chunks = (await import(path.join(DIST, 'session-cookie.js'))) as ChunkModule
})

beforeEach(() => store.clear())

const live = (): Stored[] => [...store.values()].filter((cookie) => cookie.options?.maxAge !== 0 && cookie.value !== '')
const expiredNames = (): string[] =>
  [...store.values()].filter((cookie) => cookie.options?.maxAge === 0).map((cookie) => cookie.name)
const cookieHeader = (cookies: Stored[]): string => cookies.map(({ name, value }) => `${name}=${value}`).join('; ')

describe('the AuthKit session cookie', () => {
  test('a session too large for one cookie is written as chunks a browser keeps', async () => {
    await authkit.saveSession({ accessToken: accessToken(3000), refreshToken: 'refresh_1', user } as never, 'https://app.dev.piloti.at')

    const written = live()
    expect(written.map(({ name }) => name)).toEqual(['wos-session.0', 'wos-session.1'])
    for (const { name, value } of written) expect(name.length + 1 + value.length).toBeLessThanOrEqual(BROWSER_COOKIE_LIMIT)
    expect(expiredNames()).toContain('wos-session')
  })

  test('and the chunks the browser sends back are read as one session', async () => {
    const token = accessToken(3000)
    await authkit.saveSession({ accessToken: token, refreshToken: 'refresh_1', user } as never, 'https://app.dev.piloti.at')
    const request = new NextRequest('https://app.dev.piloti.at/app/projects', { headers: { cookie: cookieHeader(live()) } })

    const session = await sessionModule.getSessionFromCookie(request)

    expect(session?.accessToken).toBe(token)
  })

  test('a session that fits stays one cookie, and chunks a larger one left behind expire', async () => {
    jar.set('wos-session.0', 'old')
    jar.set('wos-session.1', 'old')
    jar.set('wos-session.2', 'old')

    await authkit.saveSession({ accessToken: accessToken(200), refreshToken: 'refresh_1', user } as never, 'https://app.dev.piloti.at')

    expect(live().map(({ name }) => name)).toEqual(['wos-session'])
    expect(expiredNames().sort()).toEqual(['wos-session.0', 'wos-session.1', 'wos-session.2'])
  })

  test('a whole cookie from before the split is still read', async () => {
    const token = accessToken(200)
    const sealed = await sealData({ accessToken: token, refreshToken: 'refresh_1', user }, { password: PASSWORD })
    const request = new NextRequest('https://app.dev.piloti.at/', { headers: { cookie: `wos-session=${sealed}` } })

    expect((await sessionModule.getSessionFromCookie(request))?.accessToken).toBe(token)
  })

  test('the middleware writes the same chunks as Set-Cookie headers, and a shorter session expires the rest', () => {
    const request = new NextRequest('https://app.dev.piloti.at/', {
      headers: { cookie: 'wos-session.0=a; wos-session.1=b; wos-session.2=c' },
    })
    const headers = new Headers()

    chunks.appendSessionSetCookies(headers, request, 'wos-session', 'v'.repeat(5000), { path: '/' }, (name, value, options) =>
      `${name}=${value}; Max-Age=${options.maxAge ?? 'session'}`,
    )

    const set = headers.getSetCookie().map((cookie) => cookie.slice(0, cookie.indexOf('=')) + (cookie.includes('Max-Age=0') ? ' expired' : ''))
    expect(set).toEqual(['wos-session.0', 'wos-session.1', 'wos-session expired', 'wos-session.2 expired'])
  })
})
