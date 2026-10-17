/**
 * The typed client for `GET /api/projects/same-address` (ADR-0055): the
 * projects already at the address chosen in the create dialog. The response is
 * parsed with zod, not cast. No `server-only`: the browser imports this.
 */

import { z } from 'zod'
import { PROJECT_STATUSES } from './project-status'

export const SAME_ADDRESS_PATH = '/api/projects/same-address'

export const sameAddressResponseSchema = z.object({
  projects: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string(),
        status: z.enum(PROJECT_STATUSES),
      })
    )
    .max(10),
})
export type SameAddressResponse = z.infer<typeof sameAddressResponseSchema>

export type SameAddressFetch = (path: string, init?: RequestInit) => Promise<Response>

const defaultFetch: SameAddressFetch = (path, init) => fetch(path, init)

export interface SameAddressClient {
  find(
    place: { label: string; lat: number; lon: number },
    init?: Pick<RequestInit, 'signal'>
  ): Promise<SameAddressResponse>
}

export function createSameAddressClient(fetchImpl: SameAddressFetch = defaultFetch): SameAddressClient {
  return {
    async find(place, init) {
      const params = new URLSearchParams({ label: place.label, lat: String(place.lat), lon: String(place.lon) })
      const response = await fetchImpl(`${SAME_ADDRESS_PATH}?${params}`, { method: 'GET', signal: init?.signal })
      if (!response.ok) throw new Error(`Same-address lookup failed with ${response.status}`)
      return sameAddressResponseSchema.parse(await response.json())
    },
  }
}
