/**
 * What the project decided about the agent's own proposals.
 *
 * A `project_profile_patch` or `memory_proposal` card is a proposal; the
 * reader's Accept or Reject is recorded on the message (ADR-0030) and, until
 * this existed, nowhere the agent could read. So a declined patch came back
 * next turn, and the assistant read as not listening — the user's decision
 * was durable and invisible to the thing that made the proposal (ADR-0030's
 * own last open question).
 *
 * This renders those decisions as a bounded block that rides the memory
 * digest channel (`x-grid-project-memory` and the live per-turn fetch), so it
 * needed no new header and reaches every surface memory reaches, including a
 * background run. The prompt explains the block once, in the same place it
 * explains PROJECT_MEMORY.
 *
 * ## What is trusted here: nothing the row says
 *
 * The block rides every colleague's chat in the project, so it is a sink for
 * whatever a stored row holds. A message is written by the browser (`metadata`
 * is an open record, `createConversationMessages`), and so is
 * `cardInteractions` (the decision PATCH), so a stored card and its recorded
 * decision are the client's word: nothing on the row says the agent emitted the
 * card or that a person pressed Accept. A "decided through the server's own
 * path" filter would filter nothing, and checking the card against its schema
 * would pass a well-formed forgery. What the block can do is what a memory note
 * does: mask what it quotes where it reads it, under the policy as it stands
 * now (ADR-0086). That holds for every writer, including ones that do not exist
 * yet, and for rows stored before the policy changed.
 *
 * ## Two sources, one block
 *
 * A card that carries a `proposal_id` is a SERVER proposal (ADR-0105): who
 * decided it, and how, is the `proposed_changes` row's `status`, whoever's
 * window the click was in. Those rows are read here
 * (`./proposal-decision-rows.ts`) and described from their PAYLOAD, what was
 * applied, never from a card's `preview`. Such a card's `cardInteractions`
 * entry is ignored even when a browser wrote one: the row wins, and a proposal
 * is stated once. Cards without a `proposal_id` (older answers, a run with no
 * envelope) keep the browser's recorded decision.
 */

import 'server-only'
import { z } from 'zod'
import { maskChatText } from '@/lib/upload-screening/service'
import { listRecentMessagesWithCardDecisions } from '@/lib/conversations/repository'
import { buildPatchPreviewRows } from '@/lib/project-profile/patch-preview'
import { ProjectProfilePatchOperationSchema } from '@/lib/project-profile/types'
import { listRecentDecidedProposals, type DecidedProposalRow } from './proposal-decision-rows'
import {
  DIGEST_BLOCK_MAX_CHARS,
  formatBoundedDigest,
  type DigestLineItem,
} from '@/lib/knowledge/digest-format'

export const PROPOSAL_DECISIONS_HEADER = 'PROPOSAL_DECISIONS v1'
/** Messages scanned, newest first. Decisions are rare, so this reaches back far. */
const MESSAGE_SCAN_LIMIT = 40
/** Decisions kept, newest first. The next turn needs the recent ones, not the history. */
const MAX_DECISIONS = 10
/** Server rows are described from a payload, so one line is bounded here rather than by a card's own words. */
const ROW_LINE_MAX_CHARS = 240

type Decision =
  | 'accepted'
  | 'rejected'
  | 'savedOrg'
  | 'savedProject'
  | 'dismissed'
  | 'partiallyApplied'

const INSTANT = z.string().datetime({ offset: true })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

/** The verdict tag the model reads: a decision is either for or against. */
function verdictOf(decision: string): 'angenommen' | 'abgelehnt' | null {
  switch (decision as Decision) {
    case 'accepted':
    case 'savedOrg':
    case 'savedProject':
    // A partial application is a YES. What failed is a transport fact the next
    // turn cannot act on and the reader can see in the Files pane; what the
    // agent must not do is propose the same tidy-up again because some of it
    // did not land.
    case 'partiallyApplied':
      return 'angenommen'
    case 'rejected':
    case 'dismissed':
      return 'abgelehnt'
    default:
      return null
  }
}

/**
 * A stored `decidedAt` as an ISO instant, or null. It is rendered unescaped in
 * the line's tag bracket, so a value that is not a real instant (a stored row
 * is a client's word) must not get that far.
 */
function instantOf(value: unknown): string | null {
  // The decision PATCH holds `decidedAt` to this same schema; `Date.parse` alone
  // is lenient enough to accept text with an instant buried in it.
  const parsed = INSTANT.safeParse(value)
  return parsed.success ? new Date(parsed.data).toISOString() : null
}

/** One line of content for a card: what was proposed, in the card's own words. */
function describeCard(card: Record<string, unknown>): { kind: string; content: string } | null {
  const type = asString(card.type)
  if (type === 'project_profile_patch') {
    const title = asString(card.title) ?? 'Projektkontext aktualisieren'
    const preview = Array.isArray(card.preview) ? card.preview : []
    const changes = preview
      .filter(isRecord)
      .map((item) => {
        const label = asString(item.label)
        const before = asString(item.before)
        const after = asString(item.after)
        if (!label || !after) return null
        return before ? `${label}: ${before} → ${after}` : `${label}: ${after}`
      })
      .filter((change): change is string => change !== null)
      .slice(0, 3)
    return { kind: 'Profil', content: changes.length > 0 ? `${title} (${changes.join('; ')})` : title }
  }
  if (type === 'memory_proposal') {
    const content = asString(card.content)
    return content ? { kind: 'Notiz', content } : null
  }
  if (type === 'file_operation_proposal') {
    // The decision, in the words the card showed: the verb and what it named.
    // Enough for the next turn to know it must not propose this again — and
    // deliberately not the whole payload, which would spend the block's budget
    // on rows nobody will act on.
    const title = asString(card.title)
    const operation = asString(card.operation)
    const rows = Array.isArray(card.operations) ? card.operations : []
    const subjects = rows
      .filter(isRecord)
      .map((row) => asString(row.document) ?? asString(row.folder_name))
      .filter((subject): subject is string => subject !== undefined)
      .slice(0, 3)
    if (!title && !operation) return null
    const named = subjects.length > 0 ? ` (${subjects.join('; ')})` : ''
    return { kind: 'Ablage', content: `${title ?? operation}${named}` }
  }
  return null
}

interface DecidedProposal {
  decidedAt: string
  item: DigestLineItem
  /** Appended after masking: ours, not the row's words. */
  suffix?: string
  /** Cut after masking, so a cut cannot leave half of a masked value. */
  maxChars?: number
}

/** The decisions one stored message carries, paired with the cards they were about. */
function decisionsOf(metadata: unknown, fallbackDate: Date): DecidedProposal[] {
  if (!isRecord(metadata) || !isRecord(metadata.cardInteractions)) return []
  const cards = Array.isArray(metadata.cards) ? metadata.cards : []
  const out: DecidedProposal[] = []
  for (const [key, interaction] of Object.entries(metadata.cardInteractions)) {
    if (!isRecord(interaction)) continue
    const decision = asString(interaction.decision)
    const verdict = decision ? verdictOf(decision) : null
    if (!verdict) continue
    // The key is `${type}-${index}`; the index is positional into `cards`.
    // Positions stay aligned with what the reader saw: `validateGridCards`
    // never compacts the array, so the validated card at `index` is the same
    // proposal this raw row holds at `index` — or a hole, which is skipped
    // below like any other non-record.
    const index = Number(key.slice(key.lastIndexOf('-') + 1))
    const card = Number.isInteger(index) ? cards[index] : undefined
    if (!isRecord(card)) continue
    // A server proposal is stated from its row, once (`decisionOfRow`).
    if (asString(card.proposal_id)) continue
    const described = describeCard(card)
    if (!described) continue
    const decidedAt = instantOf(interaction.decidedAt) ?? fallbackDate.toISOString()
    out.push({
      decidedAt,
      item: { tags: [verdict, described.kind, decidedAt.slice(0, 10)], content: described.content },
    })
  }
  return out
}

const FILE_OPERATION_LABELS: Record<string, string> = {
  move: 'Verschieben',
  rename: 'Umbenennen',
  create_folder: 'Ordner anlegen',
  assign: 'Zuweisen',
}

/** `label: → value` per patch operation, derived from the PATCH that was applied. */
function describeProfilePatch(payload: Record<string, unknown>): string {
  const title = asString(payload.title) ?? 'Projektkontext aktualisieren'
  const operations = (Array.isArray(payload.patch) ? payload.patch : []).flatMap((operation) => {
    const parsed = ProjectProfilePatchOperationSchema.safeParse(operation)
    return parsed.success ? [parsed.data] : []
  })
  let lines: string[] = []
  try {
    lines = buildPatchPreviewRows(operations, null)
      .filter((row) => row.label && row.after)
      // An unknown's "after" is its own label: say it once.
      .map((row) => (row.after === row.label ? row.label : `${row.label}: → ${row.after}`))
      .slice(0, 3)
  } catch {
    // A value the formatters cannot read costs the detail, never the line.
  }
  return lines.length > 0 ? `${title} (${lines.join('; ')})` : title
}

function describeFileOperation(payload: Record<string, unknown>): string | null {
  const operation = asString(payload.operation)
  const label = operation ? (FILE_OPERATION_LABELS[operation] ?? operation) : null
  const items = (Array.isArray(payload.operations) ? payload.operations : []).filter(isRecord)
  const subjects = items
    .map((item) => {
      const subject = asString(item.document) ?? asString(item.folder_name)
      const renamed = asString(item.new_display_name)
      return subject && renamed && operation === 'rename' ? `${subject} → ${renamed}` : subject
    })
    .filter((subject): subject is string => subject !== undefined)
    .slice(0, 3)
  const target = items.length > 0 ? (asString(items[0].target_folder) ?? asString(items[0].member)) : undefined
  if (!label && subjects.length === 0) return null
  const named = subjects.length > 0 ? ` (${subjects.join('; ')})` : ''
  return `${label ?? 'Ablage'}${named}${target ? ` → ${target}` : ''}`
}

/** What one server proposal was, from its payload; null when the payload says nothing usable. */
function describePayload(kind: string, payload: unknown): { kind: string; content: string } | null {
  if (!isRecord(payload)) return null
  if (kind === 'project_profile') return { kind: 'Profil', content: describeProfilePatch(payload) }
  if (kind === 'memory') {
    const content = asString(payload.content)
    return content ? { kind: 'Notiz', content } : null
  }
  if (kind === 'file_operation') {
    const content = describeFileOperation(payload)
    return content ? { kind: 'Ablage', content } : null
  }
  return null
}

/**
 * The decision a server row records. `applied` and `partially_applied` are a
 * yes (what failed is a transport fact; the partial one says so, but the verdict
 * is the reader's), `dismissed` a no. `failed` never reaches here: nothing went
 * through, so the reader said neither.
 */
function decisionOfRow(row: DecidedProposalRow): DecidedProposal | null {
  const described = describePayload(row.kind, row.payload)
  if (!described || Number.isNaN(row.decidedAt.getTime())) return null
  const decidedAt = row.decidedAt.toISOString()
  const verdict = row.status === 'dismissed' ? 'abgelehnt' : 'angenommen'
  return {
    decidedAt,
    item: { tags: [verdict, described.kind, decidedAt.slice(0, 10)], content: described.content },
    suffix: row.status === 'partially_applied' ? ' (teilweise angewendet)' : undefined,
    maxChars: ROW_LINE_MAX_CHARS,
  }
}

/**
 * The block, or null when the project has decided nothing yet — callers omit
 * it rather than injecting a bare header, exactly as the memory digest does.
 */
export async function buildProposalDecisionsBlock(
  projectId: string,
  organizationId: string,
): Promise<string | null> {
  const [messageRows, proposalRows] = await Promise.all([
    listRecentMessagesWithCardDecisions(projectId, organizationId, MESSAGE_SCAN_LIMIT),
    listRecentDecidedProposals(projectId, organizationId, MESSAGE_SCAN_LIMIT),
  ])
  const decided = [
    ...messageRows.flatMap((row) => decisionsOf(row.metadata, row.createdAt)),
    ...proposalRows.flatMap((row) => decisionOfRow(row) ?? []),
  ]
    .sort((a, b) => (a.decidedAt < b.decidedAt ? 1 : a.decidedAt > b.decidedAt ? -1 : 0))
    .slice(0, MAX_DECISIONS)
  // Masked after the cut, so the policy is applied to the lines that can ride
  // at most, and before the digest's own bound, so a placeholder is what spends it.
  const masked = await Promise.all(
    decided.map(async ({ item, suffix, maxChars }) => {
      const { text } = await maskChatText(organizationId, item.content)
      const cut = maxChars && text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text
      return { ...item, content: `${cut}${suffix ?? ''}` }
    }),
  )
  return formatBoundedDigest(PROPOSAL_DECISIONS_HEADER, masked, DIGEST_BLOCK_MAX_CHARS)
}

/**
 * The memory channel, as one header value: the digest, what the project decided
 * about the agent's own proposals, and what a reviewer decided about the drafts
 * this conversation filed (`lib/documents/review-decisions.ts`).
 *
 * Three blocks on one channel rather than three headers, for the reason the
 * second one is here at all: `x-grid-project-memory` already reaches every
 * surface memory reaches — the WS upgrade, the live per-turn digest fetch and a
 * background run — and a new header would have to be added to each of them and
 * to the envelope's TS/Python twins. Each block is bounded on its own and each
 * is null when it has nothing to say, so a turn with no decisions carries
 * exactly what it carried before.
 */
export function composeMemoryContext(
  digest: string | null,
  decisions: string | null,
  reviewDecisions: string | null = null,
): string | null {
  const parts = [digest, decisions, reviewDecisions].filter((part): part is string =>
    Boolean(part && part.trim()),
  )
  return parts.length > 0 ? parts.join('\n\n') : null
}
