/**
 * New folders for the root documents a project's folders do not fit
 * (`@/lib/filing/root-sort`). A proposal only: nothing is created here.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { proposeRootFolders } from '@/lib/filing/root-sort'
import { newFoldersRequestSchema } from '@/lib/filing/root-sort-types'
import { projectShelf } from '@/lib/documents/shelf'

type Params = { id: string }

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    const { documentIds } = await parseJsonBody(request, newFoldersRequestSchema)
    return proposeRootFolders(session, projectShelf(params.id), documentIds)
  },
  { authz: { enforcedBy: 'requireShelfWrite (requireProjectAccess project:documents:write | project:edit)' } }
)
