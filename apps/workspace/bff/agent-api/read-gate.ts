import 'server-only'
/**
 * What Piloti may read through the MCP surface, judged by who reads the
 * conversation it answers in (ADR-0093, ADR-0094, ADR-0122).
 *
 * A read runs as the requester, with the requester's rights, and its answer
 * lands in the conversation's transcript. It is held to ADR-0094's one rule,
 * the rule `project_lookup` follows: what it names must lie in the reach of the
 * conversation's AUDIENCE, and what it hands out is recorded on the conversation
 * before it runs (`conversation-audience.ts` decides and records):
 *
 *  - In a conversation that is the requester's alone, a read of the turn's own
 *    project runs on the record of its restricted folders, and a read of
 *    another project the requester may chat in runs on a cross-project
 *    hand-out (that project and the restricted folders the read may carry). A
 *    read whose answer spans the office's projects (`spansProjects`) is still
 *    refused in a project's conversation.
 *  - In a conversation someone else reads too, only a read listed in
 *    {@link AUDIENCE_READS} runs: its answer is one document's content, or one
 *    project's facts, which is what every reader of that place reads. The place
 *    must be the conversation's own project or one in the audience's reach, and
 *    never a restricted folder or a held file. Every other read answers with the
 *    requester's own view and is refused with {@link sharedConversationReadRefusal}.
 *    Writes still become proposals.
 *  - A call that belongs to no conversation (an external agent, a run with no
 *    chat) writes no transcript, and passes.
 *
 * One gate per principal, and the principal is built per HTTP request, so the
 * audience is read once per request and never outlives it. Each read is
 * recorded under the audience lock, checked against that audience, so a share
 * that slipped in since refuses the read.
 */

import {
  type ConversationAudience,
  type ReadCarries,
  READ_REFUSALS,
  conversationAudienceOf,
  judgeWorkspaceRead,
  ownRestrictingFolders,
  recordWorkspaceHandOut,
} from './conversation-audience'
import type { AgentOperation } from './operation'
import type { TargetInput } from './operation-targets'
import type { AgentPrincipal } from './principal'

/**
 * The reads Piloti runs in a shared conversation, each with what its answer is
 * and why that answer is the same for every reader who may read the place it
 * names. Everything else a route answers is the requester's view. Adding one is
 * a claim a reviewer can check against the route: a link-bearing read
 * ({@link LINK_BEARING_OPERATIONS}) never qualifies. A read with a query says
 * in `narrows` why the query only cuts the same answer shorter and names no
 * other place; `read-gate.spec.ts` holds its keys to that.
 */
export const AUDIENCE_READS: Readonly<Record<string, { carries: ReadCarries; reason: string; narrows?: string }>> = {
  'document-get': { carries: 'document', reason: 'the document as its listing row, which every reader of it sees' },
  'document-text-get': { carries: 'document', reason: 'the document’s own text, which every reader of it reads' },
  'document-sketch-get': {
    carries: 'document',
    reason: 'the sketch’s own scene and outline, which every reader of its picture sees',
    narrows: '`scene=omit` and `ids` (element ids inside the sketch) leave parts of the same answer out',
  },
  'project-get': { carries: 'projectFacts', reason: 'the project row, gated by project:view alone' },
  'project-profile-get': { carries: 'projectFacts', reason: 'the project’s profile, gated by project:view alone' },
}

/**
 * Reads whose answer is a link that works for whoever holds it (a presigned
 * URL, minted for the requester). Never in {@link AUDIENCE_READS}: the link
 * would reach every reader of the transcript with the requester's access.
 */
export const LINK_BEARING_OPERATIONS: ReadonlySet<string> = new Set([
  'document-download',
  'document-preview-get',
  'document-thumbnail-get',
  'bim-model-source-get',
])

/** The sentence the model relays when a read is refused in a shared conversation. */
export function sharedConversationReadRefusal(): string {
  return READ_REFUSALS.shared
}

export interface ReadGate {
  /**
   * Before a read of `op` with `input` runs: `null` when it may run, else the
   * refusal the model relays. The record is written before this resolves; a
   * failure to read the audience, to resolve what the call names or to record
   * rejects, and the read must not run. A backend read (no `path`) names
   * nothing here, and runs only in a solo conversation.
   */
  beforeRead(
    op: {
      readonly name: string
      readonly domain: AgentOperation['domain']
      readonly path?: AgentOperation['path']
      readonly spansProjects?: AgentOperation['spansProjects']
    },
    input?: TargetInput,
  ): Promise<string | null>
  /** After a read ran: whether its answer may hand on a link (a redirect, a `resource_link`). */
  mayHandOnLink(): Promise<boolean>
}

const gates = new WeakMap<AgentPrincipal, ReadGate>()

function buildGate(principal: AgentPrincipal): ReadGate {
  let audience: Promise<ConversationAudience | null> | undefined
  let ownFolders: Promise<string[]> | undefined
  const audienceOnce = () => (audience ??= conversationAudienceOf(principal))
  return {
    async beforeRead(op, input = {}) {
      const now = await audienceOnce()
      if (!now) return null
      const shape = op.path ? { path: op.path, spansProjects: op.spansProjects } : null
      const judged = await judgeWorkspaceRead(principal, now, shape, input, AUDIENCE_READS[op.name]?.carries, () =>
        (ownFolders ??= ownRestrictingFolders(principal)),
      )
      if ('refusal' in judged) return judged.refusal
      // Shared or re-shared since the audience was read: the lock saw it, nothing was recorded, nothing runs.
      return (await recordWorkspaceHandOut(principal, now, judged.handOut)) ? null : READ_REFUSALS.audienceChanged
    },
    async mayHandOnLink() {
      const now = await audienceOnce()
      return !now || now.solo
    },
  }
}

/** The gate for this principal's request. */
export function readGateFor(principal: AgentPrincipal): ReadGate {
  let gate = gates.get(principal)
  if (!gate) {
    gate = buildGate(principal)
    gates.set(principal, gate)
  }
  return gate
}
