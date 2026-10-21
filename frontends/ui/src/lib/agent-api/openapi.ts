/**
 * The agent-reachable API as an OpenAPI 3.1 document (ADR-0121).
 *
 * Generated from the one catalog, `AGENT_OPERATIONS`, so it documents exactly
 * the routes an agent can already call and opens nothing new: each path here is
 * a route the UI calls, under that route's own `authz`. A script or an HTTP
 * client that reads OpenAPI finds the same operations an MCP client finds at
 * `/api/mcp`, by the same names.
 *
 * OpenAPI 3.1 takes JSON Schema 2020-12 as its schema dialect, so the repo's own
 * zod converter (`lib/api/zod-json-schema.ts`) describes the inputs and no
 * second converter or dependency is needed.
 */

import type { z, ZodTypeAny } from 'zod'
import { type JsonSchemaNode, toJsonSchema } from '@/lib/api/zod-json-schema'
import { MCP_PATH } from './mcp-config'
import { type AgentOperation, annotationsOf, pathParams } from './operation'

export type OpenApiDocument = Record<string, unknown>

/** The statuses `lib/api/handler.ts` answers with the shared error envelope. */
const ERROR_RESPONSES = {
  '400': 'The input failed the route’s own validation (bad JSON, schema violation, invalid parameter).',
  '401': 'No valid session or bearer token.',
  '403': 'Signed in, but the person may not do this here.',
  '404': 'The resource does not exist, or the person may not see it.',
  '429': 'Rate limited. Wait for the `Retry-After` header before calling again.',
} as const

const ERROR_ENVELOPE: JsonSchemaNode = {
  type: 'object',
  description:
    'The error body every route answers with (`errorResponse` in lib/api/handler.ts). ' +
    'The same request id is sent in the `x-request-id` header.',
  properties: {
    error: { type: 'string', description: 'A human-readable message.' },
    code: { type: 'string', description: 'A machine-readable code such as BAD_REQUEST, FORBIDDEN or NOT_FOUND.' },
    details: { description: 'Optional machine-readable details; the shape depends on the code.' },
    requestId: { type: 'string', description: 'The request id, for support and log correlation.' },
  },
  required: ['error', 'code', 'requestId'],
  additionalProperties: true,
}

const UNDESCRIBABLE: JsonSchemaNode = {
  description: 'Shape not describable here; the route validates it.',
}

/** A zod schema as JSON Schema, or an open schema when the converter cannot describe it. */
function schemaOf(schema: ZodTypeAny): JsonSchemaNode {
  try {
    return toJsonSchema(schema)
  } catch {
    // The route's own schema is the gate; the export only shapes what is shown.
    return UNDESCRIBABLE
  }
}

/** `/api/projects/[id]` → `/api/projects/{id}`; a catch-all `[...path]` becomes `{path}`. */
export function openApiPath(path: string): string {
  return path.replace(/\[(?:\.\.\.)?([^\]]+)\]/g, '{$1}')
}

interface ParameterObject {
  name: string
  in: 'path' | 'query'
  required: boolean
  description?: string
  schema: JsonSchemaNode
}

function fieldsOf(schema: z.ZodObject<z.ZodRawShape> | undefined): Array<[string, ZodTypeAny]> {
  return schema ? (Object.entries(schema.shape) as Array<[string, ZodTypeAny]>) : []
}

function pathParameters(op: AgentOperation): ParameterObject[] {
  const declared = new Map(fieldsOf(op.params))
  return pathParams(op.path).map((name) => {
    const field = declared.get(name)
    const parameter: ParameterObject = {
      name,
      in: 'path',
      // OpenAPI: a path parameter is always required.
      required: true,
      schema: field ? schemaOf(field) : { type: 'string' },
    }
    if (field?.description) parameter.description = field.description
    return parameter
  })
}

function queryParameters(op: AgentOperation): ParameterObject[] {
  if (!op.query) return []
  const node = schemaOf(op.query)
  const required = new Set(Array.isArray(node.required) ? (node.required as string[]) : [])
  const properties = (node.properties ?? {}) as Record<string, JsonSchemaNode>
  return fieldsOf(op.query).map(([name, field]) => {
    const parameter: ParameterObject = {
      name,
      in: 'query',
      required: required.has(name),
      schema: properties[name] ?? UNDESCRIBABLE,
    }
    if (field.description) parameter.description = field.description
    return parameter
  })
}

/** The shared error responses, once in `components.responses`. */
function errorResponseComponents(): Record<string, JsonSchemaNode> {
  return Object.fromEntries(
    Object.entries(ERROR_RESPONSES).map(([status, description]) => [
      `Error${status}`,
      {
        description,
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } },
      },
    ]),
  )
}

/** Each operation's error statuses, as references to the shared responses. */
function errorResponses(): Record<string, JsonSchemaNode> {
  return Object.fromEntries(
    Object.keys(ERROR_RESPONSES).map((status) => [status, { $ref: `#/components/responses/Error${status}` }]),
  )
}

function operationObject(op: AgentOperation): JsonSchemaNode {
  const operation: JsonSchemaNode = {
    operationId: op.name,
    summary: op.summary,
    description: op.description,
    tags: [op.domain],
  }
  const parameters = [...pathParameters(op), ...queryParameters(op)]
  if (parameters.length > 0) operation.parameters = parameters
  if (op.body) {
    operation.requestBody = {
      required: !op.body.isOptional(),
      content: { 'application/json': { schema: schemaOf(op.body) } },
    }
  }
  operation.responses = {
    '200': {
      description:
        'Success. The body is the route’s JSON answer; no response schema is declared for it yet, ' +
        'so read the operation description for what it contains.',
      content: { 'application/json': { schema: {} } },
    },
    ...errorResponses(),
  }
  if (op.sensitivity) operation['x-piloti-sensitivity'] = op.sensitivity
  operation['x-mcp-annotations'] = annotationsOf(op)
  return operation
}

function pathsOf(operations: readonly AgentOperation[]): Record<string, Record<string, JsonSchemaNode>> {
  const paths: Record<string, Record<string, JsonSchemaNode>> = {}
  for (const op of operations) {
    const path = openApiPath(op.path)
    const item = (paths[path] ??= {})
    item[op.method.toLowerCase()] = operationObject(op)
  }
  return paths
}

/**
 * The OpenAPI 3.1 document for `operations`. `serverUrl` is the origin the
 * paths are relative to; the route passes the deployment's, a spec a fixed one.
 */
export function buildOpenApiDocument(
  operations: readonly AgentOperation[],
  { serverUrl }: { serverUrl: string },
): OpenApiDocument {
  const domains = [...new Set(operations.map((op) => op.domain))]
  return {
    openapi: '3.1.0',
    jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    info: {
      title: 'Piloti workspace API',
      version: '1',
      description:
        'Piloti is the workspace for architects: a planning office runs its projects, documents and ' +
        'processes in it, and Piloti, the agent, works in that office as a colleague. This document ' +
        'describes what an agent or a script can do there, acting as a signed-in person: every ' +
        'operation is a route the Piloti app itself calls, under the same permissions. Every operation ' +
        `is also an MCP tool at ${MCP_PATH}, by the same name as its operationId.`,
    },
    servers: [{ url: serverUrl }],
    security: [{ bearerAuth: [] }],
    tags: domains.map((name) => ({ name })),
    paths: pathsOf(operations),
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: `A WorkOS AuthKit access token, the same one the MCP server at ${MCP_PATH} accepts.`,
        },
      },
      schemas: { ErrorEnvelope: ERROR_ENVELOPE },
      responses: errorResponseComponents(),
    },
  }
}
