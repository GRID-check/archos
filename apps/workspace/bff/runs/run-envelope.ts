/**
 * A fresh signed request-context envelope for a background run (ADR-0108).
 *
 * ## What it is for
 *
 * A run outlives the envelope it was submitted with. The worker keeps the one
 * `submitAgentRun` minted and echoes it from the run's tools, so `file_draft`,
 * the canvas tools and `propose_file_change` act as the person who commissioned
 * the run. That envelope is accepted for six hours
 * (`REQUEST_CONTEXT_MAX_AGE_MS`), and a research run can be queued behind
 * an office's own questions for most of that. Past the renewal age
 * (`RUN_ENVELOPE_RENEW_AFTER_MS`) the worker asks here for a new one.
 *
 * ## Echo, never sign
 *
 * Python still never signs. It names a run by id; this tier reads everything
 * else off the `task_runs` row and off WorkOS as it is NOW, and signs only what
 * it re-checked:
 *
 *   - the run is still `queued` or `running`, so a finished run's envelope dies
 *     with it;
 *   - the requester is still a member of the organization with a role
 *     (`resolvePinnedRequesterSession`);
 *   - the organization still has the capability the run was admitted under
 *     ({@link capabilityOf});
 *   - the requester may still chat in the project as a member
 *     (`CHAT_PERMISSIONS`, not merely reading a closed project);
 *   - the requester may still view the run's conversation, when it exists.
 *
 * Any of those failing is a refusal, never a borrowed grant: the worker then
 * runs on without an envelope, as every run did before ADR-0108, and the tools
 * that act as a person refuse. What is signed is what `submitAgentRun` signs,
 * re-derived now through the same `runRequestContextInput`: the organization,
 * the requester, the project and its collection scope, the run's conversation,
 * `issuedAt`, and the run's context (model selection, budget, prompt blocks).
 * The context is not optional: the agent reads a signed envelope wholesale, so
 * an envelope without `modelOverrides` would run the rest of the job on the
 * YAML models, and one without `budget` with no budget at all.
 *
 * ## What this does not add
 *
 * The internal token that reaches this route IS the signing secret, so a holder
 * could mint any envelope without asking. The route is therefore not a new
 * door; what it adds is that the honest caller's identity is re-checked on the
 * way, and that renewal stops when the requester's rights do. Every write the
 * envelope reaches re-resolves the pinned session again (`requirePinnedSession`).
 */

import 'server-only'
import { ApiError } from '@/lib/api/errors'
import { recordAuditEvent } from '@/lib/audit/service'
import { resolvePinnedRequesterSession } from '@/lib/auth/pinned-session'
import type { AuthorizedSession } from '@/lib/auth/types'
import { CHAT_PERMISSIONS } from '@/lib/authz/chat'
import { FEATURE_FLAGS, type KnownFeatureFlag } from '@/lib/authz/feature-flags'
import { requireProjectAccess } from '@/lib/authz/projects'
import { authorizeConversationScope } from '@/lib/retrieval-scope/collection-scope-request'
import type { TaskRun } from '@/lib/db/schema/task-model'
import { withPlatformAccess, withTenant } from '@/lib/db/tenant-context'
import { isUuid } from '@/lib/ids'
import { resolveRunContext, runRequestContextInput, warnIfRunEnvelopeLarge } from '@/lib/jobs/run-context'
import { buildRequestContextEnvelope } from '@/lib/request-context'
import * as taskRepository from '@/lib/tasks/repository'
import { isActiveTaskRunStatus } from '@/lib/tasks/task-vocabulary'
import { isOrgFeatureEnabled } from '@/lib/workos/feature-flags'
import type { RunEnvelopeRefusal, RunEnvelopeResponse } from './run-envelope-types'

/** A renewal, or why there is none. The route turns the second into `{error, message}`. */
export type RunEnvelopeOutcome =
  | { ok: true; envelope: RunEnvelopeResponse }
  | { ok: false; refusal: RunEnvelopeRefusal; message: string }

/** The HTTP status each refusal answers with (`run-envelope-types.ts`). */
export const RUN_ENVELOPE_REFUSAL_STATUS: Readonly<Record<RunEnvelopeRefusal, number>> = {
  'unknown-run': 404,
  'run-not-active': 409,
  'requester-may-not-act': 403,
}

function refuse(refusal: RunEnvelopeRefusal, message: string): RunEnvelopeOutcome {
  return { ok: false, refusal, message }
}

/**
 * The capability the run was admitted under, which the organization must still
 * have. The same gate each door applied when the run was made: a scheduled fire
 * or a „Jetzt ausführen" is the jobs feature (`fireScheduledJob`,
 * `assertJobsFeatureOn`, both `skills`); a research run commissioned from a
 * chat question has no definition and is deep research; any other delegated
 * run is task automation (`POST /api/internal/tasks`).
 */
export function capabilityOf(run: Pick<TaskRun, 'trigger' | 'kind' | 'definitionId'>): KnownFeatureFlag {
  if (run.trigger !== 'delegated') return FEATURE_FLAGS.skills
  if (run.kind === 'deep-research' && run.definitionId === null) return FEATURE_FLAGS.deepResearch
  return FEATURE_FLAGS.taskAutomation
}

/**
 * Whether a refusal from an authorization check means „not as this person,
 * today". The ladder answers a missing permission with 404 and a closed
 * project, a locked conversation or a switched-off feature with 403; anything
 * else (the database, WorkOS) is an outage and is thrown, so the worker keeps
 * the envelope it has and asks again rather than treating it as a verdict.
 */
function isRefusal(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 403 || error.status === 404)
}

/** Holds the permission a chat turn in the project needs, as a member. */
async function mayChatInProject(session: AuthorizedSession, projectId: string): Promise<boolean> {
  try {
    const access = await requireProjectAccess(session, projectId, CHAT_PERMISSIONS)
    // Reading a closed project is every member of the organization's, and
    // signs no project on a job request (`signJobRequestContext`). Nobody who
    // reaches the project only that way could have commissioned the run
    // (`COMMISSION_PERMISSIONS` are writes), so it is not theirs to act on.
    return !access.readsBecauseClosed
  } catch (error) {
    if (isRefusal(error)) return false
    throw error
  }
}

/**
 * The run's conversation as it may be signed: the id when the requester may
 * view it, null when the row is gone (nothing to sign as checked), or
 * `'refused'` when it exists and they may not.
 */
async function signableConversation(
  session: AuthorizedSession,
  conversationId: string | null,
): Promise<string | null | 'refused'> {
  if (!conversationId) return null
  try {
    return (await authorizeConversationScope(session, conversationId)) ? conversationId : null
  } catch (error) {
    if (isRefusal(error)) return 'refused'
    throw error
  }
}

/**
 * Renew the envelope of one run, or say why not. Throws only for an outage.
 * The envelope itself is never logged, here or by the caller.
 */
export async function renewRunEnvelope(runId: string, now: number = Date.now()): Promise<RunEnvelopeOutcome> {
  // A malformed id is an unknown run, not a database error on a uuid column.
  if (!isUuid(runId)) return refuse('unknown-run', 'Unknown run')
  const run = await withPlatformAccess(
    'run envelope: the worker names a run by id, before any organization is known',
    () => taskRepository.findRunById(runId),
  )
  if (!run) return refuse('unknown-run', 'Unknown run')
  if (!isActiveTaskRunStatus(run.status)) return refuse('run-not-active', 'This run has already ended')

  return withTenant({ organizationId: run.organizationId, userId: run.requesterUserId }, () => signFor(run, now))
}

/** Everything after the row: the requester's rights today, then the signature. */
async function signFor(run: TaskRun, now: number): Promise<RunEnvelopeOutcome> {
  const session = await resolvePinnedRequesterSession({
    userId: run.requesterUserId,
    email: run.requesterEmail,
    organizationId: run.organizationId,
  })
  if (!session) return refuse('requester-may-not-act', 'The requester is no longer a member of the organization')
  if (!(await isOrgFeatureEnabled(capabilityOf(run), run.organizationId))) {
    return refuse('requester-may-not-act', 'The organization no longer has this capability')
  }
  if (!(await mayChatInProject(session, run.projectId))) {
    return refuse('requester-may-not-act', 'The requester may no longer work in this project')
  }
  const conversationId = await signableConversation(session, run.conversationId)
  if (conversationId === 'refused') {
    return refuse('requester-may-not-act', 'The requester may no longer view the run’s conversation')
  }

  const subject = { organizationId: run.organizationId, projectId: run.projectId, userId: run.requesterUserId }
  const context = await resolveRunContext(subject, run.plan.prompt)
  const { header, signature } = buildRequestContextEnvelope(
    runRequestContextInput(subject, context, conversationId, now),
    process.env.INTERNAL_API_TOKEN,
  )
  // An unsigned envelope is no acting identity (`verifyRequestContextEnvelope`
  // refuses it). The route's own token check already failed closed without the
  // secret, so reaching this is a deployment fault, not a refusal.
  if (!signature) throw new Error('INTERNAL_API_TOKEN is not configured; cannot sign a run envelope')
  warnIfRunEnvelopeLarge({ envelope: header, signature }, run.id)

  await recordAuditEvent({
    organizationId: run.organizationId,
    actor: { userId: run.requesterUserId, email: run.requesterEmail },
    action: 'task.envelope_renewed',
    targetType: 'task',
    targetId: run.id,
    metadata: { projectId: run.projectId, kind: run.kind, trigger: run.trigger },
  })
  return { ok: true, envelope: { header, signature, issuedAt: now } }
}
