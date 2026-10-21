/**
 * What a principal sees and may call on the agent door (ADR-0121).
 *
 * The routes stay the gate: every call runs the route's own `authz` as the
 * person. This module decides only two things the routes cannot know, because
 * they depend on WHO is calling rather than who they act for.
 *
 *  - What `tools/list` shows. The specification allows the list to vary by
 *    credentials. An operation with a `sensitivity` (it widens who may do what,
 *    or touches the organization's secrets) is shown to an external agent only
 *    when its client was granted the step-up scope.
 *  - Whether a call runs or is proposed. In-product Piloti never applies a write
 *    itself; the person accepts or dismisses it (ADR-0105).
 */

import { AGENT_OPERATIONS, findOperation } from './catalog'
import type { AgentOperation } from './operation'
import type { AgentPrincipal } from './principal'

/** The scope an external client needs for operations with a `sensitivity`. */
export const SENSITIVE_SCOPE = 'piloti:sensitive'

export type CallDecision = 'run' | 'propose'

export function isReadOnly(op: AgentOperation): boolean {
  return op.readOnly ?? op.method === 'GET'
}

/** May `principal` see (and so name) `op`? */
export function canSee(principal: AgentPrincipal, op: AgentOperation): boolean {
  if (!op.sensitivity) return true
  // Piloti sees them: its writes become proposals the person confirms.
  return principal.kind === 'piloti' || principal.scopes.includes(SENSITIVE_SCOPE)
}

export function visibleOperations(principal: AgentPrincipal): readonly AgentOperation[] {
  return AGENT_OPERATIONS.filter((op) => canSee(principal, op))
}

/** The operation `name` if it exists AND the principal may see it; a hidden one reads as absent. */
export function findVisibleOperation(principal: AgentPrincipal, name: string): AgentOperation | undefined {
  const op = findOperation(name)
  return op && canSee(principal, op) ? op : undefined
}

export function callDecision(principal: AgentPrincipal, op: AgentOperation): CallDecision {
  if (principal.kind === 'person') return 'run'
  return isReadOnly(op) ? 'run' : 'propose'
}
