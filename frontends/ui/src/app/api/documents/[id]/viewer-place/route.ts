/**
 * Viewer place API (ADR-0144): may Piloti's viewer action open this document
 * for this person, and what does the viewer need to open it.
 *
 * The browser asks it before a viewer action moves the asker's screen. It reads
 * the document as `GET /api/documents/[id]` does (`getListedDocument`: the
 * project's FGA, folder visibility, the hold, the listing's own predicates), so
 * a forged or stale event can open nothing the reader could not open from Files.
 * With `against`, the older Fassung is read the same way and must be on the same
 * shelf. Thin handler; the authorization lives in `getListedDocument`.
 */

import { apiRoute, parseQuery } from '@/lib/api/handler'
import { NotFoundError } from '@/lib/api/errors'
import { getListedDocument } from '@/lib/documents/listed-document'
import { toDocumentWireRows } from '@/lib/documents/list-projection'
import { viewerPlaceQuerySchema } from '@/lib/documents/viewer-place-wire'

type Params = { id: string }

export const GET = apiRoute<Params>(
  async ({ session, params, request }) => {
    const { against } = parseQuery(request, viewerPlaceQuerySchema)
    const listed = await getListedDocument(session, params.id)
    const older = against ? await getListedDocument(session, against) : null
    // Two Fassungen of one plan sit on one shelf; a pair across shelves is no comparison.
    if (older && (older.projectId !== listed.projectId || older.collectionName !== listed.collectionName)) {
      throw new NotFoundError()
    }
    const rows = await toDocumentWireRows(session.organizationId, older ? [listed, older] : [listed])
    return {
      document: { ...rows[0], projectId: listed.projectId },
      ...(older ? { against: { ...rows[1], projectId: older.projectId } } : {}),
    }
  },
  {
    authz: {
      enforcedBy: 'getListedDocument -> getAccessibleDocument (project:view | any member of the Archiv organization), for both documents',
    },
  }
)
