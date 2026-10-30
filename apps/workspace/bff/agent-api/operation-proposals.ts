import 'server-only'
/**
 * Piloti's writes through the MCP surface are proposals (ADR-0122, ADR-0105).
 *
 * When the in-product agent calls a WRITE operation of the catalog, nothing is
 * applied. `proposeOperation` files an `operation` proposal in the turn's
 * conversation, through the same service as every other kind (`createProposal`,
 * the one the internal proposals route calls), and a person accepts or dismisses
 * it on its card. Accepting runs the operation as the ACCEPTING person
 * (`lib/proposals/operation-applier.ts`), so the route's own authorization
 * decides, not the agent's.
 */

import { ForbiddenError, UnprocessableError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { withTenant } from '@/lib/db/tenant-context'
import { createProposal } from '@/lib/proposals/service'
import { MAX_OPERATION_SUMMARY_LENGTH, type OperationPayload } from '@/lib/proposals/types'
import type { OperationInput } from './dispatch'
import { ProposalDeclined, type AgentOperation } from './operation'

/** A proposal filed: its id, the line the person reads, and the operation's warnings for the model (`checkProposal`). */
export interface ProposedOperation {
  proposalId: string
  summary: string
  warnings?: readonly string[]
}

import { proposalReachRefusal } from './conversation-audience'
import { requireTargetsReadable, targetsOf, TooManyTargetsError } from './operation-targets'

/** Why a sensitive operation is never proposed, in words the model relays. */
export function sensitiveProposalRefusal(op: Pick<AgentOperation, 'name'>): string {
  return (
    `Piloti cannot propose ${op.name}: it changes who may do what, touches the organization's secrets, ` +
    'or turns a security or compliance control down or off, so the person does it in Piloti themselves.'
  )
}

/**
 * Most characters of a proposed call's input, as JSON. The card shows every
 * value in full before it can be accepted, so the input must be one a person
 * can read through; a longer one is refused before anything is filed, and the
 * model is told to split it or to leave the change to the person.
 */
export const MAX_PROPOSED_INPUT_CHARS = 20_000

/** Why an input is too long to propose, in words the model relays. */
export function oversizedProposalRefusal(op: Pick<AgentOperation, 'name'>, length: number): string {
  return (
    `The input for ${op.name} is ${length} characters; a proposal the person reads in full on its card holds at most ` +
    `${MAX_PROPOSED_INPUT_CHARS}. Split the change into smaller calls, or let the person make it in Piloti themselves.`
  )
}

/** Longest value quoted from the input in the summary. */
const VALUE_LENGTH = 60
/** Most inputs named in the summary; the rest are counted, never dropped silently. */
const MAX_FACTS = 4

/** `text` cut to `max` characters, marked as cut. */
export const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/**
 * One input as the summary names it. A scalar is quoted (clipped; the card shows
 * it in full); a list or an object is named with its size, so a nested value is
 * never left out of the line without a trace.
 */
function factOf(key: string, value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    const text = String(value).replace(/\s+/g, ' ').trim()
    return text ? `${key}: ${clip(text, VALUE_LENGTH)}` : null
  }
  if (Array.isArray(value)) return `${key}: ${value.length} ${value.length === 1 ? 'item' : 'items'}`
  if (typeof value === 'object') {
    const fields = Object.keys(value)
    return `${key}: ${fields.length} ${fields.length === 1 ? 'field' : 'fields'}`
  }
  return null
}

/** `key: value` for each entry of `record`, in order. */
function factsOf(record: unknown): string[] {
  if (typeof record !== 'object' || record === null) return []
  if (Array.isArray(record)) return [factOf('body', record)].filter((fact): fact is string => fact !== null)
  return Object.entries(record).flatMap(([key, value]) => {
    const fact = factOf(key, value)
    return fact ? [fact] : []
  })
}

/**
 * A short English line for the person: the operation's own summary and its key
 * inputs, e.g. `Rename a document (name: Plan v2.pdf)`. Path parameters come
 * last because they are ids; the body's and the query's come first. Inputs past
 * the first few are counted (`+2 more`); the card lists every one in full.
 */
export function summaryOfOperation(op: AgentOperation, input: OperationInput): string {
  const all = [...factsOf(input.body), ...factsOf(input.query), ...factsOf(input.params)]
  const facts = all.slice(0, MAX_FACTS)
  if (all.length > facts.length) facts.push(`+${all.length - facts.length} more`)
  const line = facts.length > 0 ? `${op.summary.replace(/\.$/, '')} (${facts.join(', ')})` : op.summary
  return clip(line, MAX_OPERATION_SUMMARY_LENGTH)
}

/**
 * File the proposal for `op` called with `input` by the agent acting for
 * `principal.session`'s person. Refused (422) when the operation only reads,
 * the input does not fit its schemas, or it is longer than a person can read
 * through on the card ({@link MAX_PROPOSED_INPUT_CHARS}). Refused (403) for an
 * operation with a `sensitivity`, before anything is filed. Refused (404) when
 * the call names a project, document, folder or conversation the person whose
 * turn it is may not read: otherwise a member's Piloti could put a change to a
 * project the member cannot see in front of an admin who can, and the admin's
 * click would apply it (a confused deputy). Refused (403) in a shared
 * conversation when it names a project outside the audience's reach
 * (`proposalReachRefusal`, ADR-0094): its card sits where every reader reads
 * it. A turn in no project files it on the
 * organization (0176). The same call repeated in the conversation, for the same
 * person, while the first proposal is still open files nothing and returns that
 * one. Runs in the person's tenant scope: the conversation, the open proposal
 * and the insert are tenant rows. An operation's own `checkProposal` runs last:
 * its refusal reaches the model, and its `decline` files nothing (`ProposalDeclined`). Returns the
 * proposal's id, which the card carries, the line the person will read, and
 * the check's warnings for the model.
 */
export async function proposeOperation({
  principal,
  op,
  input,
}: {
  principal: {
    session: AuthorizedSession
    conversationId?: string | null
    projectId?: string | null
    /** The answer the turn is writing (`x-grid-answer-message-id`); stored as the proposal's origin message. */
    answerMessageId?: string | null
  }
  op: AgentOperation
  input: OperationInput
}): Promise<ProposedOperation> {
  // A sensitive operation widens who may do what, touches the organization's
  // secrets, or turns a control off. Accepting a proposal is one click on a card
  // the agent worded, which is not the confirmation such a change needs, so
  // Piloti files none (ADR-0122).
  if (op.sensitivity) throw new ForbiddenError(sensitiveProposalRefusal(op))
  const stored: OperationPayload['input'] = {
    params: input.params,
    query: input.query,
    body: input.body,
    // Kept, so accepting later still refuses to write over a version newer than the one the agent read.
    ...(input.ifMatch ? { ifMatch: input.ifMatch } : {}),
  }
  const length = JSON.stringify(stored).length
  if (length > MAX_PROPOSED_INPUT_CHARS) {
    throw new UnprocessableError(oversizedProposalRefusal(op, length), { reason: 'proposal-input-too-long' })
  }
  let targets
  try {
    targets = targetsOf(op, input)
  } catch (error) {
    if (error instanceof TooManyTargetsError) {
      throw new UnprocessableError(error.message, { reason: 'proposal-too-many-targets' })
    }
    throw error
  }
  const summary = summaryOfOperation(op, input)
  const payload: OperationPayload = { operation: op.name, input: stored, summary }
  const { session } = principal
  const filed = await withTenant({ organizationId: session.organizationId, userId: session.userId }, async () => {
    await requireTargetsReadable(session, targets)
    const outsideReach = await proposalReachRefusal(principal, targets)
    if (outsideReach) throw new ForbiddenError(outsideReach)
    // The operation's own check, as the person whose turn it is: what could only fail on the card fails here.
    const check = op.checkProposal ? await op.checkProposal(stored, session, { answerMessageId: principal.answerMessageId ?? null }) : {}
    if (check.decline !== undefined) throw new ProposalDeclined(check.decline)
    const row = await createProposal(session, {
      projectId: principal.projectId ?? null,
      kind: 'operation',
      payload,
      conversationId: principal.conversationId ?? null,
      answerMessageId: principal.answerMessageId ?? null,
    })
    return { row, warnings: check.warnings ?? [] }
  })
  return { proposalId: filed.row.id, summary, warnings: filed.warnings }
}
