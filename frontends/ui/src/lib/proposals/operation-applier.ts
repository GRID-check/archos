/**
 * Proposed operations (`operation`, ADR-0121): any WRITE operation of the
 * agent catalog that Piloti called through the MCP surface, held as a proposal
 * until a person accepts it.
 *
 * Accepting runs it AS THE ACCEPTING PERSON through `callOperation`, the
 * dispatcher the MCP server itself uses, so the operation's route decides:
 * its `authz`, its rate limit, its tenant slot and its own body schema. The
 * proposal adds no second rule; `DECIDE_PERMISSIONS.operation` is only the
 * right to see the project.
 *
 * Two outcomes, as for every kind (`./appliers.ts`). What belongs to the
 * proposal is a failed result with the reason: the operation left the catalog
 * or became read-only since it was proposed, its input no longer fits, or the
 * route answered with a refusal (its own message). A refusal of the decider is
 * not special-cased: the route's 403 is the route's message, and the proposal
 * is `failed` with it.
 */

import 'server-only'
import { UnprocessableError } from '@/lib/api/errors'
import { callOperation, OperationInputError, parseOperationInput } from '@/lib/agent-api/dispatch'
import { findOperation } from '@/lib/agent-api/catalog'
import { annotationsOf, type AgentOperation } from '@/lib/agent-api/operation'
import type { ApplyContext } from './appliers'
import type { OperationPayload, ProposedChangeResult } from './types'

/** Why `name` cannot be applied as a proposal, or null when it can: it exists and it writes. */
function unusableReason(op: AgentOperation | undefined, name: string): string | null {
  if (!op) return `The operation ${name} no longer exists`
  if (annotationsOf(op).readOnlyHint) return `The operation ${name} only reads, so there is nothing to apply`
  return null
}

/** The operation a payload names, if it can still be applied. */
function usableOperation(name: string): { op: AgentOperation } | { reason: string } {
  const op = findOperation(name)
  const reason = unusableReason(op, name)
  return reason || !op ? { reason: reason ?? `The operation ${name} no longer exists` } : { op }
}

/**
 * Refuse when it is proposed what could only fail when it is applied (422): an
 * unknown or read-only operation, or an input its schemas reject.
 */
export function requireProposableOperation(payload: OperationPayload): void {
  const found = usableOperation(payload.operation)
  if ('reason' in found) throw new UnprocessableError(found.reason, { reason: 'proposal-operation-unusable' })
  try {
    parseOperationInput(found.op, payload.input)
  } catch (error) {
    if (error instanceof OperationInputError) {
      throw new UnprocessableError(error.message, { reason: 'proposal-operation-input' })
    }
    throw error
  }
}

/** The route's own words for a refusal: its error envelope's `error`, else a note with the status. */
function routeMessage(status: number, body: unknown): string {
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const message = (body as { error: unknown }).error
    if (typeof message === 'string' && message.trim()) return message
  }
  return `The operation failed (${status})`
}

const failed = (label: string, reason: string): ProposedChangeResult[] => [{ label, ok: false, reason }]

/** Run the proposal's operation as the deciding person: one result, the route's outcome. */
export async function applyOperation(
  payload: OperationPayload,
  context: ApplyContext
): Promise<ProposedChangeResult[]> {
  const label = payload.summary
  const found = usableOperation(payload.operation)
  if ('reason' in found) return failed(label, found.reason)
  try {
    const result = await callOperation(found.op, payload.input, context.session)
    return result.ok ? [{ label, ok: true }] : failed(label, routeMessage(result.status, result.body))
  } catch (error) {
    if (error instanceof OperationInputError) return failed(label, error.message)
    throw error
  }
}
