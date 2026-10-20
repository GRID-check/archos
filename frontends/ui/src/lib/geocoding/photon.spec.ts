/**
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest'
import { FEDERAL_STATE_TOKENS } from '@/lib/project-profile/intake-definition'
import { parsePhotonResponse, searchPhoton } from './photon'
import {
  PHOTON_BERLIN,
  PHOTON_GRABEN,
  PHOTON_HAUPTSTRASSE,
  PHOTON_MARIAHILFER,
  PHOTON_MARIENPLATZ_MUENCHEN,
  PHOTON_MOEDLING,
} from './photon.fixtures'
import { geocodeResultSchema } from './types'

describe('parsePhotonResponse', () => {
  it('reads a Vienna POI and street: no state, the city is the Gemeinde, federal state vienna', () => {
    const [poi, street] = parsePhotonResponse(PHOTON_MARIAHILFER)
    expect(poi).toEqual({
      label: 'Museumsquartier, 1070 Wien',
      lat: 48.2027122,
      lon: 16.3612175,
      country: 'at',
      federalState: 'vienna',
      state: 'Wien',
      municipality: 'Wien',
      postcode: '1070',
      kind: 'place',
    })
    expect(street).toMatchObject({
      label: 'Mariahilfer Straße, 1060 Wien',
      lat: 48.1961665,
      lon: 16.3412897,
      federalState: 'vienna',
      kind: 'street',
    })
  })

  it('reads a town: the hit is the Gemeinde, the state label maps to the intake token', () => {
    expect(parsePhotonResponse(PHOTON_MOEDLING)).toEqual([
      {
        label: '2340 Mödling',
        lat: 48.0855922,
        lon: 16.2833526,
        country: 'at',
        federalState: 'lower_austria',
        state: 'Niederösterreich',
        municipality: 'Mödling',
        postcode: '2340',
        kind: 'place',
      },
    ])
  })

  it('writes "Straße Nr, PLZ Ort" for a house number, outside Vienna too', () => {
    const [first, second] = parsePhotonResponse(PHOTON_HAUPTSTRASSE)
    expect(first).toMatchObject({
      label: 'Hauptstraße 1, 6401 Inzing',
      federalState: 'tyrol',
      state: 'Tirol',
      municipality: 'Inzing',
      kind: 'address',
    })
    expect(second?.label).toBe('Hauptstraße 1d, 6074 Rinn')
    // a POI's name is not part of an address line
    expect(parsePhotonResponse(PHOTON_GRABEN).map((r) => r.label)).toEqual([
      'Graben 20, 1010 Wien',
      'Tiefer Graben 20, 1010 Wien',
    ])
  })

  it('drops everything outside Austria', () => {
    expect(parsePhotonResponse(PHOTON_MARIENPLATZ_MUENCHEN)).toEqual([])
    expect(parsePhotonResponse(PHOTON_BERLIN)).toEqual([])
  })

  it('dedupes by label, keeping the first', () => {
    const feature = PHOTON_MOEDLING.features[0]
    const results = parsePhotonResponse({ features: [feature, feature, ...PHOTON_GRABEN.features] })
    expect(results.map((r) => r.label)).toEqual(['2340 Mödling', 'Graben 20, 1010 Wien', 'Tiefer Graben 20, 1010 Wien'])
  })

  it('matches every Land label to its token, case and diacritics aside', () => {
    const labels = [
      ['Wien', 'vienna'], ['niederösterreich', 'lower_austria'], ['OBERÖSTERREICH', 'upper_austria'],
      ['Steiermark', 'styria'], ['Kärnten', 'carinthia'], ['Karnten', 'carinthia'], ['Salzburg', 'salzburg'],
      ['Tirol', 'tyrol'], ['Vorarlberg', 'vorarlberg'], ['Burgenland', 'burgenland'],
    ] as const
    for (const [state, token] of labels) {
      const [result] = parsePhotonResponse({
        features: [
          {
            properties: { type: 'city', name: 'Ort', state, postcode: '1234', countrycode: 'AT' },
            geometry: { coordinates: [14, 47] },
          },
        ],
      })
      expect(result?.federalState, state).toBe(token)
    }
    expect(new Set(labels.map(([, token]) => token))).toEqual(
      new Set(FEDERAL_STATE_TOKENS.filter((token) => token !== 'outside_austria')),
    )
  })

  it('leaves federalState null for a state it does not know, and keeps the raw label', () => {
    const [result] = parsePhotonResponse({
      features: [
        {
          properties: { type: 'city', name: 'Ort', state: 'Südtirol', postcode: '39100', countrycode: 'AT' },
          geometry: { coordinates: [11.3, 46.5] },
        },
      ],
    })
    expect(result).toMatchObject({ federalState: null, state: 'Südtirol' })
  })

  it('returns schema-valid results', () => {
    for (const fixture of [PHOTON_MARIAHILFER, PHOTON_MOEDLING, PHOTON_GRABEN, PHOTON_HAUPTSTRASSE]) {
      for (const result of parsePhotonResponse(fixture)) expect(geocodeResultSchema.parse(result)).toEqual(result)
    }
  })

  it('answers [] for an empty collection', () => {
    expect(parsePhotonResponse({ type: 'FeatureCollection', features: [] })).toEqual([])
  })

  it('answers [] for malformed input and skips a malformed feature without losing the rest', () => {
    for (const bad of [null, undefined, 'x', 42, [], {}, { features: 'no' }]) expect(parsePhotonResponse(bad)).toEqual([])
    const results = parsePhotonResponse({
      features: [
        null,
        { properties: { countrycode: 'AT', name: 'x' } },
        { properties: { countrycode: 'AT', name: 'x' }, geometry: { coordinates: ['a', 'b'] } },
        { properties: { countrycode: 'AT', name: 'Kein Ort' }, geometry: { coordinates: [16, 99] } },
        { properties: { countrycode: 'AT', postcode: 12 }, geometry: { coordinates: [16, 48] } },
        ...PHOTON_MOEDLING.features,
      ],
    })
    expect(results.map((r) => r.label)).toEqual(['2340 Mödling'])
  })
})

const jsonResponse = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })

describe('searchPhoton', () => {
  it('asks for German names inside the Austrian box and cuts to the limit', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(PHOTON_GRABEN))
    const results = await searchPhoton('https://photon.test', 'Graben 20 Wien', {
      limit: 1,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(results.map((r) => r.label)).toEqual(['Graben 20, 1010 Wien'])
    const url = (fetchImpl.mock.calls[0] as unknown as [URL])[0]
    expect(url.origin + url.pathname).toBe('https://photon.test/api/')
    expect(url.searchParams.get('q')).toBe('Graben 20 Wien')
    expect(url.searchParams.get('lang')).toBe('de')
    expect(url.searchParams.get('bbox')).toBe('9.53,46.37,17.16,49.02')
    expect(Number(url.searchParams.get('limit'))).toBeGreaterThanOrEqual(1)
  })

  it('keeps a path prefix on the base URL', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(PHOTON_MOEDLING))
    await searchPhoton('https://geo.test/photon', 'Mödling', { fetchImpl: fetchImpl as unknown as typeof fetch })
    expect((fetchImpl.mock.calls[0] as unknown as [URL])[0].pathname).toBe('/photon/api/')
  })

  it('follows a redirect on the same origin and refuses one to another host', async () => {
    const same = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: '/photon/api/?q=x' } }))
      .mockResolvedValueOnce(jsonResponse(PHOTON_MOEDLING))
    expect(await searchPhoton('https://geo.test', 'Mödling', { fetchImpl: same as unknown as typeof fetch })).toHaveLength(1)

    const other = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://evil.test/api/' } }))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(await searchPhoton('https://geo.test', 'Mödling', { fetchImpl: other as unknown as typeof fetch })).toEqual([])
    expect(other).toHaveBeenCalledTimes(1)
  })

  it('never throws: a refusal, a network error, bad JSON and an abort all give []', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const cases: Array<typeof fetch> = [
      (async () => new Response('nope', { status: 503 })) as typeof fetch,
      (async () => {
        throw new TypeError('fetch failed')
      }) as typeof fetch,
      (async () => new Response('<html>', { status: 200 })) as typeof fetch,
    ]
    for (const fetchImpl of cases) expect(await searchPhoton('https://geo.test', 'Wien', { fetchImpl })).toEqual([])

    const controller = new AbortController()
    controller.abort()
    const aborting = (async (_url: unknown, init?: RequestInit) => {
      init?.signal?.throwIfAborted()
      return jsonResponse(PHOTON_MOEDLING)
    }) as typeof fetch
    expect(await searchPhoton('https://geo.test', 'Wien', { fetchImpl: aborting, signal: controller.signal })).toEqual([])
  })
})
