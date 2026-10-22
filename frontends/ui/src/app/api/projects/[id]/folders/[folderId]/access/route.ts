/**
 * Who may read and who may write a project folder (ADR-0088, ADR-0097).
 *
 * GET — the folder's access as it is now: `{ mode: 'inherit' }` or
 * `{ mode: 'custom', everyoneReads, people: [{ userId, level }] }`, the people
 * read from the folder roles WorkOS holds for it. `project:manage` and write on
 * the folder, as for a change: who is on a list is for whoever may change it.
 *
 * PUT the same shape — `project:manage` and write on the folder. `userId` is a
 * member of the organization; `level` is `read` or `write`; `everyoneReads`
 * lets every project member read, the list then deciding only who may write.
 * A change of who may READ moves the documents below the folder into the
 * collection the new access puts them in before the response returns; `failed`
 * lists any that could not move this time, and repeating the request retries
 * exactly those.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { getFolderAccess, setFolderAccess } from '@/lib/projects/folder-access-settings'
import { folderAccessSchema } from '@/lib/projects/folder-access-wire'

type Params = { id: string; folderId: string }

const enforcedBy = 'getFolderAccess/setFolderAccess -> requireProjectAccess (project:manage) + write on the folder'

export const GET = apiRoute<Params>(
  async ({ session, params }) => getFolderAccess(session, { projectId: params.id, folderId: params.folderId }),
  { authz: { enforcedBy } }
)

export const PUT = apiRoute<Params>(
  async ({ session, params, request }) => {
    const access = await parseJsonBody(request, folderAccessSchema)
    return setFolderAccess(session, { projectId: params.id, folderId: params.folderId, access }, request)
  },
  { authz: { enforcedBy } }
)
