/**
 * What a principal sees and may call on the agent door (ADR-0122).
 *
 * The routes stay the gate: every call runs the route's own `authz` as the
 * person. This module decides only two things the routes cannot know, because
 * they depend on WHO is calling rather than who they act for.
 *
 *  - What `tools/list` shows. The specification allows the list to vary by
 *    credentials. Who is offered what is `exposure.config.ts`, read by one
 *    function ({@link isExposedTo}) for every listing, search, describe and
 *    call on every door; what is offered to nobody on a door reads as an
 *    unknown name there ({@link isOnDoor}). An operation with a `sensitivity`
 *    (it widens who may do what, touches the organization's secrets or turns a
 *    control down) is then shown to an external agent only when the
 *    organization switched its class on (`agent-mcp-access`,
 *    `agent-mcp-secrets`, `agent-mcp-controls`), its client was granted the
 *    step-up scope AND that scope is enforced by WorkOS
 *    ({@link SENSITIVE_SCOPE_ENFORCED_BY_WORKOS}, off), and never to
 *    in-product Piloti.
 *  - Whether a call runs or is proposed. In-product Piloti never applies a write
 *    itself; the person accepts or dismisses it (ADR-0105).
 */

import { BACKEND_OPERATIONS, type BackendOperation, findBackendOperation } from './backend-operations'
import { AGENT_OPERATIONS, findOperation } from './catalog'
import { type AgentDoor, audienceOf, isExposedTo, isOnDoor } from './exposure'
import { AGENT_DOMAINS, type AgentDomain, type AgentOperation, type Sensitivity, annotationsOf } from './operation'
import type { AgentPrincipal } from './principal'

/** The scope an external client needs for operations with a `sensitivity`. */
export const SENSITIVE_SCOPE = 'piloti:sensitive'

/**
 * Whether {@link SENSITIVE_SCOPE} means anything yet. A token's scopes are only
 * as good as the authorization server that grants them: until the scope is
 * defined in WorkOS, granted only after the person's step-up consent, and that
 * is verified per environment, a client could carry the string without anyone
 * having agreed to it. So it is ignored, and no external agent sees a
 * sensitive operation. Flip this in the change that records the WorkOS setup
 * in `docs/architecture/agent-surface.md#sensitive-operations`, never before.
 */
export const SENSITIVE_SCOPE_ENFORCED_BY_WORKOS = false

export type { AgentDoor, Audience } from './exposure'
export { doorOfPrincipal, isOnDoor, nativeToolOf } from './exposure'

export type CallDecision = 'run' | 'propose'

/**
 * May `principal` see (and so name) `op`? The config decides who it is offered
 * to ({@link isExposedTo}); a sensitive operation is then also gated per call,
 * by the organization's opt-in and the token's scope ({@link maySeeSensitive}),
 * which never holds for Piloti.
 */
export function canSee(principal: AgentPrincipal, op: { readonly name: string; readonly sensitivity?: Sensitivity }): boolean {
  if (!isExposedTo(audienceOf(principal), op.name)) return false
  return !op.sensitivity || maySeeSensitive(principal, op.sensitivity)
}

/**
 * Whether an external principal may be offered an operation of class
 * `sensitivity`: the organization switched the class on, the scope means
 * something ({@link SENSITIVE_SCOPE_ENFORCED_BY_WORKOS}), and the client holds
 * it. `scopeEnforced` exists so the specs can reach the opt-in check.
 */
export function maySeeSensitive(
  principal: AgentPrincipal,
  sensitivity: Sensitivity,
  scopeEnforced: boolean = SENSITIVE_SCOPE_ENFORCED_BY_WORKOS,
): boolean {
  if (principal.actor !== 'external_agent') return false
  return (
    (principal.sensitiveOptIns ?? []).includes(sensitivity) && scopeEnforced && principal.scopes.includes(SENSITIVE_SCOPE)
  )
}

/** The domains a caller of `door` may search and be told about, in catalog order: those with an operation on it. */
export function visibleDomains(door: AgentDoor = 'office'): readonly AgentDomain[] {
  const onDoor = new Set<AgentDomain>([
    ...AGENT_OPERATIONS.filter((op) => isOnDoor(op.name, door)).map((op) => op.domain),
    ...BACKEND_OPERATIONS.filter((op) => isOnDoor(op.name, door)).map((op) => op.domain),
  ])
  return AGENT_DOMAINS.filter((domain) => onDoor.has(domain))
}

export function visibleOperations(principal: AgentPrincipal): readonly AgentOperation[] {
  return AGENT_OPERATIONS.filter((op) => canSee(principal, op))
}

/** The operation `name` if it exists AND the principal may see it; a hidden one reads as absent. */
export function findVisibleOperation(principal: AgentPrincipal, name: string): AgentOperation | undefined {
  const op = findOperation(name)
  return op && canSee(principal, op) ? op : undefined
}

/**
 * The Python agent's read tools (`backend-operations.ts`), by the same rule:
 * an outside agent on an office door sees them; Piloti has each as a native
 * tool (`native:<tool>` in the config); the platform door offers none.
 */
export function visibleBackendOperations(principal: AgentPrincipal): readonly BackendOperation[] {
  return BACKEND_OPERATIONS.filter((op) => canSee(principal, op))
}

export function findVisibleBackendOperation(principal: AgentPrincipal, name: string): BackendOperation | undefined {
  const op = findBackendOperation(name)
  return op && canSee(principal, op) ? op : undefined
}

export function callDecision(principal: AgentPrincipal, op: AgentOperation): CallDecision {
  if (principal.actor === 'external_agent') return 'run'
  return annotationsOf(op).readOnlyHint ? 'run' : 'propose'
}
