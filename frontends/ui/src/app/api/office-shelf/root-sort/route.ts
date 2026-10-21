/**
 * Sorting the Archiv's root (ADR-0121): `GET` says what the root holds and the
 * person's latest run, `POST` starts a run. The run is the server's; the
 * `root_sort` job works it and `/api/root-sort-runs/[runId]` follows it.
 */

import { apiRoute } from '@/lib/api/handler'
import { OFFICE_SHELF } from '@/lib/documents/shelf'
import { describeRootSort, startRootSort } from '@/lib/filing/root-sort-run'

export const GET = apiRoute(async ({ session }) => describeRootSort(session, OFFICE_SHELF), {
  authz: { enforcedBy: 'requireSortable (requireShelfWrite: canManageOfficeShelf)' },
})

export const POST = apiRoute(async ({ session }) => startRootSort(session, OFFICE_SHELF), {
  authz: { enforcedBy: 'requireSortable (requireShelfWrite: canManageOfficeShelf)' },
})
