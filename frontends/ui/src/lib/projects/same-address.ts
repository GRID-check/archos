/**
 * „An dieser Adresse gibt es schon ein Projekt": the projects the person may
 * open that sit at the address they just chose in the create dialog.
 *
 * An earlier project on the same plot is the best source a new one has
 * (Bestandspläne, Bescheide), and a duplicate is cheaper to avoid than to merge
 * (`docs/design/agentic-project-intake.md`, „Quality of life"). A project is at
 * the address when its profile's `standort_adresse` is the same line once case,
 * diacritics and punctuation are folded away, or when the geocoder's hit kept
 * with its intake lies within {@link SAME_ADDRESS_RADIUS_M} of the chosen one.
 *
 * Access is the project list's: a name is not shown to a member who cannot
 * open the project (ADR-0038), so the matches are filtered through the same
 * per-project check, after the cheap match, so FGA is asked about a handful.
 */

import 'server-only'
import type { AuthorizedSession } from '@/lib/auth/types'
import { distanceMetres, normalizeAddress } from '@/lib/text/address-match'
import { listProjectAddressesInOrg, type ProjectAddressRow } from './repository'
import { projectsHolding } from './service'
import type { ProjectStatus } from './project-status'

/** The radius within which two geocoder hits count as one plot. */
export const SAME_ADDRESS_RADIUS_M = 50
/** Most projects shown under the field. */
export const SAME_ADDRESS_LIMIT = 3

export interface SameAddressQuery {
  label: string
  lat?: number | undefined
  lon?: number | undefined
}

export interface SameAddressProject {
  id: string
  name: string
  status: ProjectStatus
}

/** Pure: which of `rows` sit at the address, nearest evidence first. Not yet filtered by access. */
export function matchSameAddress(
  rows: readonly ProjectAddressRow[],
  query: SameAddressQuery
): ProjectAddressRow[] {
  const wanted = normalizeAddress(query.label)
  const point = query.lat !== undefined && query.lon !== undefined ? { lat: query.lat, lon: query.lon } : null
  const scored: Array<{ row: ProjectAddressRow; rank: number }> = []
  for (const row of rows) {
    if (wanted !== '' && row.address !== null && normalizeAddress(row.address) === wanted) {
      scored.push({ row, rank: 0 })
      continue
    }
    if (point && row.location && distanceMetres(point, row.location) <= SAME_ADDRESS_RADIUS_M) {
      scored.push({ row, rank: 1 })
    }
  }
  return scored.sort((a, b) => a.rank - b.rank).map((entry) => entry.row)
}

export async function findProjectsAtAddress(
  session: AuthorizedSession,
  query: SameAddressQuery
): Promise<SameAddressProject[]> {
  const rows = await listProjectAddressesInOrg(session.organizationId)
  const matches = matchSameAddress(rows, query)
  if (matches.length === 0) return []
  const reachable = await projectsHolding(session, matches)
  return reachable
    .slice(0, SAME_ADDRESS_LIMIT)
    .map(({ id, name, status }) => ({ id, name, status }))
}
