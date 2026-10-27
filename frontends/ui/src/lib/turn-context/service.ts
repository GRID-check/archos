import 'server-only'
import { drewOnOtherProjects } from '@/lib/conversations/cross-project-use'
import { loadReferenceBrief } from '@/lib/cross-project/reference-brief'
import type { AuthorizedSession } from '@/lib/auth/types'
import { NotFoundError } from '@/lib/api/errors'
import { withPlatformAccess } from '@/lib/db/tenant-context'
import { requireProjectAccess } from '@/lib/authz/projects'
import { CHAT_PERMISSIONS } from '@/lib/authz/chat'
import { findConversationTenancy } from '@/lib/conversations/repository'
import { requireResourceAccess } from '@/lib/sharing/access'
import { loadProjectPromptView } from '@/lib/project-profile/prompt-view'
import { resolveOrgInstructions } from '@/lib/org-instructions/service'
import { buildProjectMemoryDigest } from '@/lib/projects/memory-service'
import type { DigestTiming } from '@/lib/projects/memory-recall'
import { buildProposalDecisionsBlock, composeMemoryContext } from '@/lib/projects/proposal-decisions'
import { buildReviewDecisionsBlock } from '@/lib/documents/review-decisions'
import { buildFolderDescriptionsBlock } from '@/lib/filing/folder-descriptions-block'
import type { VerifiedGridRequestContext } from '@/lib/request-context'
import { getDb } from '@/lib/db'
import { isSoloAudience } from '@/lib/conversations/cross-project-use'
import { readConversationAudience } from '@/lib/conversations/restricted-use-repository'
import { countPendingInboxItems, EVERY_INBOX_TYPE } from '@/lib/inbox/repository'
import { listConversationProposals } from '@/lib/proposals/repository'
import { findProjectInOrg } from '@/lib/projects/repository'
import { countActiveRunsInProject } from '@/lib/tasks/repository'
import { officeConventionsForTurn } from '@/lib/office-conventions/service'
import type { ProjectAccess } from '@/lib/authz/projects'
import { TurnContextTiming } from './timing'
import type { TurnContextRequest, TurnContextResponse } from './wire'
import {
  MAX_WORKSPACE_PROPOSALS,
  type WorkspaceFacts,
  proposalOutcomeOf,
  proposalSummaryOf,
  renderWorkspaceBlock,
} from './workspace-block'

async function advisory<T>(what: string, load: () => Promise<T>): Promise<T | null> {
  try {
    return await load()
  } catch (error) {
    console.warn(`[Turn Context API] Failed to ${what}:`, error)
    return null
  }
}

/**
 * The WORKSPACE block (ADR-0123): the asker's roles, the project, the
 * conversation's audience, what waits in their inbox, the project's runs in
 * flight and this conversation's proposals with every status. Read after the
 * access checks above, under the turn's tenant; each part fails open to
 * "unknown" on its own, so one slow table never costs the turn its context.
 * On a question about filing or finding, the office's conventions close it
 * (ADR-0129, off unless the organization has the `office-conventions` flag).
 */
async function loadWorkspaceBlock(
  session: AuthorizedSession,
  context: VerifiedGridRequestContext,
  projectAccess: ProjectAccess | null,
  query: string | undefined,
): Promise<string> {
  const { organizationId, projectId, conversationId, userId } = context
  const [project, audience, inboxWaiting, activeRuns, proposals, officeConventions] = await Promise.all([
    projectId ? advisory('load the project', () => findProjectInOrg(projectId, organizationId)) : Promise.resolve(null),
    conversationId
      ? advisory('load the conversation audience', async () =>
          isSoloAudience(await readConversationAudience(getDb(), organizationId, conversationId), userId)
            ? ('solo' as const)
            : ('shared' as const),
        )
      : Promise.resolve(null),
    advisory('count the inbox', () => countPendingInboxItems(organizationId, userId, EVERY_INBOX_TYPE)),
    projectId
      ? advisory('count the project runs', () => countActiveRunsInProject(projectId, organizationId))
      : Promise.resolve(null),
    conversationId
      ? advisory('list the conversation proposals', () =>
          listConversationProposals(organizationId, conversationId, MAX_WORKSPACE_PROPOSALS + 1),
        )
      : Promise.resolve(null),
    advisory('load the office conventions', () => officeConventionsForTurn(organizationId, query)),
  ])
  const facts: WorkspaceFacts = {
    organizationRole: session.role || null,
    projectRole: projectAccess?.role ?? null,
    project: projectId && project ? { id: projectId, name: project.name, status: project.status } : null,
    conversation: conversationId ? { id: conversationId, audience: audience ?? 'unknown' } : null,
    inboxWaiting,
    activeRuns,
    proposals: (proposals ?? []).slice(0, MAX_WORKSPACE_PROPOSALS).map((row) => ({
      id: row.id,
      kind: row.kind,
      status: row.status,
      summary: proposalSummaryOf(row.kind, row.payload),
      outcome: proposalOutcomeOf(row.results),
    })),
    proposalsTruncated: (proposals?.length ?? 0) > MAX_WORKSPACE_PROPOSALS,
    officeConventions,
  }
  return renderWorkspaceBlock(facts)
}

/** Today's requester may read this project and this conversation; the project access feeds the WORKSPACE block. */
async function checkAccess(session: AuthorizedSession, context: VerifiedGridRequestContext): Promise<ProjectAccess | null> {
  const { organizationId, projectId, conversationId } = context
  const projectAccess = projectId ? await requireProjectAccess(session, projectId, CHAT_PERMISSIONS) : null
  if (conversationId) {
    // An RLS-hidden foreign row is not a genuinely new conversation.
    const tenancy = await withPlatformAccess(
      'turn-context conversation existence probe; all access is checked before prompt reads',
      () => findConversationTenancy(conversationId),
    )
    // A first turn names a client-generated id before its row exists.
    if (tenancy) {
      if (tenancy.organizationId !== organizationId || tenancy.deletedAt) throw new NotFoundError()
      await requireResourceAccess(session, 'conversation', conversationId, 'viewer')
    }
  }
  return projectAccess
}

/**
 * Reload prompt data only after today's requester access has been checked.
 *
 * Every read after the checks runs at once, so the build costs its slowest
 * read; `timing` records each one for the route's `Server-Timing` header.
 */
export async function loadTurnContext(
  session: AuthorizedSession,
  context: VerifiedGridRequestContext,
  input: TurnContextRequest,
  timing: TurnContextTiming = new TurnContextTiming(),
): Promise<TurnContextResponse> {
  const { organizationId, projectId, conversationId } = context
  const projectAccess = await timing.time('access', () => checkAccess(session, context))
  const query = input.query || undefined
  const digestTiming: DigestTiming = {}
  const timed = <T>(name: string, load: () => Promise<T>) => timing.time(name, load)

  const [projectContext, orgInstructions, digest, decisions, reviewDecisions, drewOnOthers, referenceProjects, folders, workspace] = await Promise.all([
    projectId ? timed('profile', () => loadProjectPromptView(projectId, organizationId)) : Promise.resolve(null),
    timed('instructions', () => resolveOrgInstructions(organizationId)),
    timed('memory', () => buildProjectMemoryDigest(projectId ?? undefined, organizationId, { query, timing: digestTiming })),
    projectId
      ? timed('decisions', () => advisory('load proposal decisions', () => buildProposalDecisionsBlock(projectId, organizationId)))
      : Promise.resolve(null),
    conversationId
      ? timed('reviews', () => advisory('load review decisions', () => buildReviewDecisionsBlock(conversationId, organizationId)))
      : Promise.resolve(null),
    // Not advisory: a turn that wrongly believed its doors open would only be
    // refused at the BFF, but the read is one indexed probe and a failure here
    // is a failure to load the turn's context like any other.
    conversationId ? timed('cross-project', () => drewOnOtherProjects(conversationId, organizationId)) : Promise.resolve(false),
    // The office's closed projects, most like this one first: what the agent may look into on its own.
    timed('references', () => advisory('load reference projects', () => loadReferenceBrief(organizationId, projectId ?? null))),
    // What a person wrote each folder holds, beside the tree the inventory shows.
    timed('folders', () => advisory('load folder descriptions', () => buildFolderDescriptionsBlock(organizationId, projectId ?? null))),
    // Who asks, where, and what is open now: the state office work starts from (ADR-0123).
    timed('workspace', () => advisory('load the workspace block', () => loadWorkspaceBlock(session, context, projectAccess, query))),
  ])
  // Whether the memory read waited for the query embed is what decides its cost.
  if (digestTiming.dense) timing.describe('memory', digestTiming.dense)
  return {
    projectContext,
    projectMemory: composeMemoryContext(digest, decisions, reviewDecisions, folders),
    orgInstructions,
    drewOnOtherProjects: drewOnOthers,
    referenceProjects,
    workspace,
  }
}
