/**
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const { CallbackError, authkit, authkitOptions, captureServer } = vi.hoisted(() => {
  /**
   * What AuthKit exports for `onError` to tell a lost flow from a failed
   * exchange. The real code is a union; a string here also lets a test hand
   * over a code the module does not enumerate.
   */
  class CallbackError extends Error {
    readonly code: string

    constructor(code: string) {
      super(code)
      this.name = 'CallbackError'
      this.code = code
    }
  }

  return {
    CallbackError,
    authkit: vi.fn(async (_request: Request) => new Response('authkit', { status: 307 })),
    authkitOptions: {} as {
      onSuccess?: (data: unknown) => void | Promise<void>
      onError?: (params: { error?: unknown; request: NextRequest }) => Response | Promise<Response>
    },
    captureServer: vi.fn(() => true),
  }
})
vi.mock('@workos-inc/authkit-nextjs', () => ({
  CallbackError,
  handleAuth: (options: typeof authkitOptions) => {
    authkitOptions.onSuccess = options.onSuccess
    authkitOptions.onError = options.onError
    return authkit
  },
}))
vi.mock('@/lib/analytics/posthog-server', () => ({ captureServer }))

import { GET } from './route'

afterEach(() => {
  vi.restoreAllMocks()
  authkit.mockClear()
  captureServer.mockClear()
})

describe('/api/auth/callback', () => {
  it('sends a request with no code and no state to sign in, without an error (#724)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'debug').mockImplementation(() => undefined)

    const res = await GET(
      new NextRequest('https://app.piloti.at/api/auth/callback', {
        headers: { 'user-agent': 'meta-externalagent/1.1' },
      })
    )

    expect(res.status).toBe(307)
    expect(new URL(res.headers.get('location') ?? '').pathname).toBe('/api/auth/signin')
    expect(authkit).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  it('hands a returning sign-in to AuthKit', async () => {
    await GET(new NextRequest('https://app.piloti.at/api/auth/callback?code=c&state=s'))
    expect(authkit).toHaveBeenCalledTimes(1)
  })

  it('hands a flow that came back with state but no code to AuthKit, which clears its PKCE cookie', async () => {
    await GET(new NextRequest('https://app.piloti.at/api/auth/callback?state=s&error=access_denied'))
    expect(authkit).toHaveBeenCalledTimes(1)
  })

  describe('user_signed_in (PostHog)', () => {
    const signedIn = (createdAt: string): Promise<void> | void =>
      authkitOptions.onSuccess?.({
        user: { id: 'user_1', createdAt },
        organizationId: 'org_1',
        authenticationMethod: 'GoogleOAuth',
      })

    it('reports the sign-in as the WorkOS user, in their organization, with the method', async () => {
      await signedIn(new Date(Date.now() - 30 * 24 * 3_600_000).toISOString())

      expect(captureServer).toHaveBeenCalledWith({
        event: 'user_signed_in',
        distinctId: 'user_1',
        organizationId: 'org_1',
        properties: { method: 'GoogleOAuth', is_new_user: false },
      })
    })

    it('flags an account created minutes ago as a new user', async () => {
      await signedIn(new Date(Date.now() - 60_000).toISOString())

      expect(captureServer).toHaveBeenCalledWith(
        expect.objectContaining({ properties: expect.objectContaining({ is_new_user: true }) })
      )
    })

    it('sends no new-user flag when WorkOS gave no usable creation time', async () => {
      await signedIn('not a date')

      const sent = (captureServer.mock.calls[0] as unknown as [{ properties: Record<string, unknown> }])[0]
      expect(sent.properties.is_new_user).toBeUndefined()
    })

    it('carries no email, name or token', async () => {
      await authkitOptions.onSuccess?.({
        user: { id: 'user_1', createdAt: new Date().toISOString(), email: 'a@b.at', firstName: 'Anna' },
        accessToken: 'jwt',
        refreshToken: 'refresh',
        organizationId: 'org_1',
      })

      expect(JSON.stringify(captureServer.mock.calls)).not.toMatch(/a@b\.at|Anna|jwt|refresh/)
    })
  })

  /**
   * AuthKit deletes the flow's verifier cookie before answering, so reloading a
   * failed callback URL reproduces the failure. Its generic 500 leaves the
   * person with a dead end; our own page can say what happened and offer Try
   * Again. The page is a page — never a redirect back into the flow — so it
   * cannot loop.
   */
  describe('a sign-in that failed', () => {
    const failure = async (error: unknown): Promise<string | null> => {
      const response = await authkitOptions.onError?.({
        error,
        request: new NextRequest('https://app.piloti.at/api/auth/callback?code=c&state=s'),
      })
      const location = new URL(response?.headers.get('location') ?? '', 'https://app.piloti.at')
      expect(location.pathname).toBe('/auth/error')
      return location.searchParams.get('error')
    }

    it('sends a flow whose verifier is gone to our page, which offers Try Again', async () => {
      expect(await failure(new CallbackError('missing_pkce_cookie'))).toBe('SessionExpired')
    })

    it('treats a collided flow the same way: both need a fresh sign-in', async () => {
      expect(await failure(new CallbackError('oauth_state_mismatch'))).toBe('SessionExpired')
    })

    it('keeps the generic answer for a failure the person cannot act on', async () => {
      expect(await failure(new CallbackError('missing_tokens'))).toBe('Default')
      expect(await failure(new Error('boom'))).toBe('Default')
    })
  })
})
