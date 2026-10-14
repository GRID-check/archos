/**
 * INTERNAL service endpoint — the worker reports how a background run ended.
 *
 * The scheduler fires a definition through `/api/internal/skills/fire`; the run
 * then lives entirely in the Python job store, and until this route existed the
 * BFF never learned that it finished. The worker calls here from its terminal
 * arms (success, failure, interrupted) with the one id it holds — the backend
 * job id — and the BFF turns that into an inbox item for the requester.
 *
 * ONE lookup, one recorder. Before migration 0086 this route tried `job_runs`
 * first and fell back to `tasks`, because a job-spawned run and a delegated
 * task were different tables; both are `task_runs` now, so the backend id has a
 * single home (`uniq_task_runs_backend_job_id`). The lookup by backend id
 * genuinely has no tenant yet, so it runs under platform access, narrowly;
 * everything after is one organization's work and is done as that
 * organization, so row-level security still applies to it. A backend id with
 * no run row may be a reading of a project's documents (ADR-0111), which has
 * none: the intake whose `job_id` it is, in the body's organization, is
 * settled instead (a failed or cancelled reading fails). Any other backend id
 * the BFF has no run for (an interactive deep-research job) is a 404, which the
 * worker treats as "nothing to notify", not as an error.
 */

import { z } from 'zod'
import { NotFoundError } from '@/lib/api/errors'
import { internalApiRoute, parseJsonBody } from '@/lib/api/handler'
import { withPlatformAccess, withTenant } from '@/lib/db/tenant-context'
import { settleIntakeOutcome } from '@/lib/project-intake/service'
import { loadRunForOutcome, recordRunOutcome } from '@/lib/tasks/service'

type Params = { jobId: string }

const REPORT_MAX_CHARS = 400_000

const outcomeSchema = z.object({
  // The run's tenant as the worker knows it (from the job's usage context).
  // Cross-checked against the run row: the token grants no cross-org bypass.
  organizationId: z.string().min(1),
  status: z.enum(['success', 'failure', 'interrupted']),
  // The sanitized, user-safe error the worker persisted. Capped: it is
  // caller-controlled text on its way into a jsonb payload.
  error: z.string().max(2000).nullish(),
  // The finished report and its cards, so a scheduled run's report can be
  // filed here as the requester instead of expiring with the job store.
  report: z.string().max(REPORT_MAX_CHARS).nullish(),
  cards: z.array(z.unknown()).max(200).nullish(),
})


export const POST = internalApiRoute<Params>(
  'Job Outcome',
  async ({ request, params }) => {
    const { organizationId, status, error, report, cards } = await parseJsonBody(request, outcomeSchema)

    const run = await withPlatformAccess(
      'job outcome: the worker identifies a run by backend job id, before any organization is known',
      () => loadRunForOutcome(params.jobId)
    )
    if (!run) {
      // A reading of a project's documents has no run row (ADR-0111): its job
      // is the intake's. A failed or cancelled one fails the reading.
      const intake = await withTenant({ organizationId }, () => settleIntakeOutcome(organizationId, params.jobId, status))
      if (intake) return { intake: { projectId: intake.projectId, status: intake.status } }
    }
    if (!run || run.organizationId !== organizationId) throw new NotFoundError('Unknown job run')

    const outcome = { status, error: error ?? null, report: report ?? null, cards: cards ?? null }
    return withTenant({ organizationId: run.organizationId }, () => recordRunOutcome(run, outcome))
  },
  { tenancy: { fromPayload: 'the run named by params.jobId, cross-checked against body.organizationId' } }
)
