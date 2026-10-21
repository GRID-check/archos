/**
 * Many filing moves in one request: what applying (and undoing) a root sort
 * sends, at most `MAX_FOLDER_MOVES` at a time (`@/lib/filing/root-sort-types`).
 * Each move is `moveDocumentToFolder`, with its own shelf, folder-access and
 * destination checks; one that is refused is reported per document and the
 * rest go on.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { moveDocumentsToFolders } from '@/lib/documents/move-to-folder'
import { folderMovesRequestSchema, type FolderMovesResponse } from '@/lib/filing/root-sort-types'

export const POST = apiRoute(
  async ({ session, request }): Promise<FolderMovesResponse> => {
    const { moves } = await parseJsonBody(request, folderMovesRequestSchema)
    return { results: await moveDocumentsToFolders(moves, session) }
  },
  {
    authz: {
      enforcedBy:
        'moveDocumentToFolder per move (org scope; requireProjectAccess project:documents:write for a project document, canManageOfficeShelf for an Archiv document)',
    },
  }
)
