/**
 * The viewpoint of one Anmerkung on a model: camera, section planes, selected,
 * hidden and coloured elements, all in IFC world coordinates, Z-up, metres.
 * Gated like reading the document. Thin handler; the rules live in
 * `@/lib/annotations/viewpoint-read`.
 */

import { apiRoute } from '@/lib/api/handler'
import { readViewpoint } from '@/lib/annotations/viewpoint-read'

type Params = { id: string; annotationId: string }

export const GET = apiRoute<Params>(
  async ({ session, params }) => readViewpoint(session, params.id, params.annotationId),
  { authz: { enforcedBy: 'readViewpoint -> getAccessibleDocument (read)' } }
)
