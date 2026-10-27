/**
 * The agent-reachable API as an OpenAPI 3.1 document (ADR-0122).
 *
 * Generated from the one catalog, `AGENT_OPERATIONS`, so it documents exactly
 * the routes an agent can already call and opens nothing new: each path here is
 * a route the UI calls, under that route's own `authz`. OpenAPI is the standard
 * for an HTTP contract; MCP is the agent door. A client that reads OpenAPI finds
 * the same operations an MCP client finds at `/api/mcp`, by the same names, and
 * an agent calls them THERE, with its OAuth token: the paths themselves accept
 * the app's signed-in session cookie only, which is what `security` says.
 *
 * OpenAPI 3.1 takes JSON Schema 2020-12 as its schema dialect, so Zod's own
 * exporter, through `lib/api/zod-json-schema.ts`, describes the inputs and no
 * second converter or dependency is needed.
 */

import type { z } from 'zod'
import { type JsonSchemaNode, toJsonSchema } from '@/lib/api/zod-json-schema'
// The backend operations (backend-operations.ts) are left out on purpose: they are not BFF routes, so there is no path to document.
import { isExposedTo } from './exposure'
import { MCP_PATH } from './mcp-config'
import { type AgentOperation, annotationsOf, pathParams } from './operation'

export type OpenApiDocument = Record<string, unknown>

/** The statuses `lib/api/handler.ts` answers with the shared error envelope. */
const ERROR_RESPONSES = {
  '400': 'The input failed the route’s own validation (bad JSON, schema violation, invalid parameter).',
  '401': 'No valid session.',
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
function schemaOf(schema: z.ZodType): JsonSchemaNode {
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

function fieldsOf(schema: z.ZodObject | undefined): Array<[string, z.ZodType]> {
  return schema ? (Object.entries(schema.shape) as Array<[string, z.ZodType]>) : []
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

/** The `fields` of an upload body as the form's text parts. */
function formFieldsOf(body: z.ZodType): Record<string, JsonSchemaNode> {
  const node = schemaOf(body)
  const fields = (node.properties as Record<string, JsonSchemaNode> | undefined)?.fields
  return { ...((fields?.properties as Record<string, JsonSchemaNode> | undefined) ?? {}) }
}

/**
 * The HTTP request body of an operation. A script posts what the UI posts: a
 * JSON object, a multipart form with a `file` part, or raw bytes. Over MCP the
 * file travels as base64 inside JSON (`upload-wire.ts`); the description says so.
 */
function requestBodyOf(op: AgentOperation, body: z.ZodType): JsonSchemaNode {
  const required = !body.isOptional()
  if (op.bodyEncoding === 'multipart') {
    const fields = formFieldsOf(body)
    const requiredFields = (schemaOf(body).properties as Record<string, JsonSchemaNode> | undefined)?.fields?.required
    return {
      required,
      description:
        'A multipart form: the file in the `file` part, the route’s text fields as their own parts. ' +
        'Over MCP send body.files[0] = { name, mimeType, contentBase64 } and body.fields instead.',
      content: {
        'multipart/form-data': {
          schema: {
            type: 'object',
            properties: { file: { type: 'string', format: 'binary' }, ...fields },
            required: ['file', ...(Array.isArray(requiredFields) ? requiredFields : [])],
          },
        },
      },
    }
  }
  if (op.bodyEncoding === 'raw') {
    return {
      required,
      description: 'The raw bytes of the request. Over MCP send them as body.contentBase64.',
      content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
    }
  }
  return { required, content: { 'application/json': { schema: schemaOf(body) } } }
}

/** The 200 response: JSON by default, or the file's media types for an operation that returns one. */
function successResponse(op: AgentOperation): JsonSchemaNode {
  if (op.binaryResponse) {
    return {
      description:
        'Success. The body is a file; the media type depends on the request (a text format such as Markdown or CSV is returned as ' +
        'text). Over MCP it arrives as an embedded resource up to 5 MiB and is described, not sent, above that. ' +
        'A redirect to a time-limited link is handed on as a resource link and never followed.',
      content: Object.fromEntries(
        [...op.binaryResponse, 'text/plain'].map((type) => [type, { schema: { type: 'string', format: 'binary' } }]),
      ),
    }
  }
  return {
    description:
      'Success. The body is the route’s JSON answer; no response schema is declared for it yet, ' +
      'so read the operation description for what it contains.',
    content: { 'application/json': { schema: {} } },
  }
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
    operation.requestBody = requestBodyOf(op, op.body)
  }
  operation.responses = {
    '200': successResponse(op),
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
/**
 * The operations the document shows a caller: what `exposure.config.ts` offers
 * an outside agent (never a withheld one), and the operator console (`platform`)
 * only to platform staff. Its routes refuse everyone else anyway; listing them
 * would only describe a console the reader cannot use.
 */
export function documentedOperations(
  operations: readonly AgentOperation[],
  { platformStaff }: { platformStaff: boolean },
): readonly AgentOperation[] {
  return operations.filter((op) => isExposedTo('external', op.name) || (platformStaff && isExposedTo('platform', op.name)))
}

/** The cookie AuthKit keeps the app's session in (`WORKOS_COOKIE_NAME`, default `wos-session`). */
const SESSION_COOKIE = 'wos-session'

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
        'operation is a route the Piloti app itself calls, under the same permissions. These paths ' +
        'accept the app\u2019s signed-in session; an agent calls every operation as an MCP tool at ' +
        `${MCP_PATH}, by the same name as its operationId, with an OAuth token.`,
    },
    servers: [{ url: serverUrl }],
    security: [{ sessionCookie: [] }],
    tags: domains.map((name) => ({ name })),
    paths: pathsOf(operations),
    components: {
      securitySchemes: {
        sessionCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: SESSION_COOKIE,
          description:
            'The Piloti app\u2019s signed-in session (WorkOS AuthKit), as a browser holds it. A session too large for one ' +
            `cookie is split into ${SESSION_COOKIE}.0, ${SESSION_COOKIE}.1 and so on; send every one. A bearer token is not accepted ` +
            `here: an agent holds an OAuth token for the MCP server at ${MCP_PATH} and calls the operations there.`,
        },
      },
      schemas: { ErrorEnvelope: ERROR_ENVELOPE },
      responses: errorResponseComponents(),
    },
  }
}
