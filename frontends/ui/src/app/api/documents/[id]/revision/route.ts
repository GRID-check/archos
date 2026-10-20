/**
 * Fassung link API — a person confirms, or takes back, that this document
 * (`[id]`, the NEWER one) replaces another (CONTEXT.md, „Fassung").
 * Thin handler; access, the same-collection rule and the backend call live in
 * `@/lib/documents/revision-service`.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { setRevisionLink } from '@/lib/documents/revision-service'

type Params = { id: string }

const revisionLinkSchema = z.object({
  /** The document being replaced. */
  older: z.string().uuid(),
  /** `true` confirms the link, `false` takes it back. */
  linked: z.boolean(),
})

export const PUT = apiRoute<Params>(
  async ({ session, request, params }) => {
    const { older, linked } = await parseJsonBody(request, revisionLinkSchema)
    return setRevisionLink(session, params.id, older, linked, request)
  },
  {
    authz: {
      enforcedBy:
        'setRevisionLink -> getAccessibleDocument x2 (project:documents:write / project:edit, write on the folder; org:office_shelf:manage for the Büroablage)',
    },
  }
)
