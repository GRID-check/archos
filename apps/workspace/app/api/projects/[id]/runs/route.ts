/**
 * A project's task runs (ADR-0131): `GET` lists them one keyset page at a
 * time, narrowed by task, status and review state; `POST` commissions one.
 * One run is `./[runId]`. Until October 2026 the list was `../tasks`, which now
 * serves the tasks themselves.
 *
 * `POST` commissions a research run from the UI: an open finding to clear, or a
 * report to carry forward. An adapter over `commissionResearchRun`, the
 * same door the agent's own escalation uses (ADR-0062 addendum), with the
 * same gate; the run's message is minted in the thread that asked.
 */

import { commissionRunSchema } from '@/lib/runs/commission-wire'
import { apiRoute, parseJsonBody, parseQuery } from '@/lib/api/handler'
import { NotFoundError } from '@/lib/api/errors'
import {
  FEATURE_FLAGS,
  requireFeature,
  requireSkillsEnabled,
  requireTaskAutomationEnabled,
} from '@/lib/authz/feature-flags'
import { findConversationInOrg } from '@/lib/conversations/repository'
import { requireResourceAccess } from '@/lib/sharing/access'
import { commissionResearchRun } from '@/lib/tasks/delegation'
import { listTaskRunViews } from '@/lib/tasks/service'
import { taskRunListQuerySchema } from '@/lib/tasks/task-wire'
import { getLocale } from '@/i18n/server'

type Params = { id: string }

export const GET = apiRoute<Params>(
  async ({ session, params, request }) => {
    const query = parseQuery(request, taskRunListQuerySchema)
    // `skills` decides whether the Automation section exists; `task-automation`
    // whether work may be handed over at all. An org can have the toolbox in
    // chat without the right to delegate, so the project's run list needs
    // both. One task's history needs only the first, as it always did: the
    // task is on screen, and so is what it did.
    const gated = query.taskId
      ? requireSkillsEnabled(session)
      : (requireSkillsEnabled(session) ?? requireTaskAutomationEnabled(session))
    if (gated) return gated
    return listTaskRunViews(session, params.id, query)
  },
  {
    authz: {
      enforcedBy: 'listTaskRunViews -> listTaskRuns (requireProjectAccess project:view)',
    },
  }
)

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    // The same capability `POST /api/jobs/async/submit` and the agent's door
    // (`api/internal/tasks`) gate: a third way in must not be the way around it.
    const gated = requireFeature(session, FEATURE_FLAGS.deepResearch)
    if (gated) return gated
    const input = await parseJsonBody(request, commissionRunSchema)
    // The internal route takes the thread from a signed envelope; here it is a
    // body field, so it is authorized like any other post to a thread: the
    // caller contributes to it, and it belongs to the project in the path.
    await requireResourceAccess(session, 'conversation', input.conversationId, 'collaborator')
    const conversation = await findConversationInOrg(input.conversationId, session.organizationId)
    if (conversation?.projectId !== params.id) throw new NotFoundError()
    const run = await commissionResearchRun(session, {
      projectId: params.id,
      conversationId: input.conversationId,
      question: input.question,
      context: input.context ?? null,
      documents: input.documents ?? null,
      // A refusal (a thread that drew on a restricted folder, ADR-0087) is read
      // by the person who pressed the button.
      locale: await getLocale(),
    })
    return {
      runId: run.runId,
      runMessageId: run.runMessageId,
      conversationId: run.conversationId,
      status: run.status,
    }
  },
  {
    status: 201,
    authz: {
      enforcedBy:
        'requireFeature deepResearch; requireResourceAccess conversation collaborator; commissionResearchRun (requireProjectAccess COMMISSION_PERMISSIONS, refuses a confined conversation)',
    },
  }
)
