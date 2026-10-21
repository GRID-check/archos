/**
 * New folders for the Archiv root documents its folders do not fit
 * (`@/lib/filing/root-sort`). A proposal only: nothing is created here.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { proposeRootFolders } from '@/lib/filing/root-sort'
import { newFoldersRequestSchema } from '@/lib/filing/root-sort-types'
import { OFFICE_SHELF } from '@/lib/documents/shelf'

export const POST = apiRoute(
  async ({ session, request }) => {
    const { documentIds } = await parseJsonBody(request, newFoldersRequestSchema)
    return proposeRootFolders(session, OFFICE_SHELF, documentIds)
  },
  { authz: { enforcedBy: 'requireShelfWrite (canManageOfficeShelf)' } }
)
