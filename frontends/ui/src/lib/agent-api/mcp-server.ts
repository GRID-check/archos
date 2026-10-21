import 'server-only'
/**
 * The MCP server of the agent door, built per request for one principal
 * (ADR-0121). Stateless: the handler calls the factory once per HTTP request,
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
  McpServer,
  WebStandardStreamableHTTPServerTransport,
  createMcpHandler,
  fromJsonSchema,
  isLegacyRequest,
} from '@modelcontextprotocol/server'
import type { StandardSchemaWithJSON, ToolAnnotations } from '@modelcontextprotocol/server'
import type { BackendOperation } from './backend-operations'
import type { OperationInput } from './dispatch'
import {
  type MetaToolName,
  callOperationTool,
  describeOperation,
  inputSchemaOf,
  metaToolsFor,
  reportMissingOperation,
  runBackendOperation,
  runOperation,
  searchOperations,
} from './discovery'
import { type AgentOperation, annotationsOf } from './operation'
import { visibleBackendOperations, visibleOperations } from './policy'
import type { AgentPrincipal } from './principal'
import type { McpCallContext, McpMode } from './telemetry'

export const MODE_HEADER = 'x-piloti-mcp-mode'

/** What the agent reads once, at connect time. */
export const MCP_INSTRUCTIONS = [
  'Piloti is the workspace for architects: a planning office runs its projects and processes in it, and Piloti, the agent, is a colleague in that office.',
  'Through this server you act for the signed-in person, with exactly the rights they have: their projects, documents, folders, review, conversations, tasks, skills and knowledge.',
  'Start with project-list to see which projects exist, then search-operations to find what you need and call-operation to run it (describe-operation shows an input you do not know).',
  'Ask the person before a destructive operation. If nothing fits what they asked for, say so and call report-missing-operation.',
].join(' ')

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

function registerMetaTools(server: McpServer, ctx: McpCallContext): void {
  const handlers: Record<MetaToolName, (args: unknown) => ReturnType<typeof callOperationTool> | ReturnType<typeof searchOperations>> = {
    'search-operations': (args) => searchOperations(ctx, args),
    'describe-operation': (args) => describeOperation(ctx, args),
    'call-operation': (args) => callOperationTool(ctx, args),
    'report-missing-operation': (args) => reportMissingOperation(ctx, args),
  }
  for (const [name, tool] of Object.entries(metaToolsFor(ctx.principal)) as [MetaToolName, ReturnType<typeof metaToolsFor>[MetaToolName]][]) {
    server.registerTool(
      name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: fromJsonSchema(tool.inputSchema as JsonSchemaInput),
        annotations: {
          readOnlyHint: tool.readOnly,
          // call-operation can run any operation, deletes included: the client asks the person.
          destructiveHint: name === 'call-operation',
          idempotentHint: tool.readOnly,
          openWorldHint: false,
        },
        _meta: ALWAYS_LOAD_META,
      },
      (args: unknown) => handlers[name](args),
    )
  }
}

function registerOperationTools(server: McpServer, ctx: McpCallContext): void {
  for (const op of visibleOperations(ctx.principal)) {
    server.registerTool(
      op.name,
      {
        title: op.summary,
        description: op.description,
        inputSchema: operationSchema(op),
        annotations: listedAnnotations(annotationsOf(op)),
        ...(ALWAYS_LOAD.has(op.name) ? { _meta: ALWAYS_LOAD_META } : {}),
      },
      (args: unknown) => runOperation(ctx, op.name, (args ?? {}) as OperationInput),
    )
  }
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

export function buildMcpServer(principal: AgentPrincipal, mode: McpMode): McpServer {
  const server = new McpServer({ name: 'piloti', version: '1.0.0' }, { instructions: MCP_INSTRUCTIONS })
  const ctx: McpCallContext = { principal, mode }
  if (mode === 'tools') registerOperationTools(server, ctx)
  else registerMetaTools(server, ctx)
  return server
}

// --- the HTTP handler ----------------------------------------------------------

/** What the route hands the handler for one request: who calls, in which mode. */
export interface AgentDoorRequest {
  principal: AgentPrincipal
  mode: McpMode
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
 * The agent door's MCP handler: 2026-07-28 traffic through the SDK's handler,
 * JSON only; 2025-era traffic (Piloti's own client among it) through
 * {@link serveLegacyAsJson}, so both eras answer JSON to a client that accepts
 * it. The principal and mode travel in `authInfo.extra`, the SDK's documented
 * pass-through for keying a factory off the caller.
 */
export function createAgentDoorHandler(onerror: (error: Error) => void = (error) => console.error('[mcp]', error.message)) {
  const modern = createMcpHandler(
    (context) => {
      const { principal, mode } = context.authInfo?.extra as unknown as AgentDoorRequest
      return buildMcpServer(principal, mode)
    },
    { legacy: 'reject', responseMode: 'json', onerror },
  )
  return {
    async fetch(request: Request, options: { authInfo?: AuthInfo } = {}): Promise<Response> {
      if (request.method.toUpperCase() === 'POST' && (await isLegacyRequest(request))) {
        return serveLegacyAsJson(request, options.authInfo, onerror)
      }
      return modern.fetch(request, options)
    },
  }
}
