import 'server-only'
/**
 * Who reads the conversation Piloti answers in, and what a workspace read
 * leaves behind there (ADR-0093, ADR-0094, ADR-0121).
 *
 * Piloti's MCP reads run as the requester, with the requester's rights. What
 * they return lands in the conversation's transcript, which everyone the
 * conversation is shared with reads. These are the database questions
 * `read-gate.ts` asks about that; the gate decides with the answers.
 *
 *  - {@link conversationReachOf}: is the conversation the requester's alone
 *    (`isSoloAudience`, the rule `audienceReach` uses for
 *    `restrictedFolders`)? A conversation with no row yet is: its first turn
 *    creates it, private, for the requester.
 *  - {@link soloReadRefusal}: may this read run in a solo conversation at all?
 *    The record below covers the turn's own project and nothing else, so a
 *    read that names another project (by id, or through a document, folder,
 *    model or conversation of one), or any project in a turn that has none, is
 *    refused; so is a read of another conversation that drew on another
 *    project. What a call names is `operation-targets.ts`'s answer.
 *  - {@link recordSoloWorkspaceRead}: record the restricted folders the read
 *    may have drawn on before the content reaches the model. In ONE
 *    transaction under `lockConversationAudience`, the lock every share,
 *    visibility change and escalation takes: the audience is read again under
 *    it, and a conversation that is no longer the requester's alone records
 *    nothing and the read is refused; otherwise every folder of the turn's
 *    project that restricts someone and that the requester may read is
 *    recorded, and the turn's answer is
 *    marked in `message_restricted_use` when the conversation now draws on a
 *    restricted folder. The record therefore exists before the read runs, and
 *    a share that lands after it is judged against it (ADR-0093's rule,
 *    "recorded before the model sees it"). An operation's answer does not say
 *    which folder its content came from, so every restricting folder is
 *    recorded: that over-records on purpose; under-recording is the leak.
 *
 * Why refuse a read of another project rather than record it as a cross-project
 * hand-out (`recordCrossProjectHandOut`, `conversation_source_projects`): that
 * record says the conversation drew on the project as its AUDIENCE may read it
 * (the lookups search as the audience). A route's answer is the requester's,
 * with every restricted folder they may open, and nothing in it says which. The
 * only honest record would be every restricting folder of every project the
 * answer might touch, which is the refusal with more steps.
 */

import { listProjectFolderTree } from '@/lib/authz/folder-access-repository'
import { folderTree, getHiddenFolderIds, readableByEveryMember } from '@/lib/authz/folder-access'
import { drewOnOtherProjects, isSoloAudience } from '@/lib/conversations/cross-project-use'
import {
  lockConversationAudience,
  markAnswerRestrictedUse,
  readConversationAudience,
  recordSourceFolders,
} from '@/lib/conversations/restricted-use-repository'
import { getDb } from '@/lib/db'
import { withTenant } from '@/lib/db/tenant-context'
import type { AgentOperation } from './operation'
import { type TargetInput, TooManyTargetsError, placesOf, targetsOf } from './operation-targets'
import type { AgentPrincipal } from './principal'

/** `none`: the call belongs to no conversation. `solo`: the requester's alone. `shared`: anyone else reads it. */
export type ConversationReach = 'none' | 'solo' | 'shared'

const tenantOf = (principal: AgentPrincipal) => ({
  organizationId: principal.session.organizationId,
  userId: principal.session.userId,
})

export async function conversationReachOf(principal: AgentPrincipal): Promise<ConversationReach> {
  const conversationId = principal.conversationId
  if (principal.actor !== 'piloti' || !conversationId) return 'none'
  const audience = await withTenant(tenantOf(principal), () =>
    readConversationAudience(getDb(), principal.session.organizationId, conversationId)
  )
  return isSoloAudience(audience, principal.session.userId) ? 'solo' : 'shared'
}

/**
 * The sentences the model relays for a read refused in a solo conversation. English, whatever the
 * person's locale: an agent reads them (AGENTS.md, "Industry standard first").
 */
export const SOLO_READ_REFUSALS = {
  noProject:
    'This conversation belongs to no project, so Piloti reads nothing of a project in it: the answer would sit here ' +
    'without that project\'s rules for who may read it. Tell the person to ask in a conversation in that project.',
  otherProject:
    'That belongs to another project than this conversation\'s, so Piloti does not read it here: its content would ' +
    'land in this conversation, where that project\'s rules for who may read it do not hold. Tell the person to ask ' +
    'in a conversation in that project, or to open it themselves.',
  tooMany:
    'The call names too many projects, documents, folders or conversations to check. Narrow it and call again.',
} as const

/**
 * Whether a read of `op` with `input` may run in the requester's solo
 * conversation: null when it may, else the refusal the model relays. See the
 * module docstring. A failed lookup rejects, and the read must not run.
 */
export async function soloReadRefusal(
  principal: AgentPrincipal,
  op: Pick<AgentOperation, 'path'>,
  input: TargetInput,
): Promise<string | null> {
  let targets
  try {
    targets = targetsOf(op, input)
  } catch (error) {
    if (error instanceof TooManyTargetsError) return SOLO_READ_REFUSALS.tooMany
    throw error
  }
  if (targets.length === 0) return null
  const { organizationId, userId } = principal.session
  const turnProject = principal.projectId ?? null
  return withTenant(tenantOf(principal), async () => {
    const places = await placesOf(organizationId, userId, targets)
    for (const place of places) {
      // Nothing there for this reader: the route answers its own 404, and no content moves.
      if (!place) continue
      if (place.projectId && !turnProject) return SOLO_READ_REFUSALS.noProject
      if (place.projectId && place.projectId !== turnProject) return SOLO_READ_REFUSALS.otherProject
      const other = place.conversationId && place.conversationId !== principal.conversationId
      if (other && (await drewOnOtherProjects(place.conversationId as string, organizationId))) {
        return SOLO_READ_REFUSALS.otherProject
      }
    }
    return null
  })
}

/**
 * The folders of `projectId` that not every member may read and the requester
 * may: the ones a read as them could have drawn restricted content from. One
 * they may not read never reached them, and recording it would shut them out
 * of their own conversation.
 */
async function restrictingFolders(session: AgentPrincipal['session'], projectId: string): Promise<string[]> {
  const [rows, hidden] = await Promise.all([
    listProjectFolderTree(session.organizationId, projectId),
    getHiddenFolderIds(session, projectId),
  ])
  const tree = folderTree(rows)
  const unseen = new Set(hidden)
  return [...tree.keys()].filter((folderId) => !readableByEveryMember(tree, folderId) && !unseen.has(folderId))
}

/**
 * See the module docstring. True when the record is written and the read may
 * run; false when the conversation is no longer the requester's alone, and
 * nothing was recorded. A call outside a conversation records nothing.
 */
export async function recordSoloWorkspaceRead(principal: AgentPrincipal): Promise<boolean> {
  const conversationId = principal.conversationId
  if (!conversationId) return true
  const { organizationId, userId } = principal.session
  const answerMessageId = principal.answerMessageId ?? null
  return withTenant(tenantOf(principal), async () => {
    const folders = principal.projectId ? await restrictingFolders(principal.session, principal.projectId) : []
    return getDb().transaction(async (tx) => {
      await lockConversationAudience(tx, organizationId, conversationId)
      const audience = await readConversationAudience(tx, organizationId, conversationId)
      if (!isSoloAudience(audience, userId)) return false
      await recordSourceFolders(tx, organizationId, conversationId, folders)
      // As the internal route does at turn start: an answer in a conversation that
      // drew on a restricted folder can quote it, so it is marked (the SQL rule decides).
      if (answerMessageId) await markAnswerRestrictedUse(tx, organizationId, conversationId, answerMessageId)
      return true
    })
  })
}
