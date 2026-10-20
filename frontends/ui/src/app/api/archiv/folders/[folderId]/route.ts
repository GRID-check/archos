/**
 * One Archiv folder — rename, move, delete.
 *
 * The twin of `/api/projects/[id]/folders/[folderId]`, with the same handlers
 * (`@/lib/documents/folder-route-handlers`). Authz and logic live in
 * `@/lib/office-shelf/folder-service` (`org:archiv:manage`; ADR-0024, ADR-0078).
 */

import { apiRoute } from '@/lib/api/handler'
import { deleteFolderHandler, updateFolderHandler } from '@/lib/documents/folder-route-handlers'
import { deleteOfficeShelfFolder, updateOfficeShelfFolder } from '@/lib/office-shelf/folder-service'

type Params = { folderId: string }

export const PATCH = apiRoute<Params>(
  updateFolderHandler<Params>(
    (params, session, patch) => updateOfficeShelfFolder(session, { folderId: params.folderId, ...patch }),
  ),
  { authz: { enforcedBy: 'updateOfficeShelfFolder (canManageOfficeShelf)' } }
)

export const DELETE = apiRoute<Params>(
  deleteFolderHandler<Params>((params, session) => deleteOfficeShelfFolder(session, params.folderId)),
  { authz: { enforcedBy: 'deleteOfficeShelfFolder (canManageOfficeShelf)' } }
)
