/**
 * A project's Offene Punkte: the live Anmerkungen of every document of the
 * project the reader may see, a bounded page at a time
 * (`?status=open|proposed|all-live&assignee=me|<userId>&due=overdue|soon&order=document|due&limit=&cursor=`).
 *
 * Thin handler; the project gate, the reader's documents and the view live in
 * `@/lib/annotations/project-marks`; the typed client is
 * `@/lib/annotations/client` (`listProjectAnnotations`).
 */

import { apiRoute, parseQuery } from '@/lib/api/handler'
import { listProjectAnnotations } from '@/lib/annotations/project-marks'
import { projectMarksQuerySchema } from '@/lib/annotations/project-types'

type Params = { id: string }

export const GET = apiRoute<Params>(
  async ({ session, params, request }) =>
    listProjectAnnotations(session, params.id, parseQuery(request, projectMarksQuerySchema)),
  {
    authz: {
      enforcedBy:
        'listProjectAnnotations (requireProjectAccess project:view; documents narrowed by getHiddenFolderIds and shelfReaderFor, canWriteDocument per document)',
    },
  }
)
