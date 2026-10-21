import 'server-only'
/**
 * The two agent-door events (ADR-0119, `docs/observability/posthog-events.md`).
 *
 * Properties are scalars the catalog and the route already know. The text of an
 * agent's request never goes in: an agent quotes documents and names, and the
 * server events are non-personal by rule, so `agent_capability_missing` sends
 * the length of the description only.
 */

import { captureServer } from '@/lib/analytics/posthog-server'
import type { CallDecision } from './policy'
import type { AgentPrincipal } from './principal'

export type McpMode = 'discovery' | 'tools'

export interface McpCallContext {
  principal: AgentPrincipal
  mode: McpMode
}

const doorOf = (principal: AgentPrincipal) => (principal.kind === 'person' ? 'mcp' : 'piloti')

export function recordOperationCalled(
  { principal, mode }: McpCallContext,
  call: {
    operation: string
    domain: string | null
    decision: CallDecision | 'refused'
    status: number
    startedAt: number
  },
): void {
  captureServer({
    event: 'agent_operation_called',
    distinctId: principal.session.userId,
    organizationId: principal.session.organizationId,
    properties: {
      operation: call.operation,
      domain: call.domain,
      door: doorOf(principal),
      mode,
      decision: call.decision,
      status: call.status,
      duration_ms: Date.now() - call.startedAt,
      client_id: principal.clientId,
    },
  })
}

export function recordCapabilityMissing({ principal, mode }: McpCallContext, descriptionLength: number): void {
  captureServer({
    event: 'agent_capability_missing',
    distinctId: principal.session.userId,
    organizationId: principal.session.organizationId,
    properties: {
      description_length: descriptionLength,
      door: doorOf(principal),
      mode,
      client_id: principal.clientId,
    },
  })
}
