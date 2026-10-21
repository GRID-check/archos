/**
 * Sorting the Archiv's root (`@/lib/filing/root-sort`): `GET` lists the folders
 * and the root documents a sort may read, `POST` judges one chunk of them.
 * Nothing moves here.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { planRootChunk, scanRoot } from '@/lib/filing/root-sort'
import { rootSortPlanRequestSchema } from '@/lib/filing/root-sort-types'
import { OFFICE_SHELF } from '@/lib/documents/shelf'

export const GET = apiRoute(async ({ session }) => scanRoot(session, OFFICE_SHELF), { authz: { enforcedBy: 'requireShelfWrite (canManageOfficeShelf)' } })

export const POST = apiRoute(
  async ({ session, request }) => {
    const { documentIds } = await parseJsonBody(request, rootSortPlanRequestSchema)
    return planRootChunk(session, OFFICE_SHELF, documentIds)
  },
  { authz: { enforcedBy: 'requireShelfWrite (canManageOfficeShelf)' } }
)
