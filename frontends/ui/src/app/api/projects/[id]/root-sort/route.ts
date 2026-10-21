/**
 * Sorting a project's root (`@/lib/filing/root-sort`): `GET` lists the folders
 * and the root documents a sort may read, `POST` judges one chunk of them.
 * Nothing moves here.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { planRootChunk, scanRoot } from '@/lib/filing/root-sort'
import { rootSortPlanRequestSchema } from '@/lib/filing/root-sort-types'
import { projectShelf } from '@/lib/documents/shelf'

type Params = { id: string }

export const GET = apiRoute<Params>(async ({ session, params }) => scanRoot(session, projectShelf(params.id)), {
  authz: { enforcedBy: 'requireShelfWrite (requireProjectAccess project:documents:write | project:edit)' },
})

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    const { documentIds } = await parseJsonBody(request, rootSortPlanRequestSchema)
    return planRootChunk(session, projectShelf(params.id), documentIds)
  },
  { authz: { enforcedBy: 'requireShelfWrite (requireProjectAccess project:documents:write | project:edit)' } }
)
