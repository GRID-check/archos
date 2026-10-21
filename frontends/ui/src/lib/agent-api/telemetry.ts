import 'server-only'
/**
 * What the agent door records about each call (ADR-0119, ADR-0089).
 *
 *  - PostHog, through the collector: `agent_operation_called` and
 *    `agent_operation_missing` (`docs/observability/posthog-events.md`), for
 *    product analytics: which operations agents use and which they miss.
 *  - Langfuse: one `agent-tool-call` trace per MCP tool call
 *    (`lib/langfuse/tool-call-trace.ts`), the observability platform's view of
 *    the same call, beside the chat turns it belongs to.
 *
 * Properties are scalars the catalog and the route already know. The text of an
 * agent's request never goes in: an agent quotes documents and names, and the
 * server events are non-personal by rule, so `agent_operation_missing` sends
 * the length of the description only.
 */

import { captureServer } from '@/lib/analytics/posthog-server'
import { recordToolCallTrace } from '@/lib/langfuse/tool-call-trace'
import type { CallDecision } from './policy'
import type { AgentPrincipal } from './principal'

export type McpMode = 'search' | 'tools'

export interface McpCallContext {
  principal: AgentPrincipal
  mode: McpMode
}

const doorOf = (principal: AgentPrincipal): 'mcp' | 'piloti' => (principal.actor === 'external_agent' ? 'mcp' : 'piloti')

export function recordOperationCalled(
  { principal, mode }: McpCallContext,
  call: {
    /** A catalog name, or null for a name no operation has: that is the agent's own text. */
    operation: string | null
    domain: string | null
    decision: CallDecision | 'refused'
    status: number
    startedAt: number
  },
): void {
  const endedAt = Date.now()
  // Not awaited: a call never waits for, or fails because of, Langfuse.
  void recordToolCallTrace({
    operation: call.operation,
    domain: call.domain,
    door: doorOf(principal),
    mode,
    decision: call.decision,
    status: call.status,
    startedAt: call.startedAt,
    endedAt,
    clientId: principal.clientId,
    organizationId: principal.session.organizationId,
    userId: principal.session.userId,
    conversationId: principal.conversationId ?? null,
  })
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
      duration_ms: endedAt - call.startedAt,
      client_id: principal.clientId,
    },
  })
}

export function recordOperationMissing({ principal, mode }: McpCallContext, descriptionLength: number): void {
  captureServer({
    event: 'agent_operation_missing',
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
