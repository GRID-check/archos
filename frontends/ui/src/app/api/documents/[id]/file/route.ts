/**
 * Document file stream — serves a document's bytes from this origin so the
 * in-app PDF viewer can FETCH them (the presigned preview URL is cross-origin
 * and the object store publishes no CORS policy). Without `versionId`, the
 * current PDF only — a stored PDF, or the PDF rendition of an office document
 * (ADR-0070); see `streamDocumentFile` for why an SVG must never reach a
 * same-origin inline response. With `?versionId=` (the old path
 * `…/versions/[versionId]/file` redirects here for one release, `legacy-routes.ts`;
 * an agent's old `document-version-file-get` still sends it as a path param),
 * that version's own bytes, as `streamVersionFile` serves them; `?download=1`
 * asks for an attachment. Thin handler.
 */

import { apiRoute, parseQuery } from '@/lib/api/handler'
import { documentFileQuerySchema } from '@/lib/documents/document-wire'
import { streamDocumentFile } from '@/lib/documents/service'
import { streamVersionFile } from '@/lib/documents/version-content'

type Params = { id: string; versionId?: string }

export const GET = apiRoute<Params>(
  async ({ session, params, request }) => {
    const query = parseQuery(request, documentFileQuerySchema)
    const versionId = params.versionId ?? query.versionId
    return versionId
      ? streamVersionFile(session, params.id, versionId, { download: query.download === '1' })
      : streamDocumentFile(session, params.id)
  },
  {
    authz: {
      enforcedBy:
        'streamDocumentFile | streamVersionFile -> getAccessibleDocument (project:view for project documents; ' +
        'org membership for office shelf documents; a version must belong to the document and be published or superseded)',
    },
  }
)
