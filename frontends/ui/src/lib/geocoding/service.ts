import 'server-only'

import { searchPhoton } from './photon'
import type { GeocodeQuery, GeocodeResponse } from './types'

/**
 * The configured geocoder, or null when the feature is off. An address is
 * client data, so the provider is the deployment's choice
 * (`GEOCODER_URL`, docs/deployment/environment-variables.md); read per
 * call so a spec can flip it. A value that is not an http(s) URL is off too.
 */
function geocoderUrl(): string | null {
  const raw = process.env.GEOCODER_URL?.trim()
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.toString()
  } catch {
    // fall through to the warning
  }
  console.error('[geocode] GEOCODER_URL is not an http(s) URL; the geocoder stays off')
  return null
}

/** Search Austrian addresses and places. Off (`enabled: false`) without `GEOCODER_URL`. */
export async function searchAddresses(query: GeocodeQuery, signal?: AbortSignal): Promise<GeocodeResponse> {
  const baseUrl = geocoderUrl()
  if (!baseUrl) return { enabled: false, results: [] }
  return { enabled: true, results: await searchPhoton(baseUrl, query.q, { limit: query.limit, signal }) }
}
