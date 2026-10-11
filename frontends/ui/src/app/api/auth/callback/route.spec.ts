/**
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const { authkit, authkitOptions, captureServer } = vi.hoisted(() => ({
  authkit: vi.fn(async (_request: Request) => new Response('authkit', { status: 307 })),
  authkitOptions: {} as { onSuccess?: (data: unknown) => void | Promise<void> },
  captureServer: vi.fn(() => true),
}))
vi.mock('@workos-inc/authkit-nextjs', () => ({
  handleAuth: (options: typeof authkitOptions) => {
    authkitOptions.onSuccess = options.onSuccess
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
})
