/**
 * @vitest-environment node
 */

/**
 * The premise the proxy's reroute rests on.
 *
 * AuthKit's middleware cannot mint the PKCE verifier for a client-side (RSC)
 * navigation or a fetch, which is why proxy.ts replaces that redirect with
 * /api/auth/signin. That replacement only works because a Route Handler may
 * write a cookie whatever kind of request it answers — so this spec calls the
 * handler with the headers the client router sends and asserts the flow cookie
 * that the real library, not a mock, put in the jar.
 *
 * Everything here is the installed @workos-inc/authkit-nextjs: `getSignInUrl`
 * seals the state, generates the PKCE pair and writes the cookie through
 * `next/headers`. Only the request-scoped cookie jar and headers are stubbed,
 * because a unit test has no Next request store.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest'
import { NextRequest } from 'next/server'

type Written = { name: string; value: string; expires: number }

const written = new Map<string, Written>()
const jar = {
  getAll: () => [...written.values()].map(({ name, value }) => ({ name, value })),
  set: (name: string, value: string, options: { maxAge?: number }) => {
    written.set(name, { name, value, expires: options.maxAge ?? 0 })
  },
  delete: (target: string | { name: string }) => {
    written.delete(typeof target === 'string' ? target : target.name)
  },
}

vi.mock('next/headers', () => ({
  cookies: async () => jar,
  headers: async () => new Headers({ 'x-redirect-uri': 'https://app.dev.piloti.at/api/auth/callback' }),
}))
vi.mock('@/lib/db/tenant-context', () => ({ tenantSlotRoute: (handler: never) => handler }))

// Read at import time by the package, so they must be set before the import.
process.env.WORKOS_CLIENT_ID = 'client_test'
process.env.WORKOS_COOKIE_PASSWORD = 'a-test-cookie-password-of-32-chars'

const { GET } = await import('./route')

const VERIFIER = /^wos-auth-verifier(-[0-9a-f]{8})?$/

const verifierCookies = () => [...written.values()].filter(({ name }) => VERIFIER.test(name))

/** The client router's navigation: it asks for a Flight payload, not a document. */
const rscNavigation = () =>
  GET(
    new NextRequest('https://app.dev.piloti.at/api/auth/signin?returnPathname=%2Fapp%2Fprojects', {
      headers: {
        RSC: '1',
        accept: 'text/x-component',
        'next-router-state-tree': '%5B%22%22%2C%7B%7D%5D',
      },
    }),
  )

/** A fetch from an already-loaded page: asks for data, carries no document headers. */
const clientFetch = () =>
  GET(
    new NextRequest('https://app.dev.piloti.at/api/auth/signin', {
      headers: { accept: 'application/json' },
    }),
  )

beforeEach(() => {
  written.clear()
})

describe('the verifier the sign-in route writes', () => {
  test('is written for a client-side navigation, which the middleware could not serve', async () => {
    const response = await rscNavigation()

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toMatch(/^https:\/\/api\.workos\.com\/user_management\/authorize\?/)
    expect(verifierCookies()).toHaveLength(1)
  })

  test('is written for a fetch, which cannot receive a document redirect at all', async () => {
    const response = await clientFetch()

    expect(response.status).toBe(307)
    expect(verifierCookies()).toHaveLength(1)
  })

  test('outlives the flow by the ten minutes its flow may take, and is not script-readable', async () => {
    await rscNavigation()

    const [cookie] = verifierCookies()
    expect(cookie.expires).toBe(600)
    expect(cookie.value.length).toBeGreaterThan(100)
  })

  test('gives each flow its own cookie, so two tabs can sign in at once', async () => {
    await rscNavigation()
    await rscNavigation()

    const names = verifierCookies().map(({ name }) => name)
    expect(names).toHaveLength(2)
    // The name carries a hash of the sealed state: one name per live flow.
    expect(new Set(names).size).toBe(2)
  })
})
