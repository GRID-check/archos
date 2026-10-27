import 'server-only'
/**
 * The door's MCP Apps (ADR-0142; MCP Apps, `io.modelcontextprotocol/ui`,
 * 2026-01-26): Piloti's cards drawn inside an outside agent's own chat.
 *
 * Three pieces, each through the SDK's own helpers
 * (`@modelcontextprotocol/ext-apps/server`):
 *
 *  - **The `ui://` resource** of each view (`catalog/app-views.ts`): one HTML
 *    document built at deploy (`scripts/build-mcp-app-views.ts`), the same for
 *    every office and person, mime type `text/html;profile=mcp-app`, with its
 *    CSP declared empty: no origin to connect to, load from or frame. No tenant
 *    data is in it; the data is the tool result the host hands the view.
 *  - **The tool that links to it.** An operation a view draws
 *    (`drawsResultOf`, today `proposal-get`) carries `_meta.ui.resourceUri`. In
 *    `tools` mode that is its own tool; in `search` mode, where everything else
 *    runs through `call-operation`, it is listed as a tool beside the four
 *    meta-tools, since a host links a view to a tool, not to an argument.
 *  - **The app-only tools** (`APP_TOOLS`): the card's buttons, listed with
 *    `_meta.ui.visibility: ['app']` so the host keeps them from the model and
 *    refuses them from any other server's view. Each runs the catalog
 *    operation it names through `executeOperation`, the path every call takes:
 *    the read gate, the route as the person, its `authz`, rate limit and
 *    schema. Recorded with `decisionSource: app`.
 *
 * Offered to an outside agent on an office door only (`offersAppViews`):
 * Piloti's own door draws its cards itself, and decides no proposal; the
 * platform door has no card.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { McpUiResourceMeta } from '@modelcontextprotocol/ext-apps'
import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from '@modelcontextprotocol/ext-apps/server'
import { type McpServer, fromJsonSchema } from '@modelcontextprotocol/server'
import type { CallToolResult, ReadResourceResult } from '@modelcontextprotocol/server'
import { toJsonSchema } from '@/lib/api/zod-json-schema'
import { findOperation } from './catalog'
import { APP_TOOLS, APP_VIEWS, type AppTool, type AppToolRefusal, type AppView } from './catalog/app-views'
import { executeOperation, fromOperationResult } from './discovery'
import { RESOURCE_ICONS } from './icons'
import type { OperationInput } from './dispatch'
import { audienceOf, doorOfPrincipal, isAppToolFor, isOnDoor } from './exposure'
import type { AgentOperation } from './operation'
import type { McpCallContext } from './telemetry'

/** The extension's id, as a client declares it in `capabilities.extensions` (MCP Apps, "Capability Negotiation"). */
export const UI_EXTENSION = 'io.modelcontextprotocol/ui'

/**
 * What each view's resource declares to the host (`_meta.ui`): an empty CSP,
 * so the host applies its restrictive default (`connect-src 'none'`, inline
 * script and style only); no permission; no border of the host's, since the
 * card draws its own frame.
 */
export const VIEW_UI_META: McpUiResourceMeta = {
  csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
  permissions: {},
  prefersBorder: false,
}

/** Where the built documents are: beside the app (`frontends/ui/mcp-app-views/`, `/app/mcp-app-views/` in the image). */
export const VIEWS_DIR = join(process.cwd(), 'mcp-app-views')

const documents = new Map<string, Promise<string>>()

/** A view's document, read once per process. A missing build is an error the host shows, never an empty frame. */
export function viewDocument(view: Pick<AppView, 'file'>, dir: string = VIEWS_DIR): Promise<string> {
  const key = join(dir, view.file)
  let read = documents.get(key)
  if (!read) {
    read = readFile(key, 'utf8').catch((error: unknown) => {
      documents.delete(key)
      throw new Error(`The view ${view.file} is not built (run \`bun run build:mcp-apps\`): ${(error as Error).message}`)
    })
    documents.set(key, read)
  }
  return read
}

/** Whether `ctx`'s caller is offered the views: an outside agent on an office door. */
export function offersAppViews(ctx: Pick<McpCallContext, 'principal'>): boolean {
  return doorOfPrincipal(ctx.principal) === 'office' && audienceOf(ctx.principal) === 'external'
}

/** The view that draws `operation`'s result, if one does. */
export function viewOf(operation: string): AppView | undefined {
  return APP_VIEWS.find((view) => (view.drawsResultOf as readonly string[]).includes(operation))
}

/** The `_meta` a tool for `operation` carries on this caller's door: the view's URI, or nothing. */
export function viewMetaOf(ctx: Pick<McpCallContext, 'principal'>, operation: string): { ui: { resourceUri: string } } | undefined {
  const view = offersAppViews(ctx) ? viewOf(operation) : undefined
  return view ? { ui: { resourceUri: view.uri } } : undefined
}

/** The sentence a host that draws the view shows nothing of, and a model reads: how to get the card. */
export const VIEW_TOOL_NOTE =
  ' Called as its own tool, a host that renders MCP Apps shows the proposal as Piloti’s card, where the person applies or discards it.'

function registerViewResources(server: McpServer): void {
  for (const view of APP_VIEWS) {
    registerAppResource(
      server,
      view.name,
      view.uri,
      { title: view.title, description: view.description, mimeType: RESOURCE_MIME_TYPE, icons: RESOURCE_ICONS[view.name], _meta: { ui: VIEW_UI_META } },
      async (): Promise<ReadResourceResult> => ({
        contents: [{ uri: view.uri, mimeType: RESOURCE_MIME_TYPE, text: await viewDocument(view), _meta: { ui: VIEW_UI_META } }],
      }),
    )
  }
}

/** The route's status in a refusal's own words (`(HTTP 409, CONFLICT)`), for the card to tell a 409 apart. */
function refusalOf(result: CallToolResult, fallback = 500): AppToolRefusal {
  const text = result.content.find((item) => item.type === 'text')
  const match = text && 'text' in text ? /\(HTTP (\d{3})(?:, ([A-Z_]+))?/.exec(text.text) : null
  return match ? { status: Number(match[1]), ...(match[2] ? { code: match[2] } : {}) } : { status: fallback }
}

function refused(result: CallToolResult, fallback?: number): CallToolResult {
  return { ...result, isError: true, structuredContent: { ...refusalOf(result, fallback) } }
}

/** The operation input an app-only tool's flat arguments stand for. */
function inputOf(tool: AppTool, args: Record<string, unknown>): OperationInput {
  const { id, ...rest } = args as { id: string } & Record<string, unknown>
  return tool.operation === 'proposal-apply' ? { params: { id }, body: rest } : { params: { id } }
}

/**
 * One press of a card's button, as the person: the operation the tool names,
 * through the path every call takes. A refusal carries the route's status in
 * `structuredContent`, so the card shows a colleague's earlier decision (409)
 * rather than an error.
 */
export async function runAppTool(ctx: McpCallContext, tool: AppTool, args: unknown): Promise<CallToolResult> {
  const op: AgentOperation | undefined = findOperation(tool.operation)
  const parsed = tool.input.safeParse(args ?? {})
  if (!op || !isOnDoor(op.name) || !isAppToolFor(audienceOf(ctx.principal), tool.name)) {
    return refused({ content: [{ type: 'text', text: `${tool.name} is not offered on this connection.` }] }, 404)
  }
  if (!parsed.success) {
    return refused({ content: [{ type: 'text', text: `${tool.name}: ${parsed.error.issues[0]?.message ?? 'invalid input'}` }] }, 400)
  }
  const input = inputOf(tool, parsed.data)
  const outcome = await executeOperation({ ...ctx, decisionSource: 'app' }, op, input)
  if ('refusal' in outcome) return refused(outcome.refusal)
  const result = fromOperationResult(op, outcome.result, input)
  if (!outcome.result.ok) return { ...result, isError: true, structuredContent: { ...refusalOf(result, outcome.result.status), status: outcome.result.status } }
  return result
}

function registerAppTools(server: McpServer, ctx: McpCallContext): void {
  const audience = audienceOf(ctx.principal)
  for (const tool of APP_TOOLS) {
    if (!isAppToolFor(audience, tool.name)) continue
    registerAppTool(
      server,
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: fromJsonSchema(toJsonSchema(tool.input) as Parameters<typeof fromJsonSchema>[0]),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        _meta: { ui: { resourceUri: tool.view, visibility: ['app'] } },
      },
      (args: unknown) => runAppTool(ctx, tool, args),
    )
  }
}

/**
 * The views, their app-only tools and, in `search` mode, the tools that link
 * to them. `registerOperationTool` is the door's own registration of one
 * operation as a tool (`mcp-server.ts`), so a view's tool runs exactly as that
 * operation's tool does in `tools` mode.
 */
export function registerAppViews(
  server: McpServer,
  ctx: McpCallContext,
  registerOperationTool: (op: AgentOperation) => void,
): void {
  if (!offersAppViews(ctx)) return
  registerViewResources(server)
  // In `tools` mode the operation is already one tool among all of them; in `search` mode it is listed here.
  if (ctx.mode === 'search') {
    for (const view of APP_VIEWS) {
      for (const name of view.drawsResultOf) {
        const op = findOperation(name)
        if (op) registerOperationTool(op)
      }
    }
  }
  registerAppTools(server, ctx)
}
