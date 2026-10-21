import 'server-only'
/**
 * Who reads the conversation Piloti answers in, and what a workspace read
 * leaves behind there (ADR-0093, ADR-0094, ADR-0121).
 *
 * Piloti's MCP reads run as the requester, with the requester's rights. What
 * they return lands in the conversation's transcript, which everyone the
 * conversation is shared with reads. These are the two database questions
 * `read-gate.ts` asks about that; the gate decides with the answers.
 *
 *  - {@link conversationReachOf}: is the conversation the requester's alone
 *    (`isSoloAudience`, the rule `audienceReach` uses for
 *    `restrictedFolders`)? A conversation with no row yet is: its first turn
 *    creates it, private, for the requester.
 *  - {@link recordSoloWorkspaceRead}: in a solo conversation, record the
 *    restricted folders the read may have drawn on before the content reaches
 *    the model, the way the agent's own tools do through the internal
 *    restricted-use route (`admitSourceFolders`, then the turn's answer is
 *    marked in `message_restricted_use`). An operation's answer does not say
 *    which folder its content came from, so every folder of the turn's
 *    project that restricts someone and that the requester may read is
 *    recorded: a later share is judged against all of them. That over-records
 *    on purpose; under-recording is the leak.
 */

import { listProjectFolderTree } from '@/lib/authz/folder-access-repository'
import { folderTree, readableByEveryMember } from '@/lib/authz/folder-access'
import { isSoloAudience } from '@/lib/conversations/cross-project-use'
import { ADMISSION_MAX_COLLECTIONS, admitSourceFolders, markTurnAnswer } from '@/lib/conversations/restricted-use'
import { readConversationAudience } from '@/lib/conversations/restricted-use-repository'
import { getDb } from '@/lib/db'
import { withTenant } from '@/lib/db/tenant-context'
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

/** The folders of `projectId` that not every member may read; the ones a read could have drawn restricted content from. */
async function restrictingFolders(organizationId: string, projectId: string): Promise<string[]> {
  const tree = folderTree(await listProjectFolderTree(organizationId, projectId))
  return [...tree.keys()].filter((folderId) => !readableByEveryMember(tree, folderId))
}

/** See the module docstring. A call outside a conversation records nothing. */
export async function recordSoloWorkspaceRead(principal: AgentPrincipal): Promise<void> {
  const conversationId = principal.conversationId
  if (!conversationId) return
  const { organizationId, userId } = principal.session
  const request = {
    organizationId,
    conversationId,
    userId,
    projectId: principal.projectId ?? null,
    answerMessageId: principal.answerMessageId ?? null,
  }
  await withTenant(tenantOf(principal), async () => {
    const folders = principal.projectId ? await restrictingFolders(organizationId, principal.projectId) : []
    // One admission names at most ADMISSION_MAX_COLLECTIONS folders; a project with more is admitted in parts.
    for (let start = 0; start < folders.length; start += ADMISSION_MAX_COLLECTIONS) {
      await admitSourceFolders(request, folders.slice(start, start + ADMISSION_MAX_COLLECTIONS))
    }
    // As the internal route does at turn start: an answer in a conversation that
    // already drew on a restricted folder can quote it, so it is marked too.
    await markTurnAnswer(request)
  })
}
