/**
 * A project's tasks — the standing definitions (ADR-0131: a task is the
 * definition, a task run one attempt at it, served at `../runs`). List, one
 * keyset page at a time, and create. Thin adapters (ADR-0017); logic in
 * `@/lib/jobs/service`.
 *
 * Until October 2026 this path served the runs and `/jobs` served the tasks;
 * `/jobs` redirects here for one release (`lib/api/legacy-routes.ts`).
 */

import { apiRoute, parseJsonBody, parseQuery } from '@/lib/api/handler'
import { requireSkillsEnabled } from '@/lib/authz/feature-flags'
import { createJob, listJobs } from '@/lib/jobs/service'
import { createJobSchema } from '@/lib/jobs/types'
import { taskListQuerySchema } from '@/lib/tasks/task-wire'

type Params = { id: string }

export const GET = apiRoute<Params>(
  async ({ session, params, request }) => {
    const gated = requireSkillsEnabled(session)
    if (gated) return gated
    return listJobs(session, params.id, parseQuery(request, taskListQuerySchema))
  },
  {
    authz: {
      enforcedBy: 'listJobs (requireProjectAccess project:view)',
    },
  }
)

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    const gated = requireSkillsEnabled(session)
    if (gated) return gated
    const input = await parseJsonBody(request, createJobSchema)
    const task = await createJob(session, params.id, input)
    return Response.json({ task }, { status: 201 })
  },
  {
    authz: {
      enforcedBy: 'createJob (requireProjectAccess project:skills:manage)',
    },
  }
)
