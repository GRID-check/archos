/**
 * Fassung comparison API — Piloti marks what changed on one page between this
 * document (`[id]`, the NEWER one) and an older Fassung, and says it in words
 * (CONTEXT.md, „Fassung"). Thin handler; access, the same-collection rule, the
 * held-file rule and the backend call live in `@/lib/documents/revision-compare-service`.
 *
 * Read-only for the documents, but a POST: it spends a vision-model call (cached by
 * the backend), so it is a mutation to the rate limiter.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { compareRevisionVisually } from '@/lib/documents/revision-compare-service'
import { revisionCompareBodySchema } from '@/lib/documents/revision-compare-types'

type Params = { id: string }

export const POST = apiRoute<Params>(
  async ({ session, request, params }) => {
    const { older, page } = await parseJsonBody(request, revisionCompareBodySchema)
    return compareRevisionVisually(session, params.id, older, page)
  },
  {
    authz: {
      enforcedBy:
        'compareRevisionVisually -> getAccessibleDocument x2 (read: project:view / org Archiv member, folder visibility), then hasPassedScreening x2 (not held), same collection',
    },
  },
)
