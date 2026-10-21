import 'server-only'
/**
 * Piloti's writes through the MCP surface are proposals (ADR-0121, ADR-0105).
 *
 * When the in-product agent calls a WRITE operation of the catalog, nothing is
 * applied. `proposeOperation` files an `operation` proposal in the turn's
 * conversation, through the same service as every other kind (`createProposal`,
 * the one the internal proposals route calls), and a person accepts or dismisses
 * it on its card. Accepting runs the operation as the ACCEPTING person
 * (`lib/proposals/operation-applier.ts`), so the route's own authorization
 * decides, not the agent's.
 */

import type { AuthorizedSession } from '@/lib/auth/types'
import { createProposal } from '@/lib/proposals/service'
import { MAX_OPERATION_SUMMARY_LENGTH, type OperationPayload } from '@/lib/proposals/types'
import type { OperationInput } from './dispatch'
import type { AgentOperation } from './operation'

/** Longest value quoted from the input in the summary. */
const VALUE_LENGTH = 60
/** Most inputs named in the summary. */
const MAX_FACTS = 4

const isScalar = (value: unknown): value is string | number | boolean =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** `key: value` for each scalar of `record`, in order, each clipped. */
function factsOf(record: Record<string, unknown> | undefined): string[] {
  if (!record) return []
  return Object.entries(record).flatMap(([key, value]) =>
    isScalar(value) && String(value).trim()
      ? [`${key}: ${clip(String(value).replace(/\s+/g, ' ').trim(), VALUE_LENGTH)}`]
      : []
  )
}

/** The scalar fields of the body, when it is an object. */
function bodyFacts(body: unknown): string[] {
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? factsOf(body as Record<string, unknown>)
    : []
}

/**
 * A short English line for the person: the operation's own summary and its key
 * inputs, e.g. `Rename a document (name: Plan v2.pdf)`. Path parameters come
 * last because they are ids; the body's and the query's scalars come first.
 */
export function summaryOfOperation(op: AgentOperation, input: OperationInput): string {
  const facts = [...bodyFacts(input.body), ...factsOf(input.query), ...factsOf(input.params)].slice(0, MAX_FACTS)
  const line = facts.length > 0 ? `${op.summary.replace(/\.$/, '')} (${facts.join(', ')})` : op.summary
  return clip(line, MAX_OPERATION_SUMMARY_LENGTH)
}

/**
 * File the proposal for `op` called with `input` by the agent acting for
 * `principal.session`'s person. Refused (422) when the operation only reads, or
 * the input does not fit its schemas, or the turn is in no project. Returns the
 * proposal's id, which the card carries, and the line the person will read.
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
  }
  op: AgentOperation
  input: OperationInput
}): Promise<{ proposalId: string; summary: string }> {
  const summary = summaryOfOperation(op, input)
  const payload: OperationPayload = {
    operation: op.name,
    input: { params: input.params, query: input.query, body: input.body },
    summary,
  }
  const row = await createProposal(principal.session, {
    projectId: principal.projectId ?? null,
    kind: 'operation',
    payload,
    conversationId: principal.conversationId ?? null,
    answerMessageId: null,
  })
  return { proposalId: row.id, summary }
}
