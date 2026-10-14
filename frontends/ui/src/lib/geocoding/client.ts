/**
 * The typed client for the geocoder (ADR-0055): `GET /api/geocode`.
 *
 * The path and the response shape are written once, here; the project creation
 * dialog and the route spec both go through it. Responses are parsed with the
 * zod schema from `./types`, not cast. No `server-only`: the browser imports this.
 */

import { geocodeResponseSchema, type GeocodeResponse } from './types'

/** How a request is made: `fetch` in a browser, the real handler in a route spec. */
export type GeocodingFetch = (path: string, init?: RequestInit) => Promise<Response>

const defaultFetch: GeocodingFetch = (path, init) => fetch(path, init)

/** A request the API refused, with its status and the body's own code (400 `BAD_REQUEST`). */
export class GeocodingRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'GeocodingRequestError'
  }
}

export const GEOCODE_PATH = '/api/geocode'

export interface GeocodingClient {
  /** Suggestions for `q` (3 to 200 characters). `enabled: false` means no geocoder is configured. */
  search(q: string, limit?: number, init?: Pick<RequestInit, 'signal'>): Promise<GeocodeResponse>
}

export function createGeocodingClient(fetchImpl: GeocodingFetch = defaultFetch): GeocodingClient {
  return {
    async search(q, limit, init) {
      const params = new URLSearchParams({ q })
      if (limit !== undefined) params.set('limit', String(limit))
      const response = await fetchImpl(`${GEOCODE_PATH}?${params}`, { method: 'GET', signal: init?.signal })
      const body: unknown = await response.json().catch(() => null)
      if (!response.ok) {
        const error = (body ?? {}) as { error?: string; code?: string }
        throw new GeocodingRequestError(
          response.status,
          error.code ?? 'UNKNOWN',
          error.error ?? `Request failed with ${response.status}`,
        )
      }
      return geocodeResponseSchema.parse(body)
    },
  }
}
