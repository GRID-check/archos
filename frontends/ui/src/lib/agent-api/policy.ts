/**
 * What a principal sees and may call on the agent door (ADR-0121).
 *
 * The routes stay the gate: every call runs the route's own `authz` as the
 * person. This module decides only two things the routes cannot know, because
 * they depend on WHO is calling rather than who they act for.
 *
 *  - What `tools/list` shows. The specification allows the list to vary by
 *    credentials. Only what is on the door is shown at all ({@link isOnDoor}):
 *    a withheld operation, or one of a domain the door does not offer, reads as
 *    an unknown name to everyone. An operation with a `sensitivity` (it widens who may do what,
 *    or touches the organization's secrets) is shown to an external agent only
 *    when the organization switched its class on (`agent-mcp-access`,
 *    `agent-mcp-secrets`), its client was granted the step-up scope AND that
 *    scope is enforced by WorkOS ({@link SENSITIVE_SCOPE_ENFORCED_BY_WORKOS},
 *    off), and never to in-product Piloti, which also never sees the
 *    `platform` domain.
 *  - Whether a call runs or is proposed. In-product Piloti never applies a write
 *    itself; the person accepts or dismisses it (ADR-0105).
 */

import { BACKEND_OPERATIONS, type BackendOperation, findBackendOperation } from './backend-operations'
import { AGENT_OPERATIONS, findOperation } from './catalog'
import { AGENT_DOMAINS, type AgentDomain, type AgentOperation, type Sensitivity, annotationsOf } from './operation'
import type { AgentPrincipal } from './principal'
import { isPilotiAskOperation } from '@/lib/piloti-asks/ask-wire'

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

/**
 * The doors agents reach the catalog through. `office` is every door an office's
 * agents use: `/api/mcp`, the A2A door (`/api/a2a`) and Piloti's own workspace
 * door. The operator console (`platform`) is GRID's, not an office's: every
 * write there (defaults, prices, keys) reaches every tenant. It is planned as a
 * second server for platform staff (`/api/platform/mcp`), a door of its own that
 * offers exactly that domain; its operations need no change for it.
 */
export type AgentDoor = 'office'

/** The domains each door offers. */
export const DOOR_DOMAINS: Readonly<Record<AgentDoor, ReadonlySet<AgentDomain>>> = {
  office: new Set(AGENT_DOMAINS.filter((domain) => domain !== 'platform')),
}

/**
 * Whether `op` is offered on `door` at all, to anyone: not withheld
 * (ADR-0121, "Amendment: the door offers what only Piloti has") and of a
 * domain the door offers. The one rule every listing, search, describe, call,
 * proposal and apply goes through; an operation off the door reads as an
 * unknown name.
 */
export function isOnDoor(op: AgentOperation, door: AgentDoor = 'office'): boolean {
  return op.withheld === undefined && DOOR_DOMAINS[door].has(op.domain)
}

/**
 * Operations in-product Piloti never sees nor files: deciding a proposal and
 * undoing a change Piloti made. A proposal is how the person says yes or no to
 * Piloti (ADR-0105); a card that applies or dismisses another proposal would
 * turn one click on a card the agent worded into a yes to a change the person
 * never read, and an undo the agent proposes is the same decision made for them.
 * `lib/proposals/operation-applier.ts` refuses them at the click as well.
 */
export const PILOTI_HIDDEN_OPERATIONS: ReadonlySet<string> = new Set([
  'proposal-apply',
  'proposal-dismiss',
  'piloti-change-undo',
])

export type CallDecision = 'run' | 'propose'

/** May `principal` see (and so name) `op`? */
export function canSee(principal: AgentPrincipal, op: AgentOperation): boolean {
  if (!isOnDoor(op)) return false
  if (principal.actor === 'piloti') {
    // Piloti may not propose a sensitive operation (`proposeOperation` refuses it too),
    // so showing one would only teach the model a call that cannot succeed. An ask is
    // how another agent consults Piloti: Piloti never asks Piloti (ADR-0123, the
    // recursion lock), and `piloti-ask-get` is a read it would otherwise simply run.
    return (
      !op.sensitivity &&
      !PILOTI_HIDDEN_OPERATIONS.has(op.name) &&
      !isPilotiAskOperation(op.name)
    )
  }
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

/** The domains a caller of `door` may search and be told about, in catalog order. */
export function visibleDomains(door: AgentDoor = 'office'): readonly AgentDomain[] {
  return AGENT_DOMAINS.filter((domain) => DOOR_DOMAINS[door].has(domain))
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
 * The Python agent's read tools (`backend-operations.ts`). An outside agent
 * sees them; in-product Piloti does not, because it already has every one as a
 * native tool and a second copy would bloat its context and blur its tool choice.
 */
export function visibleBackendOperations(principal: AgentPrincipal): readonly BackendOperation[] {
  return principal.actor === 'piloti' ? [] : BACKEND_OPERATIONS
}

export function findVisibleBackendOperation(principal: AgentPrincipal, name: string): BackendOperation | undefined {
  return principal.actor === 'piloti' ? undefined : findBackendOperation(name)
}

export function callDecision(principal: AgentPrincipal, op: AgentOperation): CallDecision {
  if (principal.actor === 'external_agent') return 'run'
  return annotationsOf(op).readOnlyHint ? 'run' : 'propose'
}
