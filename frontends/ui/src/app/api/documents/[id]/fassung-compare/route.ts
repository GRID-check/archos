/**
 * Fassung comparison API — Piloti marks what changed on one page between this
 * document (`[id]`, the NEWER one) and an older Fassung, and says it in words
 * (CONTEXT.md, „Fassung"). Thin handler; access, the same-collection rule, the
 * held-file rule and the backend call live in `@/lib/documents/fassung-compare-service`.
 *
 * Read-only for the documents, but a POST: it spends a vision-model call (cached by
 * the backend), so it is a mutation to the rate limiter.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { compareFassungVisually } from '@/lib/documents/fassung-compare-service'
import { fassungCompareBodySchema } from '@/lib/documents/fassung-compare-types'

type Params = { id: string }

export const POST = apiRoute<Params>(
  async ({ session, request, params }) => {
    const { older, page } = await parseJsonBody(request, fassungCompareBodySchema)
    return compareFassungVisually(session, params.id, older, page)
  },
  {
    authz: {
      enforcedBy:
        'compareFassungVisually -> getAccessibleDocument x2 (read: project:view / org Archiv member, folder visibility), then hasPassedScreening x2 (not held), same collection',
    },
  },
)
