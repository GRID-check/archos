/**
 * One task run, as a person or an agent reads it: where its message is, what
 * its ledger says, and what it produced (ADR-0062, ADR-0131).
 *
 * The read side of the run primitive. `runId` is the PUBLIC key of a run — the
 * backend job id is an implementation detail of the job store, and it expires
 * with it — so every surface that follows a run (the thread, a deep link, the
 * Tasks list) resolves it here and gets the conversation and message to open.
 * The browser's live block asks for the backend id with `include=stream`,
 * because its event stream hangs off it; nothing else needs it.
 *
 * Thin adapter: `getRunView` authorizes (`project:view`) and reads, and the
 * query is project- and organization-scoped, so RLS backs the check rather than
 * standing in for it.
 */

import { apiRoute, parseQuery } from '@/lib/api/handler'
import { getRunView } from '@/lib/runs/service'
import { runViewQuerySchema } from '@/lib/tasks/task-wire'

type Params = { id: string; runId: string }

export const GET = apiRoute<Params>(
  async ({ session, params, request }) =>
    getRunView(session, params.id, params.runId, parseQuery(request, runViewQuerySchema)),
  {
    authz: {
      enforcedBy: 'getRunView (requireProjectAccess project:view)',
    },
  },
)
