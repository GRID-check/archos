/**
 * One earlier or current Fassung's bytes under the same name (ADR-0054): the
 * target of „Öffnen" and „Herunterladen" on the Fassung timeline. `?download=1`
 * forces an attachment. `/file` and `/download` serve only the item's current
 * bytes, and `…/content` reads text.
 * Thin handler; all logic lives in `@/lib/documents/version-content`.
 */

import { apiRoute } from '@/lib/api/handler'
import { streamVersionFile } from '@/lib/documents/version-content'

type Params = { id: string; versionId: string }

export const GET = apiRoute<Params>(
  async ({ session, params, request }) =>
    streamVersionFile(session, params.id, params.versionId, {
      download: new URL(request.url).searchParams.get('download') === '1',
    }),
  {
    authz: {
      enforcedBy:
        'streamVersionFile -> getAccessibleDocument (project:view | org membership | conversation viewer), ' +
        'then the version must belong to the document and be published or superseded',
    },
  }
)
