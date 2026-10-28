/**
 * The norm register, read-only, for every member: which Austrian laws and
 * authority guidance Piloti knows by number and how each becomes binding.
 * Thin handler; the platform's editing route is `/api/platform/norms`, which
 * reads the same register through `getNormRegistry`.
 */

import { apiRoute, parseQuery } from '@/lib/api/handler'
import { offsetPageOf, pageOfList } from '@/lib/api/offset-page'
import { filterNorms, listNormsQuerySchema } from '@/lib/norms/norm-list-wire'
import { getNormRegistry } from '@/lib/norms/service'

export const GET = apiRoute(
  async ({ request }) => {
    const query = parseQuery(request, listNormsQuerySchema)
    const { registry } = await getNormRegistry()
    const { rows, nextCursor } = pageOfList(filterNorms(registry, query), offsetPageOf(query))
    return { norms: rows, nextCursor }
  },
  {
    authz: {
      sessionOnly: true,
      why: 'the register is platform-wide public law pointers, identical for every organization; review notes and verify seeds are not in the answer',
    },
  }
)
