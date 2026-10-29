import 'server-only'
/**
 * The MCP server of the agent door, built per request for one principal
 * (ADR-0122). Stateless: the handler calls the factory once per HTTP request,
 * so nothing here outlives a call and the principal is a closure.
 *
 * Two modes, chosen by the client (`x-piloti-mcp-mode` header or `?mode=`):
 *
 *  - `search` (default): four meta-tools. A client pays a few hundred tokens
 *    for the whole surface and finds operations by search. `discovery`, its
 *    name until October 2026, is still accepted: MCP's own "discovery" is
 *    `server/discover`, so the old name said something it was not.
 *  - `tools`: one tool per visible operation, for clients with their own tool
 *    search or a small catalog to show. Same catalog, same dispatch.
 */

import {
  type AuthInfo,
  CLIENT_CAPABILITIES_META_KEY,
  McpServer,
  type ServerEventBus,
  WebStandardStreamableHTTPServerTransport,
  createMcpHandler,
  fromJsonSchema,
  isLegacyRequest,
} from '@modelcontextprotocol/server'
import type {
  CallToolResult,
  InputRequiredResult,
  ServerContext,
  StandardSchemaWithJSON,
  ToolAnnotations,
} from '@modelcontextprotocol/server'
import type { BackendOperation } from './backend-operations'
import { confirmThenRun, confirmationFor } from './confirmation'
import type { OperationInput } from './dispatch'
import {
  type MetaToolName,
  callOperationTool,
  catalogCallOf,
  describeOperation,
  inputSchemaOf,
  metaToolsFor,
  reportMissingOperation,
  runBackendOperation,
  runOperation,
  searchOperations,
} from './discovery'
import { type AgentOperation, annotationsOf } from './operation'
import { type AgentDoor, doorOfPrincipal, findVisibleOperation, visibleBackendOperations, visibleOperations } from './policy'
import type { AgentPrincipal } from './principal'
import { offersDoorGuide, offersProjectResource, readableProjectUris, registerDoorGuide } from './door'
import { DoorEventBus, listeningAs } from './door/event-bus'
import { META_TOOL_ICONS, serverIcons } from './icons'
import { META_OUTPUT_SCHEMAS } from './meta-output-schemas'
import { configuredAppOrigin } from '@/lib/app-origin'
import { PRODUCT_NAME } from '@/lib/brand'
import { ASK_CREATE, TASKS_EXTENSION, offersAskTasks, registerAskTasks, runAskCreate } from './ask-calls'
import { registerAppTool } from '@modelcontextprotocol/ext-apps/server'
import { UI_EXTENSION, VIEW_TOOL_NOTE, appHostOf, offersAppViews, registerAppViews, viewMetaOf } from './mcp-apps'
import type { McpCallContext, McpMode } from './telemetry'

export const MODE_HEADER = 'x-piloti-mcp-mode'

/** What the agent reads once, at connect time, on an office door. */
export const MCP_INSTRUCTIONS = [
  `${PRODUCT_NAME} is the workspace for architects: a planning office runs its projects and processes in it, and ${PRODUCT_NAME}, the agent, is a colleague in that office.`,
  'Through this server you act for the signed-in person, with exactly the rights they have: their projects, documents, folders, review, conversations, tasks, skills and knowledge.',
  'Read the resource piloti://guide once: how the workspace fits together and how ids flow; piloti://catalog lists every operation you may run, piloti://glossary the office\'s German words.',
  'Start with project-list to see which projects exist, then search-operations to find what you need and call-operation to run it (describe-operation shows an input you do not know).',
  'Ask the person before a destructive operation. If nothing fits what they asked for, say so and call report-missing-operation.',
].join(' ')

/** What the agent reads once, at connect time, on the platform door (ADR-0126). */
export const PLATFORM_MCP_INSTRUCTIONS = [
  `This is the ${PRODUCT_NAME} platform console: the platform operator runs ${PRODUCT_NAME} for every planning office here, and you act for a platform operator with exactly the platform permissions they hold.`,
  'Settings, prices, models and the base knowledge corpus here apply to every organization at once; nothing of an office\'s own workspace is here.',
  'Start with platform-overview-get for the organizations, then search-operations to find what you need and call-operation to run it (describe-operation shows an input you do not know).',
  'Ask the person before every destructive operation: here one reaches every tenant. If nothing fits, say so and call report-missing-operation.',
].join(' ')

/** The server's name and instructions on each door. */
const SERVER_IDENTITY: Readonly<Record<AgentDoor, { name: string; title: string; instructions: string }>> = {
  office: { name: 'workspace', title: PRODUCT_NAME, instructions: MCP_INSTRUCTIONS },
  platform: { name: 'workspace-platform', title: `${PRODUCT_NAME} platform`, instructions: PLATFORM_MCP_INSTRUCTIONS },
}

/**
 * Tools a Claude client keeps loaded although it defers MCP tools by default
 * (Claude Code, `_meta["anthropic/alwaysLoad"]`): the entry points. In `search`
 * mode the four meta-tools are the whole surface; in `tools` mode the first
 * call of almost every task is one of these.
 */
const ALWAYS_LOAD: ReadonlySet<string> = new Set(['project-list', 'knowledge-search', 'files-list'])
const ALWAYS_LOAD_META = { 'anthropic/alwaysLoad': true } as const

/** `search` unless the client asked for `tools`, by header or `?mode=`; anything else, `discovery` included, is `search`. */
export function resolveMode(request: Request): McpMode {
  const asked = request.headers.get(MODE_HEADER) ?? new URL(request.url).searchParams.get('mode')
  return asked?.toLowerCase() === 'tools' ? 'tools' : 'search'
}

type JsonSchemaInput = Parameters<typeof fromJsonSchema>[0]

const operationSchemas = new Map<string, StandardSchemaWithJSON>()

/** One compiled input schema per operation, shared by every request of the process. */
function operationSchema(op: AgentOperation): StandardSchemaWithJSON {
  let schema = operationSchemas.get(op.name)
  if (!schema) {
    schema = fromJsonSchema(inputSchemaOf(op) as JsonSchemaInput)
    operationSchemas.set(op.name, schema)
  }
  return schema
}

const backendSchemas = new Map<string, StandardSchemaWithJSON>()

function backendSchema(op: BackendOperation): StandardSchemaWithJSON {
  let schema = backendSchemas.get(op.name)
  if (!schema) {
    schema = fromJsonSchema(op.inputSchema as JsonSchemaInput)
    backendSchemas.set(op.name, schema)
  }
  return schema
}

/**
 * The hints as `tools/list` carries them, each stated where it says something
 * (MCP specification, `ToolAnnotations`): `readOnlyHint` for a read, and for a
 * write `destructiveHint` always (its default, `true`, would make every write
 * look like a delete), `idempotentHint` when true; `openWorldHint` always, since
 * its default is `true`. What is left out is the specification's own default, or
 * a hint it says is meaningful only for writes. `title` is the tool's own
 * (`Tool.title`), never repeated. Across 300 tools that is a fifth of the
 * annotations' tokens; `describe-operation` and the OpenAPI document still
 * state all four.
 */
export function listedAnnotations(annotations: ToolAnnotations): ToolAnnotations {
  const { readOnlyHint, destructiveHint, idempotentHint, openWorldHint } = annotations
  if (readOnlyHint) return { readOnlyHint: true, openWorldHint: openWorldHint ?? true }
  return {
    destructiveHint: destructiveHint ?? true,
    ...(idempotentHint ? { idempotentHint: true } : {}),
    openWorldHint: openWorldHint ?? true,
  }
}

/** The declared result shape of a meta-tool that has one (`call-operation` does not: its result varies by operation). */
function outputSchemaOf(name: string): { outputSchema?: StandardSchemaWithJSON } {
  const schema = (META_OUTPUT_SCHEMAS as Readonly<Record<string, unknown>>)[name]
  return schema ? { outputSchema: fromJsonSchema(schema as JsonSchemaInput) } : {}
}

/**
 * call-operation. Asking Piloti on the 2026-07-28 era may report progress or
 * become a task (`ask-calls.ts`); it is no destructive write, so it is never put
 * to the person first. Every other call goes through `confirmThenRun`.
 */
type ToolAnswer = CallToolResult | InputRequiredResult | Promise<CallToolResult | InputRequiredResult>

function callOperationFor(ctx: McpCallContext, args: unknown, req: ServerContext, era: McpEra): ToolAnswer {
  const asks = era === 'modern' && typeof args === 'object' && args !== null && (args as { name?: unknown }).name === ASK_CREATE
  const input = asks ? (args as { input?: unknown }).input : undefined
  if (asks && (input === undefined || (typeof input === 'object' && input !== null && !Array.isArray(input)))) {
    return runAskCreate(ctx, (input ?? {}) as OperationInput, req)
  }
  return confirmThenRun(ctx, req, catalogCallOf(ctx.principal, args), (runCtx) => callOperationTool(runCtx, args))
}

function registerMetaTools(server: McpServer, ctx: McpCallContext, era: McpEra): void {
  const handlers: Record<MetaToolName, (args: unknown, req: ServerContext) => ToolAnswer> = {
    'search-operations': (args) => searchOperations(ctx, args),
    'describe-operation': (args) => describeOperation(ctx, args),
    'call-operation': (args, req) => callOperationFor(ctx, args, req, era),
    'report-missing-operation': (args) => reportMissingOperation(ctx, args),
  }
  for (const [name, tool] of Object.entries(metaToolsFor(ctx.principal)) as [MetaToolName, ReturnType<typeof metaToolsFor>[MetaToolName]][]) {
    server.registerTool(
      name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: fromJsonSchema(tool.inputSchema as JsonSchemaInput),
        ...outputSchemaOf(name),
        icons: META_TOOL_ICONS[name],
        annotations: {
          readOnlyHint: tool.readOnly,
          // call-operation can run any operation, deletes included: the client asks the person.
          destructiveHint: name === 'call-operation',
          idempotentHint: tool.readOnly,
          openWorldHint: false,
        },
        _meta: ALWAYS_LOAD_META,
      },
      (args: unknown, req: ServerContext) => handlers[name](args, req),
    )
  }
}

/**
 * One catalog operation as an MCP tool, as `tools` mode lists it. An operation
 * whose result a view draws (`mcp-apps.ts`) also carries `_meta.ui.resourceUri`
 * for an outside agent, registered through the MCP Apps SDK's `registerAppTool`.
 */
function registerOperationTool(server: McpServer, ctx: McpCallContext, era: McpEra, op: AgentOperation): void {
  const view = viewMetaOf(ctx, op.name)
  const meta = { ...(ALWAYS_LOAD.has(op.name) ? ALWAYS_LOAD_META : {}), ...(view ?? {}) }
  const config = {
    title: op.summary,
    description: view ? op.description + VIEW_TOOL_NOTE : op.description,
    inputSchema: operationSchema(op),
    annotations: listedAnnotations(annotationsOf(op)),
    ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
  }
  const handler =
    op.name === ASK_CREATE && era === 'modern'
      ? (args: unknown, req: ServerContext) => runAskCreate(ctx, (args ?? {}) as OperationInput, req)
      : (args: unknown, req: ServerContext) => {
          const input = (args ?? {}) as OperationInput
          return confirmThenRun(ctx, req, { operation: op.name, input }, (runCtx) => runOperation(runCtx, op.name, input))
        }
  if (view) registerAppTool(server, op.name, { ...config, _meta: meta }, handler)
  else server.registerTool(op.name, config, handler)
}

function registerOperationTools(server: McpServer, ctx: McpCallContext, era: McpEra): void {
  for (const op of visibleOperations(ctx.principal)) registerOperationTool(server, ctx, era, op)
  // The Python agent's read tools: flat arguments, read-only, and open-world only where they reach beyond the workspace.
  for (const op of visibleBackendOperations(ctx.principal)) {
    server.registerTool(
      op.name,
      {
        title: op.summary,
        description: op.description,
        inputSchema: backendSchema(op),
        annotations: listedAnnotations(op.annotations),
        ...(ALWAYS_LOAD.has(op.name) ? { _meta: ALWAYS_LOAD_META } : {}),
      },
      (args: unknown) => runBackendOperation(ctx, op, (args ?? {}) as Record<string, unknown>),
    )
  }
  // The meta-tool that still matters when the whole catalog is listed.
  const missing = metaToolsFor(ctx.principal)['report-missing-operation']
  server.registerTool(
    'report-missing-operation',
    {
      title: missing.title,
      description: missing.description,
      inputSchema: fromJsonSchema(missing.inputSchema as JsonSchemaInput),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args: unknown) => reportMissingOperation(ctx, args),
  )
}

/** The protocol era a server answers: only `modern` has `subscriptions/listen`; a 2025-era request is stateless and cannot hold a stream. */
export type McpEra = 'modern' | 'legacy'

/**
 * What the server claims to support. The SDK defaults every `listChanged` to
 * true, which would promise notifications nobody sends: the tool and prompt
 * lists change only with a deploy, so they say false. The resource list
 * (the person's projects) and a project's overview change at any time, and are
 * announced to a modern client that listens.
 */
function capabilitiesFor(ctx: McpCallContext, era: McpEra) {
  const live = era === 'modern' && offersProjectResource(ctx)
  const tasks = era === 'modern' && offersAskTasks(ctx.principal)
  const apps = era === 'modern' && offersAppViews(ctx)
  const extensions = { ...(tasks ? { [TASKS_EXTENSION]: {} } : {}), ...(apps ? { [UI_EXTENSION]: {} } : {}) }
  return {
    tools: { listChanged: false },
    // The tasks extension, to a caller that may ask Piloti (`ask-calls.ts`); MCP Apps, echoed to an outside agent whose
    // client declared it (`mcp-apps.ts`). MCP Apps 2026-01-26 negotiates on the client's side; the echo says which
    // views this server serves, for a client that reads `server/discover`.
    ...(Object.keys(extensions).length > 0 ? { extensions } : {}),
    ...(offersDoorGuide(ctx)
      ? { prompts: { listChanged: false }, resources: live ? { listChanged: true, subscribe: true } : { listChanged: false } }
      : {}),
  }
}

/**
 * The server for one request. `era` is the request's protocol era: only a
 * 2026-07-28 request can carry a question back to the person (`inputRequired`),
 * so only there is an outside agent's destructive write put to them first
 * (`confirmation.ts`), with `requestState` verified before any handler runs. A
 * 2025-era server is built exactly as before. A modern server also reports a
 * Piloti ask's progress and may hand it out as a task.
 */
export function buildMcpServer(
  principal: AgentPrincipal,
  mode: McpMode,
  era: McpEra = 'legacy',
  /** The request's client capabilities (2026-07-28 `_meta`); a 2025-era request carries none. */
  clientCapabilities?: unknown,
): McpServer {
  const { name, title, instructions } = SERVER_IDENTITY[doorOfPrincipal(principal)]
  const confirmation = era === 'modern' ? confirmationFor(principal) : null
  const appHost = appHostOf(era, clientCapabilities)
  const ctx: McpCallContext = {
    principal,
    mode,
    ...(confirmation ? { confirmation } : {}),
    ...(appHost ? { appHost } : {}),
  }
  // The deployment's pinned origin; omitted where none is configured (never the inbound Host header).
  const websiteUrl = configuredAppOrigin()
  const capabilities = capabilitiesFor(ctx, era)
  const server = new McpServer(
    { name, title, version: '1.0.0', icons: serverIcons(websiteUrl), ...(websiteUrl ? { websiteUrl } : {}) },
    confirmation ? { instructions, capabilities, requestState: { verify: confirmation.codec.verify } } : { instructions, capabilities },
  )
  if (mode === 'tools') registerOperationTools(server, ctx, era)
  else registerMetaTools(server, ctx, era)
  registerDoorGuide(server, ctx)
  // MCP Apps: the views, their app-only tools, and in `search` mode the tool that links to a view (ADR-0142).
  registerAppViews(server, ctx, (op) => {
    if (findVisibleOperation(principal, op.name)) registerOperationTool(server, ctx, era, op)
  })
  if (era === 'modern' && offersAskTasks(principal)) registerAskTasks(server, ctx)
  return server
}

// --- the HTTP handler ----------------------------------------------------------

/** What the route hands the handler for one request: who calls, in which mode. */
export interface AgentDoorRequest {
  principal: AgentPrincipal
  mode: McpMode
  /** The 2026-07-28 request's client capabilities, read off its `_meta` before the SDK serves it. */
  clientCapabilities?: unknown
}

/**
 * A 2026-07-28 request's client capabilities: they ride in every request's
 * `_meta`, and the server built for the request decides what it lists by them
 * (MCP Apps). Undefined for a body that is not one JSON-RPC request.
 */
async function clientCapabilitiesOf(request: Request): Promise<unknown> {
  try {
    const body = (await request.clone().json()) as { params?: { _meta?: Record<string, unknown> } }
    return body?.params?._meta?.[CLIENT_CAPABILITIES_META_KEY]
  } catch {
    return undefined
  }
}

const BOTH_ACCEPT_TYPES = 'application/json, text/event-stream'

/**
 * `request` with an `Accept` the 2025-era transport takes, when the client
 * accepts JSON. That transport refuses (406) any request that does not name
 * BOTH `application/json` and `text/event-stream`, even when it is set to answer
 * JSON only, which it is here; a client that accepts JSON gets JSON. A client
 * that names neither (`text/event-stream` alone) is left to the transport's own
 * answer.
 */
function acceptingJson(request: Request): Request {
  const accept = request.headers.get('accept')
  const takesJson = !accept || /application\/json|application\/\*|\*\/\*/.test(accept)
  if (!takesJson || (accept?.includes('application/json') && accept.includes('text/event-stream'))) return request
  const headers = new Headers(request.headers)
  headers.set('accept', BOTH_ACCEPT_TYPES)
  return new Request(request, { headers })
}

/**
 * One 2025-era request, answered with a single JSON body: the SDK's stateless
 * fallback, except that the transport is built with `enableJsonResponse` (the
 * fallback's own transport always streams, whatever the handler's
 * `responseMode`) and a client that accepts JSON is served.
 */
async function serveLegacyAsJson(request: Request, authInfo: AuthInfo | undefined, onerror: (error: Error) => void): Promise<Response> {
  const { principal, mode } = authInfo?.extra as unknown as AgentDoorRequest
  const server = buildMcpServer(principal, mode)
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  transport.onerror = onerror
  await server.connect(transport)
  try {
    return await transport.handleRequest(acceptingJson(request), authInfo ? { authInfo } : undefined)
  } finally {
    await transport.close().catch(() => undefined)
    await server.close().catch(() => undefined)
  }
}

/**
 * The agent door's MCP handler: 2026-07-28 traffic through the SDK's handler;
 * 2025-era traffic (Piloti's own client among it) through
 * {@link serveLegacyAsJson}, which answers one JSON body.
 *
 * The modern handler answers `auto`: a call that sends no message before its
 * result (every call but a `agent-ask-create` that carries a progress token)
 * is one JSON body; that one call is upgraded to an SSE stream carrying its
 * `notifications/progress` and then the result. Nothing else here emits a
 * message before a result: the server declares no `logging`, and asking for
 * input is a result (`input_required`), not a message. The principal and mode
 * travel in `authInfo.extra`, the SDK's documented pass-through for keying a
 * factory off the caller.
 */
export function createAgentDoorHandler(
  onerror: (error: Error) => void = (error) => console.error('[mcp]', error.message),
  bus: ServerEventBus = new DoorEventBus(),
) {
  const modern = createMcpHandler(
    (context) => {
      const { principal, mode, clientCapabilities } = context.authInfo?.extra as unknown as AgentDoorRequest
      return buildMcpServer(principal, mode, 'modern', clientCapabilities)
    },
    { legacy: 'reject', responseMode: 'auto', onerror, bus },
  )
  return {
    /** The bus listen streams hear; publish through `realtime/door-events.ts`, which stamps the organization. */
    bus: modern.bus,
    async fetch(request: Request, options: { authInfo?: AuthInfo } = {}): Promise<Response> {
      if (request.method.toUpperCase() !== 'POST') return modern.fetch(request, options)
      if (await isLegacyRequest(request)) return serveLegacyAsJson(request, options.authInfo, onerror)
      if (request.headers.get('mcp-method') === 'subscriptions/listen' && options.authInfo) {
        return serveListen((r, o) => modern.fetch(r, o), request, options.authInfo)
      }
      if (!options.authInfo) return modern.fetch(request, options)
      const clientCapabilities = await clientCapabilitiesOf(request)
      const extra = { ...options.authInfo.extra, clientCapabilities }
      return modern.fetch(request, { ...options, authInfo: { ...options.authInfo, extra } })
    },
  }
}

interface ListenBody {
  params?: { notifications?: { resourceSubscriptions?: unknown } }
}

/**
 * `subscriptions/listen`, as the person who listens: the URIs it names are cut
 * to the ones that person may read (the SDK checks none), and the stream is
 * opened in the person's organization, so it hears only that organization's
 * events (`door/event-bus.ts`). A body that is not the shape of a listen request
 * goes to the SDK unchanged, which answers it.
 */
async function serveListen(handle: (request: Request, options: { authInfo?: AuthInfo }) => Promise<Response>, request: Request, authInfo: AuthInfo): Promise<Response> {
  const { principal, mode } = authInfo.extra as unknown as AgentDoorRequest
  let body: ListenBody | null = null
  try {
    body = (await request.clone().json()) as ListenBody
  } catch {
    body = null
  }
  const asked = body?.params?.notifications?.resourceSubscriptions
  let forwarded = request
  if (body && Array.isArray(asked)) {
    const allowed = await readableProjectUris({ principal, mode }, asked.filter((uri): uri is string => typeof uri === 'string'))
    const headers = new Headers(request.headers)
    headers.delete('content-length')
    const narrowed = { ...body, params: { ...body.params, notifications: { ...body.params?.notifications, resourceSubscriptions: allowed } } }
    forwarded = new Request(request.url, { method: 'POST', headers, body: JSON.stringify(narrowed), signal: request.signal })
  }
  return listeningAs(principal.session.organizationId, () => handle(forwarded, { authInfo }))
}
