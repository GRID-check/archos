/**
 * The WORKSPACE block of a turn's context (ADR-0123): who is asking, where, and
 * what is open right now, so office work starts from the state instead of
 * spending its first rounds reading it.
 *
 * A write Piloti asks for through its MCP door becomes a proposal the person
 * accepts. Before this block, the turn that made one never learned its id, the
 * next turn saw only the proposals a person had already DECIDED
 * (`PROPOSAL_DECISIONS`), and a pending or failed one was invisible: Piloti
 * proposed the same thing again, or reported as done a write that had failed.
 * So the block lists this conversation's proposals with every status, which is
 * the memory of work in progress across turns, read from the server's record.
 *
 * Pure: `service.ts` loads the facts, this renders them, and the workspace eval's
 * fixture is written by this same function (`workspace-block.fixture.spec.ts`).
 * English, because the agent reads it; the summaries are the server's own lines.
 * Bounded, and says so: at most {@link MAX_WORKSPACE_PROPOSALS} proposals.
 * People other than the asker are never named here: the asker is the one person
 * the prompt already names (ADR-0091 keeps the Steckbrief's people out).
 */

import type { ProposedChangeKind, ProposedChangeStatus } from '@/lib/proposals/types'

export const WORKSPACE_BLOCK_HEADER = 'WORKSPACE v1'

/** Most of this conversation's proposals the block names, newest first. */
export const MAX_WORKSPACE_PROPOSALS = 8

/** Longest summary line the block carries per proposal. */
export const MAX_PROPOSAL_LINE_CHARS = 200

/** `unknown`: the audience could not be read, and the agent is told so rather than told it is alone. */
export type ConversationAudience = 'solo' | 'shared' | 'unknown'

export interface WorkspaceProposalFact {
  id: string
  kind: ProposedChangeKind
  status: ProposedChangeStatus
  /** The line the person read on the card. */
  summary: string
  /** Why it failed, or what an applied write created, when the server recorded it. */
  outcome?: string | null
}

export interface WorkspaceFacts {
  /** The asker's organization role slug, as the session holds it. */
  organizationRole: string | null
  /** The asker's derived role in the turn's project (`requireProjectAccess`); null outside a project. */
  projectRole: string | null
  /** The project the turn runs in; null outside a project, or when it could not be read. */
  project: { id: string; name: string; status: string } | null
  /** The conversation the turn answers in; null for a run with none. */
  conversation: { id: string; audience: ConversationAudience } | null
  /** Inbox items that wait for the asker; null when it could not be read. */
  inboxWaiting: number | null
  /** Task runs queued or running in the project; null outside a project or when unread. */
  activeRuns: number | null
  /** This conversation's proposals, newest first, any status; at most {@link MAX_WORKSPACE_PROPOSALS}. */
  proposals: WorkspaceProposalFact[]
  /** More proposals exist than {@link WorkspaceFacts.proposals} holds. */
  proposalsTruncated: boolean
  /**
   * The office's conventions, header first (`lib/office-conventions`,
   * ADR-0129), on a question about filing or finding with the switch on.
   * Rendered last, so a bound on the block cuts them before the proposals.
   */
  officeConventions?: readonly string[] | null
}

const STATUS_WORDS: Record<ProposedChangeStatus, string> = {
  proposed: 'waiting for the person',
  applied: 'applied',
  partially_applied: 'partly applied',
  failed: 'failed',
  dismissed: 'dismissed by the person',
}

const clip = (text: string, max: number): string => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

function proposalLine(proposal: WorkspaceProposalFact): string {
  const parts = [proposal.id, STATUS_WORDS[proposal.status], `${proposal.kind}: ${clip(proposal.summary, MAX_PROPOSAL_LINE_CHARS)}`]
  if (proposal.outcome && proposal.outcome.trim()) parts.push(clip(proposal.outcome, MAX_PROPOSAL_LINE_CHARS))
  return `- ${parts.join(' · ')}`
}

function audienceLine(conversation: WorkspaceFacts['conversation']): string {
  if (!conversation) return 'conversation: none (a run outside a chat)'
  const audience = {
    solo: 'solo (only the asker reads it)',
    shared: 'shared (others read it, so no workspace read runs here; writes are still proposed)',
    unknown: 'audience unknown (a workspace read may be refused as in a shared conversation)',
  }[conversation.audience]
  return `conversation: ${conversation.id} · ${audience}`
}

/** The block as the agent reads it. */
export function renderWorkspaceBlock(facts: WorkspaceFacts): string {
  const lines = [
    `${WORKSPACE_BLOCK_HEADER} (the workspace as of this turn; the proposal list is the newest ${MAX_WORKSPACE_PROPOSALS})`,
    `asker: organization role ${facts.organizationRole ?? 'unknown'}` +
      (facts.projectRole ? ` · project role ${facts.projectRole}` : ''),
    facts.project
      ? `project: ${facts.project.name} · id ${facts.project.id} · ${facts.project.status}`
      : 'project: none (the turn runs on the organization)',
    audienceLine(facts.conversation),
  ]
  if (facts.inboxWaiting !== null) lines.push(`inbox: ${facts.inboxWaiting} item(s) wait for the asker`)
  if (facts.activeRuns !== null) lines.push(`runs: ${facts.activeRuns} queued or running in this project`)
  if (facts.conversation) {
    if (facts.proposals.length === 0) {
      lines.push('proposals made in this conversation: none')
    } else {
      lines.push(
        `proposals made in this conversation (newest first${facts.proposalsTruncated ? '; older ones not shown' : ''}):`,
        ...facts.proposals.map(proposalLine)
      )
    }
  }
  if (facts.officeConventions && facts.officeConventions.length > 0) lines.push(...facts.officeConventions)
  return lines.join('\n')
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * The line the person read for a proposal of any kind, from its payload, which
 * is unvalidated jsonb and read defensively. An operation carries its own
 * summary; the older kinds are named by what they do.
 */
export function proposalSummaryOf(kind: ProposedChangeKind, payload: unknown): string {
  const record = isRecord(payload) ? payload : {}
  if (kind === 'operation' && typeof record.summary === 'string') return record.summary
  if (kind === 'memory' && typeof record.content === 'string') return `remember: ${record.content}`
  if (kind === 'project_profile') return 'change the project profile'
  if (kind === 'file_operation') {
    const operation = typeof record.operation === 'string' ? record.operation : 'change'
    const count = Array.isArray(record.operations) ? record.operations.length : 1
    return `${operation} ${count} file(s)`
  }
  return kind
}

/** What an applied or failed proposal's results say, in one line; null when they say nothing. */
export function proposalOutcomeOf(results: unknown): string | null {
  if (!Array.isArray(results)) return null
  const said = results.flatMap((result) => {
    if (!isRecord(result)) return []
    if (result.ok === false && typeof result.reason === 'string') return [`failed: ${result.reason}`]
    if (result.ok === true && typeof result.itemId === 'string') return [`created ${result.itemId}`]
    return []
  })
  return said.length > 0 ? said.join('; ') : null
}
