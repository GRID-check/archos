/**
 * Sign-in entry route.
 *
 * Regression cover for the RSC cookie-write bug: /?sign-in used to resolve
 * the AuthKit authorization URL inside the root page's Server Component
 * render — where cookies().set() is forbidden — and every visit threw into
 * the app-wide error boundary instead of reaching WorkOS. The page now only
 * redirects here; this handler performs the actual sign-in initiation in a
 * Route Handler, the context where AuthKit's PKCE cookie write is legal.
 *
 * It is also where the proxy sends a navigation that AuthKit's own middleware
 * redirected without a verifier cookie, carrying the page to come back to.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const SIGN_IN_URL = 'https://api.workos.com/user_management/authorize?client_id=test&screen_hint=sign-in'
const getSignInUrl = vi.fn<(options?: { returnTo?: string }) => Promise<string>>()

type StoredCookie = { name: string; value: string }
const jar = {
  getAll: vi.fn<() => StoredCookie[]>(() => []),
  delete: vi.fn<(name: string) => void>(),
}

vi.mock('@workos-inc/authkit-nextjs', () => ({
  getSignInUrl: (options?: { returnTo?: string }) => getSignInUrl(options),
}))
vi.mock('next/headers', () => ({ cookies: async () => jar }))
vi.mock('@/lib/db/tenant-context', () => ({ tenantSlotRoute: (handler: never) => handler }))

const { GET } = await import('./route')

const signIn = (url = 'https://app.dev.piloti.at/api/auth/signin') => GET(new NextRequest(url))
const verifier = (index: number): StoredCookie => ({ name: `wos-auth-verifier-${index}`, value: 'sealed' })

beforeEach(() => {
  getSignInUrl.mockReset()
  jar.getAll.mockReset()
  jar.getAll.mockReturnValue([])
  jar.delete.mockReset()
})

describe('GET /api/auth/signin', () => {
  test('redirects to the WorkOS authorization URL', async () => {
    getSignInUrl.mockResolvedValue(SIGN_IN_URL)

    const response = await signIn()

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe(SIGN_IN_URL)
  })

  test('carries the page the proxy was asked for into returnTo', async () => {
    getSignInUrl.mockResolvedValue(SIGN_IN_URL)

    await signIn(`https://app.dev.piloti.at/api/auth/signin?returnPathname=${encodeURIComponent('/app/projects/abc')}`)

    expect(getSignInUrl).toHaveBeenCalledWith({ returnTo: '/app/projects/abc' })
  })

  test('drops an off-origin returnPathname rather than becoming an open redirect', async () => {
    getSignInUrl.mockResolvedValue(SIGN_IN_URL)

    await signIn(`https://app.dev.piloti.at/api/auth/signin?returnPathname=${encodeURIComponent('https://evil.example')}`)

    expect(getSignInUrl).toHaveBeenCalledWith({})
  })

  test('never returns a person to an API path', async () => {
    getSignInUrl.mockResolvedValue(SIGN_IN_URL)

    await signIn(`https://app.dev.piloti.at/api/auth/signin?returnPathname=${encodeURIComponent('/api/v1/projects')}`)

    expect(getSignInUrl).toHaveBeenCalledWith({})
  })

  test('propagates an AuthKit failure as a thrown error, not a silent bounce', async () => {
    getSignInUrl.mockRejectedValue(new Error('WORKOS_REDIRECT_URI missing'))

    await expect(signIn()).rejects.toThrow('WORKOS_REDIRECT_URI missing')
  })

  /**
   * The proxy sends every unauthenticated client navigation here, and AuthKit
   * mints a verifier cookie per attempt that outlives the flow by ten minutes.
   * Without the budget the loop would fill the cookie jar and end at a 431.
   */
  describe('the verifier cookies earlier attempts left behind', () => {
    test('are left alone while a few flows could still be live', async () => {
      jar.getAll.mockReturnValue([verifier(1), verifier(2)])
      getSignInUrl.mockResolvedValue(SIGN_IN_URL)

      await signIn()

      expect(jar.delete).not.toHaveBeenCalled()
    })

    test('are expired at the budget, so the next attempt cannot hit a header limit', async () => {
      jar.getAll.mockReturnValue([verifier(1), verifier(2), verifier(3), verifier(4), verifier(5)])
      getSignInUrl.mockResolvedValue(SIGN_IN_URL)

      await signIn()

      expect(jar.delete.mock.calls.map(([name]) => name)).toEqual([
        'wos-auth-verifier-1',
        'wos-auth-verifier-2',
        'wos-auth-verifier-3',
        'wos-auth-verifier-4',
        'wos-auth-verifier-5',
      ])
      // The mint for this attempt still happens, after the sweep: a sweep that
      // ran afterwards would expire the cookie it had just written.
      expect(getSignInUrl).toHaveBeenCalledWith({})
      expect(jar.delete.mock.invocationCallOrder.at(-1)).toBeLessThan(getSignInUrl.mock.invocationCallOrder[0])
    })

    test('leave a cookie that is not a verifier alone', async () => {
      jar.getAll.mockReturnValue([
        verifier(1),
        verifier(2),
        verifier(3),
        verifier(4),
        verifier(5),
        { name: 'wos-session', value: 'sealed-session' },
      ])
      getSignInUrl.mockResolvedValue(SIGN_IN_URL)

      await signIn()

      expect(jar.delete.mock.calls.map(([name]) => name)).not.toContain('wos-session')
    })
  })
})
