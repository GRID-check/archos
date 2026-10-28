/**
 * @vitest-environment node
 */
/**
 * `GET /api/geocode`, driven through the TYPED CLIENT (ADR-0055): the project
 * creation dialog uses the same `createGeocodingClient`, so a path or a field
 * the two disagreed on would fail here. The provider is a stubbed `fetch`
 * answering with Photon responses captured from photon.komoot.io.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const SESSION = vi.hoisted(() => ({
  userId: 'user_1',
  organizationId: 'org_1',
  organizationMembershipId: 'om_1',
  email: 'anna@example.test',
  name: 'Anna Berger',
  role: 'member',
  permissions: [] as string[],
}))

vi.mock('@/lib/auth/require-auth', () => ({ requireAuthorizedSession: vi.fn(async () => SESSION) }))

import { createGeocodingClient, GeocodingRequestError } from '@/lib/geocoding/client'
import { PHOTON_MARIAHILFER, PHOTON_MARIENPLATZ_MUENCHEN, PHOTON_MOEDLING } from '@/lib/geocoding/photon.fixtures'
import { GET } from './route'

const client = createGeocodingClient((path, init) => GET(new Request(new URL(path, 'https://grid.test'), init)))

const stubProvider = (body: unknown) => {
  const provider = vi.fn(async () => new Response(JSON.stringify(body)))
  vi.stubGlobal('fetch', provider)
  return provider
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('GET /api/geocode', () => {
  it('answers { enabled: false, results: [] } with 200 when no geocoder is configured', async () => {
    vi.stubEnv('GEOCODER_URL', '')
    const provider = stubProvider(PHOTON_MOEDLING)
    expect(await client.search('Mödling')).toEqual({ enabled: false, results: [] })
    expect(provider).not.toHaveBeenCalled()
  })

  it('returns the provider’s Austrian hits as typed results', async () => {
    vi.stubEnv('GEOCODER_URL', 'https://photon.test')
    const provider = stubProvider(PHOTON_MARIAHILFER)
    const response = await client.search('Mariahilfer Straße 10 Wien', 2)
    expect(response.enabled).toBe(true)
    expect(response.results.map((r) => [r.label, r.federalState, r.kind])).toEqual([
      ['Museumsquartier, 1070 Wien', 'vienna', 'place'],
      ['Mariahilfer Straße, 1060 Wien', 'vienna', 'street'],
    ])
    const url = (provider.mock.calls[0] as unknown as [URL])[0]
    expect(url.searchParams.get('q')).toBe('Mariahilfer Straße 10 Wien')
  })

  it('trims the query and defaults the limit', async () => {
    vi.stubEnv('GEOCODER_URL', 'https://photon.test')
    const provider = stubProvider(PHOTON_MOEDLING)
    await client.search('  Mödling  ')
    const url = (provider.mock.calls[0] as unknown as [URL])[0]
    expect(url.searchParams.get('q')).toBe('Mödling')
    expect(url.searchParams.get('limit')).toBe('10')
  })

  it('never returns a hit outside Austria', async () => {
    vi.stubEnv('GEOCODER_URL', 'https://photon.test')
    stubProvider(PHOTON_MARIENPLATZ_MUENCHEN)
    expect(await client.search('Marienplatz 1 München')).toEqual({ enabled: true, results: [] })
  })

  it('answers 200 with no results when the provider is down', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.stubEnv('GEOCODER_URL', 'https://photon.test')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 502 })))
    expect(await client.search('Mödling')).toEqual({ enabled: true, results: [] })
  })

  it.each([
    ['too short', 'ab', undefined],
    ['blank', '   ', undefined],
    ['too long', 'x'.repeat(201), undefined],
    ['limit 0', 'Mödling', 0],
    ['limit 9', 'Mödling', 9],
    ['limit 1.5', 'Mödling', 1.5],
  ])('answers 400 for a bad query: %s', async (_name, q, limit) => {
    vi.stubEnv('GEOCODER_URL', 'https://photon.test')
    const provider = stubProvider(PHOTON_MOEDLING)
    const error = await client.search(q, limit).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(GeocodingRequestError)
    expect(error).toMatchObject({ status: 400, code: 'BAD_REQUEST' })
    expect(provider).not.toHaveBeenCalled()
  })

  it('answers 400 when q is missing altogether', async () => {
    const response = await GET(new Request('https://grid.test/api/geocode'))
    expect(response.status).toBe(400)
  })
})
