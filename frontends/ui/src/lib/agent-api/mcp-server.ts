import 'server-only'
/**
 * The MCP server of the agent door, built per request for one principal
 * (ADR-0121). Stateless: `createMcpHandler` calls the factory once per HTTP
 * request, so nothing here outlives a call and the principal is a closure.
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

import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server'
import type { StandardSchemaWithJSON, ToolAnnotations } from '@modelcontextprotocol/server'
import type { BackendOperation } from './backend-operations'
import type { OperationInput } from './dispatch'
import {
  META_TOOLS,
  callOperationTool,
  describeOperation,
  inputSchemaOf,
  reportMissingOperation,
  runBackendOperation,
  runOperation,
  searchOperations,
} from './discovery'
import { annotationsOf } from './operation'
import { visibleBackendOperations, visibleOperations } from './policy'
import type { AgentPrincipal } from './principal'
import type { McpCallContext, McpMode } from './telemetry'

export const MODE_HEADER = 'x-piloti-mcp-mode'

/** What the agent reads once, at connect time. */
export const MCP_INSTRUCTIONS = [
  'Piloti is the workspace for architects: a planning office runs its projects and processes in it, and Piloti, the agent, is a colleague in that office.',
  'Through this server you act for the signed-in person, with exactly the rights they have: their projects, documents, folders, review, conversations, tasks, skills and knowledge.',
  'Start with project-list to see which projects exist, then search-operations to find what you need, describe-operation for its input, and call-operation to run it.',
  'Ask the person before a destructive operation. If nothing fits what they asked for, say so and call report-missing-operation.',
].join(' ')

/** `search` unless the client asked for `tools`, by header or `?mode=`; anything else, `discovery` included, is `search`. */
export function resolveMode(request: Request): McpMode {
  const asked = request.headers.get(MODE_HEADER) ?? new URL(request.url).searchParams.get('mode')
  return asked?.toLowerCase() === 'tools' ? 'tools' : 'search'
}

type JsonSchemaInput = Parameters<typeof fromJsonSchema>[0]

const operationSchemas = new Map<string, StandardSchemaWithJSON>()

/** One compiled input schema per operation, shared by every request of the process. */
function operationSchema(op: Parameters<typeof inputSchemaOf>[0]): StandardSchemaWithJSON {
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

function registerMetaTools(server: McpServer, ctx: McpCallContext): void {
  const handlers = {
    'search-operations': (args: unknown) => searchOperations(ctx, args),
    'describe-operation': (args: unknown) => describeOperation(ctx, args),
    'call-operation': (args: unknown) => callOperationTool(ctx, args),
    'report-missing-operation': (args: unknown) => reportMissingOperation(ctx, args),
  }
  for (const [name, tool] of Object.entries(META_TOOLS) as [keyof typeof META_TOOLS, (typeof META_TOOLS)[keyof typeof META_TOOLS]][]) {
    const annotations: ToolAnnotations = {
      title: tool.title,
      readOnlyHint: tool.readOnly,
      // call-operation can run any operation, deletes included: the client asks the person.
      destructiveHint: name === 'call-operation',
      idempotentHint: tool.readOnly,
      openWorldHint: false,
    }
    server.registerTool(
      name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: fromJsonSchema(tool.inputSchema as JsonSchemaInput),
        annotations,
      },
      (args: unknown) => handlers[name](args),
    )
  }
}

function registerOperationTools(server: McpServer, ctx: McpCallContext): void {
  for (const op of visibleOperations(ctx.principal)) {
    const annotations = annotationsOf(op)
    server.registerTool(
      op.name,
      {
        title: op.summary,
        description: op.description,
        inputSchema: operationSchema(op),
        annotations,
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
        annotations: op.annotations,
      },
      (args: unknown) => runBackendOperation(ctx, op, (args ?? {}) as Record<string, unknown>),
    )
  }
  // The meta-tool that still matters when the whole catalog is listed.
  const missing = META_TOOLS['report-missing-operation']
  server.registerTool(
    'report-missing-operation',
    {
      title: missing.title,
      description: missing.description,
      inputSchema: fromJsonSchema(missing.inputSchema as JsonSchemaInput),
      annotations: { title: missing.title, readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
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
