import 'server-only'
/**
 * What Piloti may read through the MCP surface, judged by who reads the
 * conversation it answers in (ADR-0093, ADR-0094, ADR-0121).
 *
 * A read runs as the requester, with the requester's rights, and its answer
 * lands in the conversation's transcript. The agent's own retrieval tools are
 * held to the conversation's AUDIENCE: they search only folders everyone who
 * reads the conversation may read, and record what they use before the model
 * sees it (the internal restricted-use route, `admitSourceFolders`). A
 * workspace read cannot be held that way: a route answers for one person, and
 * nothing in its answer says which folder or project the content came from.
 * So the gate fails closed:
 *
 *  - In a conversation someone else reads too (shared with named people,
 *    visible to the project or the office), Piloti runs no workspace read and
 *    no backend read. The model relays {@link sharedConversationReadRefusal}.
 *    Writes still become proposals: those run as whoever accepts them. A
 *    domain whose every answer each reader of the conversation may read could
 *    be listed in {@link AUDIENCE_SAFE_READ_DOMAINS}; none is today (project
 *    names, the member list's admin-only fields, a person's inbox and tasks
 *    all depend on who asks).
 *  - In a conversation that is the requester's alone, the read runs, after the
 *    restricted folders it may have drawn on are recorded and the turn's
 *    answer is marked (`recordSoloWorkspaceRead`), once per MCP request, so
 *    a later share is judged against them.
 *  - A call that belongs to no conversation (an external agent, a run with no
 *    chat) writes no transcript, and passes.
 *
 * One gate per principal, and the principal is built per HTTP request, so the
 * audience is read once per request and never outlives it.
 */

import { getDictionary } from '@/i18n/dictionaries'
import { AGENT_REFUSAL_LOCALE } from '@/lib/conversations/restricted-egress'
import { type ConversationReach, conversationReachOf, recordSoloWorkspaceRead } from './conversation-audience'
import type { AgentDomain } from './operation'
import type { AgentPrincipal } from './principal'

/** Domains Piloti may read in a shared conversation. Empty: see the module docstring before adding one. */
export const AUDIENCE_SAFE_READ_DOMAINS: ReadonlySet<AgentDomain> = new Set<AgentDomain>()

/**
 * Reads whose answer is a link that works for whoever holds it (a presigned
 * URL, minted for the requester). Refused in a shared conversation even if
 * their domain were ever listed in {@link AUDIENCE_SAFE_READ_DOMAINS}: the link
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
  return getDictionary(AGENT_REFUSAL_LOCALE).errors.agentSurface.sharedConversationRead
}

export interface ReadGate {
  /**
   * Before a read runs: `null` when it may run, else the refusal the model
   * relays. In a solo conversation the record is written before this resolves;
   * a failure to read the audience or to record rejects, and the read must not run.
   */
  beforeRead(op: { readonly name: string; readonly domain: AgentDomain }): Promise<string | null>
  /** After a read ran: whether its answer may hand on a link (a redirect, a `resource_link`). */
  mayHandOnLink(): Promise<boolean>
}

const gates = new WeakMap<AgentPrincipal, ReadGate>()

function buildGate(principal: AgentPrincipal): ReadGate {
  let reach: Promise<ConversationReach> | undefined
  let recorded: Promise<void> | undefined
  const reachOnce = () => (reach ??= conversationReachOf(principal))
  return {
    async beforeRead(op) {
      const now = await reachOnce()
      if (now === 'none') return null
      if (now === 'shared') {
        const safe = AUDIENCE_SAFE_READ_DOMAINS.has(op.domain) && !LINK_BEARING_OPERATIONS.has(op.name)
        return safe ? null : sharedConversationReadRefusal()
      }
      await (recorded ??= recordSoloWorkspaceRead(principal))
      return null
    },
    async mayHandOnLink() {
      return (await reachOnce()) !== 'shared'
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
