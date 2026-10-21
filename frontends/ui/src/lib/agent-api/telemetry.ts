import 'server-only'
/**
 * What the agent door records about each call (ADR-0119, ADR-0089).
 *
 *  - PostHog, through the collector: `agent_operation_called` and
 *    `agent_operation_missing` (`docs/observability/posthog-events.md`), for
 *    product analytics: which operations agents use and which they miss.
 *  - Langfuse: one `agent-tool-call` trace per MCP tool call and per A2A
 *    method's call of an ask route (`lib/langfuse/tool-call-trace.ts`), the
 *    observability platform's view of the same call, beside the chat turns it
 *    belongs to.
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

/** Where a call came in: the MCP server for an external agent or for Piloti, or the A2A door. */
export type CallDoor = 'mcp' | 'piloti' | 'a2a'

export interface McpCallContext {
  principal: AgentPrincipal
  /** The MCP server's mode; null on the A2A door, which has none. */
  mode: McpMode | null
  /** Set by a door that is not the MCP server (`a2a`); otherwise read from the principal. */
  door?: CallDoor
}

const doorOf = ({ principal, door }: McpCallContext): CallDoor =>
  door ?? (principal.actor === 'external_agent' ? 'mcp' : 'piloti')

export function recordOperationCalled(
  ctx: McpCallContext,
  call: {
    /** A catalog name, or null for a name no operation has: that is the agent's own text. */
    operation: string | null
    domain: string | null
    decision: CallDecision | 'refused'
    status: number
    startedAt: number
  },
): void {
  const { principal, mode } = ctx
  const endedAt = Date.now()
  // Not awaited: a call never waits for, or fails because of, Langfuse.
  void recordToolCallTrace({
    operation: call.operation,
    domain: call.domain,
    door: doorOf(ctx),
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
      door: doorOf(ctx),
      mode,
      decision: call.decision,
      status: call.status,
      duration_ms: endedAt - call.startedAt,
      client_id: principal.clientId,
    },
  })
}

export function recordOperationMissing(ctx: McpCallContext, descriptionLength: number): void {
  const { principal, mode } = ctx
  captureServer({
    event: 'agent_operation_missing',
    distinctId: principal.session.userId,
    organizationId: principal.session.organizationId,
    properties: {
      description_length: descriptionLength,
      door: doorOf(ctx),
      mode,
      client_id: principal.clientId,
    },
  })
}
