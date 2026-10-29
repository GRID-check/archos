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
const getSignInUrl = vi.fn<(options?: { returnTo?: string; loginHint?: string }) => Promise<string>>()

vi.mock('@workos-inc/authkit-nextjs', () => ({
  getSignInUrl: (options?: { returnTo?: string; loginHint?: string }) => getSignInUrl(options),
}))
vi.mock('@/lib/db/tenant-context', () => ({ tenantSlotRoute: (handler: never) => handler }))

const { GET } = await import('./route')

const signIn = (url = 'https://app.dev.piloti.at/api/auth/signin') => GET(new NextRequest(url))

beforeEach(() => {
  getSignInUrl.mockReset()
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

  test('passes the e-mail from the website login form on as loginHint', async () => {
    getSignInUrl.mockResolvedValue(SIGN_IN_URL)

    await signIn(`https://app.dev.piloti.at/api/auth/signin?loginHint=${encodeURIComponent('anna@buero.at')}`)

    expect(getSignInUrl).toHaveBeenCalledWith({ loginHint: 'anna@buero.at' })
  })

  test('drops a loginHint that is not an e-mail address', async () => {
    getSignInUrl.mockResolvedValue(SIGN_IN_URL)

    await signIn(`https://app.dev.piloti.at/api/auth/signin?loginHint=${encodeURIComponent('not an address')}`)

    expect(getSignInUrl).toHaveBeenCalledWith({})
  })

  test('propagates an AuthKit failure as a thrown error, not a silent bounce', async () => {
    getSignInUrl.mockRejectedValue(new Error('WORKOS_REDIRECT_URI missing'))

    await expect(signIn()).rejects.toThrow('WORKOS_REDIRECT_URI missing')
  })
})
