/**
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { PHOTON_MOEDLING } from './photon.fixtures'
import { searchAddresses } from './service'

const QUERY = { q: 'Mödling', limit: 5 }

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('searchAddresses', () => {
  it('is off without GEOCODER_URL and calls nothing', async () => {
    vi.stubEnv('GEOCODER_URL', '')
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    expect(await searchAddresses(QUERY)).toEqual({ enabled: false, results: [] })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('is off for a value that is not an http(s) URL', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    for (const value of ['photon', 'ftp://photon.test', '   ']) {
      vi.stubEnv('GEOCODER_URL', value)
      expect(await searchAddresses(QUERY)).toEqual({ enabled: false, results: [] })
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('searches the configured Photon when set', async () => {
    vi.stubEnv('GEOCODER_URL', 'https://photon.test')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(PHOTON_MOEDLING))))
    const response = await searchAddresses(QUERY)
    expect(response.enabled).toBe(true)
    expect(response.results.map((r) => r.label)).toEqual(['2340 Mödling'])
  })

  it('stays enabled with no results when the provider fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.stubEnv('GEOCODER_URL', 'https://photon.test')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })))
    expect(await searchAddresses(QUERY)).toEqual({ enabled: true, results: [] })
  })
})
