/**
 * Resolve an Archiv folder upload's directory paths to folder ids, creating what
 * is missing — the twin of `/api/projects/[id]/folders/ensure`, with the same
 * handler (`@/lib/documents/folder-route-handlers`). Authz and logic live in
 * `@/lib/office-shelf/folder-service` (`org:office_shelf:manage`; ADR-0024, ADR-0078).
 */

import { apiRoute } from '@/lib/api/handler'
import { ensureFoldersHandler } from '@/lib/documents/folder-route-handlers'
import { ensureOfficeShelfFolderPaths } from '@/lib/office-shelf/folder-service'

export const POST = apiRoute(
  ensureFoldersHandler<unknown>((_params, session, input) => ensureOfficeShelfFolderPaths(session, input)),
  { authz: { enforcedBy: 'ensureOfficeShelfFolderPaths (canManageOfficeShelf)' } }
)
