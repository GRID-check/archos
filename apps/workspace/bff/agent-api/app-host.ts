/**
 * Whether a caller's client draws MCP Apps views (ADR-0142), apart from the
 * views themselves (`mcp-apps.ts`), so the dispatcher (`discovery.ts`) can ask
 * it without importing the server code that serves them.
 */

import { RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server'
import { audienceOf, doorOfPrincipal } from './exposure'
import type { McpCallContext } from './telemetry'

/** The extension's id, as a client declares it in `capabilities.extensions` (MCP Apps, "Capability Negotiation"). */
export const UI_EXTENSION = 'io.modelcontextprotocol/ui'

/**
 * Whether a 2026-07-28 request's client capabilities (`_meta`
 * `io.modelcontextprotocol/clientCapabilities`) declare that it renders MCP
 * Apps: the extension, with `text/html;profile=mcp-app` among its mime types.
 */
export function declaresMcpApps(capabilities: unknown): boolean {
  const extensions = isRecord(capabilities) ? capabilities.extensions : undefined
  const ui = isRecord(extensions) ? extensions[UI_EXTENSION] : undefined
  const mimeTypes = isRecord(ui) ? ui.mimeTypes : undefined
  return Array.isArray(mimeTypes) && mimeTypes.includes(RESOURCE_MIME_TYPE)
}

/** What a server for this request knows of its client's MCP Apps support (`McpCallContext.appHost`). */
export function appHostOf(era: 'modern' | 'legacy', clientCapabilities: unknown): McpCallContext['appHost'] {
  if (era === 'legacy') return 'unknown'
  return declaresMcpApps(clientCapabilities) ? 'declared' : undefined
}

/** Whether `ctx`'s caller is offered the views: an outside agent on an office door, whose client may draw them. */
export function offersAppViews(ctx: Pick<McpCallContext, 'principal' | 'appHost'>): boolean {
  return ctx.appHost !== undefined && doorOfPrincipal(ctx.principal) === 'office' && audienceOf(ctx.principal) === 'external'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
