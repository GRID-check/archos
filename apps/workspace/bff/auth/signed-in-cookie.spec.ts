/**
 * @vitest-environment node
 */
import { describe, expect, test } from 'vitest'
import { serializeSignedInCookie, signedInCookieScope } from './signed-in-cookie'

const PROD = { redirectUri: 'https://app.example.com/api/auth/callback', landingUrl: 'https://example.com', sessionMaxAge: undefined }

describe('signedInCookieScope', () => {
  test('lives on the website domain when the app is its subdomain', () => {
    expect(signedInCookieScope(PROD)).toEqual({ domain: 'example.com', secure: true, maxAgeSeconds: 60 * 60 * 24 * 400 })
  })

  test('is host-only when both share a host, as in local development', () => {
    const scope = signedInCookieScope({
      redirectUri: 'http://localhost:3000/api/auth/callback',
      landingUrl: 'http://localhost:4321',
      sessionMaxAge: undefined,
    })
    expect(scope).toEqual(expect.objectContaining({ domain: undefined, secure: false }))
  })

  test('does not exist when the website cannot see a cookie of the app', () => {
    expect(signedInCookieScope({ ...PROD, landingUrl: 'https://other.org' })).toBeNull()
    // A host that merely ends like the website is not its subdomain.
    expect(signedInCookieScope({ ...PROD, redirectUri: 'https://appexample.com/api/auth/callback' })).toBeNull()
    expect(signedInCookieScope({ ...PROD, landingUrl: undefined })).toBeNull()
    expect(signedInCookieScope({ ...PROD, redirectUri: 'not a url' })).toBeNull()
  })

  test('lives as long as the session cookie when its lifetime is configured', () => {
    expect(signedInCookieScope({ ...PROD, sessionMaxAge: '3600' })?.maxAgeSeconds).toBe(3600)
    expect(signedInCookieScope({ ...PROD, sessionMaxAge: 'nonsense' })?.maxAgeSeconds).toBe(60 * 60 * 24 * 400)
  })
})

describe('serializeSignedInCookie', () => {
  const scope = { domain: 'example.com', secure: true, maxAgeSeconds: 3600 }

  test('says only "1", readable by the website script, on the parent domain', () => {
    const cookie = serializeSignedInCookie(scope, true)
    expect(cookie).toBe('signed_in=1; Path=/; Max-Age=3600; SameSite=Lax; Domain=example.com; Secure')
    expect(cookie).not.toContain('HttpOnly')
  })

  // A deletion that names another Domain or Path than the cookie was set with
  // leaves the original in the browser.
  test('clears with the same Domain and Path it was set with', () => {
    expect(serializeSignedInCookie(scope, false)).toBe(
      'signed_in=; Path=/; Max-Age=0; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Domain=example.com; Secure'
    )
  })
})
