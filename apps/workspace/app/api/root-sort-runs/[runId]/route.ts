/**
 * One root-sort run (ADR-0121), as its requester's dialog reads it. The run is
 * the person's own: anyone else's is not found.
 */

import { apiRoute } from '@/lib/api/handler'
import { getRootSortRun } from '@/lib/filing/root-sort-run'

type Params = { runId: string }

export const GET = apiRoute<Params>(async ({ session, params }) => getRootSortRun(session, params.runId), {
  authz: { enforcedBy: 'getRootSortRun (the requester only; requireSortable on the run’s shelf)' },
})
