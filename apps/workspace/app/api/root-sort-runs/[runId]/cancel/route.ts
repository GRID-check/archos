/** Stop a root-sort run before anything moved (ADR-0121). */

import { apiRoute } from '@/lib/api/handler'
import { cancelRootSort } from '@/lib/filing/root-sort-run'

type Params = { runId: string }

export const POST = apiRoute<Params>(async ({ session, params }) => cancelRootSort(session, params.runId), {
  authz: { enforcedBy: 'cancelRootSort (the requester only; requireSortable on the run’s shelf)' },
})
