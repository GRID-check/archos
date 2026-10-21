import 'server-only'
/**
 * Progressive discovery for the agent door (ADR-0121).
 *
 * The catalog is large, and MCP has no standard tool search. Putting every
 * operation in `tools/list` costs a client thousands of tokens before its first
 * word, so the default mode offers four meta-tools instead, the shape PostHog
 * (`exec`) and Cloudflare (`search` + `execute`) settled on:
 *
 *   search-operations -> describe-operation -> call-operation
 *   report-missing-operation, for the day search finds nothing
 *
 * The handlers here are plain functions over an {@link McpCallContext};
 * `mcp-server.ts` registers them, and registers the per-operation tools of
 * `tools` mode over the same {@link runOperation}, so both modes run one path.
 */

import type { CallToolResult } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { ApiError } from '@/lib/api/errors'
import { type JsonSchemaNode, toJsonSchema } from '@/lib/api/zod-json-schema'
import {
  type BinaryBody,
  MAX_INLINE_BYTES,
  MAX_TEXT_BYTES,
  type OperationInput,
  type OperationResult,
  OperationInputError,
  callOperation,
  type OversizedBody,
  isBinaryBody,
  isOversizedBody,
  isRedirectBody,
  parseOperationInput,
} from './dispatch'
import { type BackendOperation, callBackendOperation, toMcpContent } from './backend-operations'
import { AGENT_DOMAINS, type AgentOperation, annotationsOf } from './operation'
import { proposeOperation } from './operation-proposals'
import {
  callDecision,
  findVisibleBackendOperation,
  findVisibleOperation,
  visibleBackendOperations,
  visibleOperations,
} from './policy'
import { readGateFor, sharedConversationReadRefusal } from './read-gate'
import { type McpCallContext, recordOperationCalled, recordOperationMissing } from './telemetry'

/** Longest text a result carries; beyond it the call must be narrowed. */
export const MAX_RESULT_CHARS = 40_000
const DEFAULT_SEARCH_LIMIT = 10
const MAX_SEARCH_LIMIT = 50

// --- results ---------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Text for a model, capped; whether it was cut. */
function renderText(value: unknown): { text: string; truncated: boolean } {
  const full = typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? 'null')
  if (full.length <= MAX_RESULT_CHARS) return { text: full, truncated: false }
  const note =
    `\n\n[Truncated: showing ${MAX_RESULT_CHARS} of ${full.length} characters. ` +
    'Narrow the call to page through it: pass a smaller limit or filters in input.query, ' +
    'or fetch one item by id.]'
  return { text: full.slice(0, MAX_RESULT_CHARS) + note, truncated: true }
}

function success(value: unknown): CallToolResult {
  const { text, truncated } = renderText(value)
  const result: CallToolResult = { content: [{ type: 'text', text }] }
  // structuredContent must be an object; a client that reads it would bypass the cap.
  if (!truncated) result.structuredContent = isRecord(value) ? value : { result: value }
  return result
}

function failure(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] }
}

/** Bytes as the person would read them: `1.5 MiB`. */
function sizeText(bytes: number | null): string {
  if (bytes === null) return 'an unknown size'
  if (bytes < 1024) return `${bytes} bytes`
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

const SAFE_URI_SEGMENT = /[^\w.-]+/g

/**
 * A file the route returned, as MCP content: an embedded `resource` with the
 * bytes as `blob` (base64) and a one-line text summary. The base64 lives only in
 * that content item, never in `structuredContent` and never in the capped text.
 * Over {@link MAX_INLINE_BYTES} nothing is sent, and the text says how to read
 * the document another way.
 */
function binaryResult(opName: string, file: BinaryBody): CallToolResult {
  const mimeType = file.contentType?.split(';')[0]?.trim() || 'application/octet-stream'
  const label = file.filename ? `"${file.filename}", ` : ''
  if (file.tooLarge || file.base64 === undefined) {
    return {
      content: [
        {
          type: 'text',
          text:
            `The file (${label}${mimeType}, ${sizeText(file.bytes)}) is over the ${sizeText(MAX_INLINE_BYTES)} ` +
            'limit for sending a file in a tool result, so it was not sent. ' +
            'For a document, read its text in pages with document-text-get, or call document-download for a ' +
            'time-limited link the person can open. Otherwise ask the person to download it in Piloti.',
        },
      ],
    }
  }
  const name = (file.filename ?? 'result').replace(SAFE_URI_SEGMENT, '_')
  return {
    content: [
      { type: 'text', text: `Returned ${label}${mimeType}, ${sizeText(file.bytes)}, as the attached resource.` },
      { type: 'resource', resource: { uri: `piloti://operation/${opName}/${name}`, mimeType, blob: file.base64 } },
    ],
  }
}

/** A redirect, handed on as a `resource_link`: the URL is a short-lived credential, so it is never followed here. */
function redirectResult(opName: string, location: string): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: `The file is at a time-limited link. Open it soon: the link expires, and ${opName} mints a fresh one.`,
      },
      { type: 'resource_link', uri: location, name: opName, description: 'Expires shortly; request it again when needed.' },
    ],
  }
}

/** An answer too large to read: the agent is told to narrow the call, as the text cap tells it. */
function oversizedResult(opName: string, body: OversizedBody): CallToolResult {
  return failure(
    `${opName} answered with more than ${sizeText(MAX_TEXT_BYTES)} of ${body.contentType || 'text'}` +
      (body.bytes === null ? '' : ` (${sizeText(body.bytes)})`) +
      ', so it was not read. Narrow the call: pass a smaller limit or filters in input.query, or fetch one item by id.'
  )
}

/** A route's answer as the tool result. A refusal keeps the route's own words: errors teach. */
function fromOperationResult(opName: string, result: OperationResult): CallToolResult {
  if (isOversizedBody(result.body)) return oversizedResult(opName, result.body)
  if (result.ok) {
    if (isBinaryBody(result.body)) return binaryResult(opName, result.body)
    if (isRedirectBody(result.body)) return redirectResult(opName, result.body.location)
    return success(result.body)
  }
  const body = isRecord(result.body) ? result.body : null
  const message = typeof body?.error === 'string' ? body.error : `The route answered HTTP ${result.status}.`
  const code = typeof body?.code === 'string' ? `, ${body.code}` : ''
  const details = body?.details === undefined ? '' : `\nDetails: ${JSON.stringify(body.details)}`
  return failure(`${message} (HTTP ${result.status}${code})${details}`)
}

/**
 * The backend's answer to a read tool as the tool result. Success is
 * `{ tool, result }`: the result is capped text with structuredContent, except
 * the page-image tool's content blocks, which stay images. A refusal keeps the
 * message of whoever refused: the BFF's `message`, or the backend's `detail`.
 */
function fromBackendResult(result: OperationResult): CallToolResult {
  const body = isRecord(result.body) ? result.body : null
  if (result.ok) {
    const value = body && 'result' in body ? body.result : result.body
    if (Array.isArray(value)) {
      const content = toMcpContent(value).map((block) =>
        block.type === 'text' ? { type: 'text' as const, text: renderText(block.text).text } : block,
      )
      return { content }
    }
    return success(value)
  }
  const detail = isRecord(body?.detail) ? body.detail : null
  const code = [body?.error, detail?.error].find((value) => typeof value === 'string')
  const message =
    typeof body?.message === 'string'
      ? body.message
      : typeof detail?.error === 'string'
        ? `${detail.error}${detail.issues === undefined ? '' : `: ${JSON.stringify(detail.issues)}`}`
        : `The backend answered HTTP ${result.status}.`
  return failure(`${message} (HTTP ${result.status}${typeof code === 'string' ? `, ${code}` : ''})`)
}

// --- the input schema of one operation -------------------------------------

/** An ETag is short; anything longer is not one. */
const IF_MATCH_MAX_LENGTH = 256

const IF_MATCH_SCHEMA = {
  type: 'string',
  minLength: 1,
  maxLength: IF_MATCH_MAX_LENGTH,
  description:
    'Sent as If-Match: the version you read (the project profile: its profileVersion). A write over a newer version is ' +
    'refused; read again, then retry.',
} as const

const schemaCache = new Map<string, JsonSchemaNode>()

function part(schema: Parameters<typeof toJsonSchema>[0]): { node: JsonSchemaNode; required: boolean } {
  try {
    const node = toJsonSchema(schema)
    const required = Array.isArray(node.required) ? node.required.length > 0 : !schema.isOptional()
    return { node, required }
  } catch {
    // The route's own schema is the gate; the export only shapes what is shown.
    return { node: { description: 'Shape not describable here; the route validates it.' }, required: false }
  }
}

/**
 * The input of `op` as JSON Schema: `{ params, query, body }`, each present only
 * when the operation has it, built from the same zod the dispatcher validates with.
 */
export function inputSchemaOf(op: AgentOperation): JsonSchemaNode {
  const cached = schemaCache.get(op.name)
  if (cached) return cached
  const properties: Record<string, JsonSchemaNode> = {}
  const required: string[] = []
  for (const key of ['params', 'query', 'body'] as const) {
    const schema = op[key]
    if (!schema) continue
    const { node, required: isRequired } = part(schema)
    properties[key] = node
    if (isRequired) required.push(key)
  }
  // A write may refuse to overwrite a newer version than the one the agent read (If-Match).
  if (!annotationsOf(op).readOnlyHint) properties.ifMatch = IF_MATCH_SCHEMA
  const schema: JsonSchemaNode = { type: 'object', properties, additionalProperties: false }
  if (required.length > 0) schema.required = required
  schemaCache.set(op.name, schema)
  return schema
}

// --- running one operation --------------------------------------------------

/** Run one of the Python agent's read tools as the person; `input` is the tool's own arguments. */
export async function runBackendOperation(
  ctx: McpCallContext,
  op: BackendOperation,
  input: Record<string, unknown>,
): Promise<CallToolResult> {
  const startedAt = Date.now()
  const record = (status: number) =>
    recordOperationCalled(ctx, { operation: op.name, domain: op.domain, decision: 'run', status, startedAt })
  const projectId = typeof input.projectId === 'string' ? input.projectId : undefined
  try {
    const refused = await readGateFor(ctx.principal).beforeRead(op)
    if (refused) {
      record(403)
      return failure(refused)
    }
    const result = await callBackendOperation(op.name, input, ctx.principal.session, { projectId })
    record(result.status)
    return fromBackendResult(result)
  } catch (error) {
    console.error('[mcp] backend operation failed', op.name, error)
    record(500)
    return failure(`${op.name} failed on the server. Try again; if it persists, report it.`)
  }
}

function unknownOperation(ctx: McpCallContext, name: string): CallToolResult {
  const near = rank(ctx, name, undefined)
    .slice(0, 5)
    .map((hit) => hit.name)
  const hint = near.length > 0 ? ` Closest: ${near.join(', ')}.` : ''
  return failure(`Unknown operation "${name}".${hint} Use search-operations to find the right name.`)
}

/**
 * Run (or propose) one operation for `ctx.principal`. The one path both modes
 * share: visibility, the run/propose decision, the dispatch, the telemetry.
 */
export async function runOperation(ctx: McpCallContext, name: string, input: OperationInput): Promise<CallToolResult> {
  const startedAt = Date.now()
  const op = findVisibleOperation(ctx.principal, name)
  if (!op) {
    const backend = findVisibleBackendOperation(ctx.principal, name)
    if (backend) return runBackendOperation(ctx, backend, isRecord(input) ? { ...input } : {})
    // Not the caller's text: an unknown name is whatever the agent typed, and server events are non-personal.
    recordOperationCalled(ctx, { operation: null, domain: null, decision: 'refused', status: 404, startedAt })
    return unknownOperation(ctx, name)
  }
  const decision = callDecision(ctx.principal, op)
  const record = (status: number) =>
    recordOperationCalled(ctx, { operation: op.name, domain: op.domain, decision, status, startedAt })

  try {
    if (decision === 'propose') {
      const parsed = parseOperationInput(op, input)
      const proposal = await proposeOperation({ principal: ctx.principal, op, input: parsed })
      record(202)
      // The result shape the in-product client reads to show the card (`tools/workspace/register.py`):
      // `structuredContent.decision === 'propose'` with the proposal's id. The text is all the model reads.
      return {
        content: [{ type: 'text', text: 'Proposed — the person decides. Nothing was changed.' }],
        structuredContent: {
          decision: 'propose',
          proposalId: proposal.proposalId,
          summary: proposal.summary,
          operation: op.name,
        },
      }
    }
    const gate = readGateFor(ctx.principal)
    const refused = await gate.beforeRead(op)
    if (refused) {
      record(403)
      return failure(refused)
    }
    // An agent reads the answer: a route that words its refusal in the person's locale words it in English.
    const result = await callOperation(op, input, ctx.principal.session, 'agent')
    record(result.status)
    // A link works for whoever holds it, with the requester's access: never into a transcript others read.
    if (isRedirectBody(result.body) && !(await gate.mayHandOnLink())) return failure(sharedConversationReadRefusal())
    return fromOperationResult(op.name, result)
  } catch (error) {
    if (error instanceof OperationInputError) {
      record(400)
      return failure(`${error.message}. Use describe-operation for ${op.name} to see its input schema.`)
    }
    if (error instanceof ApiError) {
      record(error.status)
      return failure(`${error.message} (HTTP ${error.status}, ${error.code})`)
    }
    console.error('[mcp] operation failed', op.name, error)
    record(500)
    return failure(`${op.name} failed on the server. Try again; if it persists, report it.`)
  }
}

// --- search ------------------------------------------------------------------

interface Hit {
  name: string
  summary: string
  domain: string
  readOnly: boolean
  destructive: boolean
  score: number
}

/** What ranking reads: a catalog operation and a backend operation both have it. */
interface Searchable {
  name: string
  summary: string
  description: string
}

function wordsOf(query: string): string[] {
  return query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}

/**
 * Plain words only. A regular expression built from the caller's text would let
 * one catastrophic pattern hold the event loop for every tenant (ReDoS), and
 * kebab-case names already split into words: `document version list` finds
 * `document-version-list`.
 */
function scorerFor(query: string): (op: Searchable) => number {
  const words = wordsOf(query)
  return (op) => {
    if (words.length === 0) return 1
    const name = op.name.toLowerCase()
    const segments = name.split('-')
    const summary = op.summary.toLowerCase()
    const description = op.description.toLowerCase()
    let total = 0
    let matched = 0
    for (const word of words) {
      const score =
        (name.includes(word) ? 3 : 0) +
        (segments.includes(word) ? 1 : 0) +
        (summary.includes(word) ? 2 : 0) +
        (description.includes(word) ? 1 : 0)
      if (score > 0) matched += 1
      total += score
    }
    // An operation that answers every word beats one that answers a single word often.
    return total + (matched === words.length ? 5 : 0)
  }
}

function rank(ctx: McpCallContext, query: string, domain: string | undefined): Hit[] {
  const score = scorerFor(query)
  const catalog: Hit[] = visibleOperations(ctx.principal)
    .filter((op) => !domain || op.domain === domain)
    .map((op) => {
      const annotations = annotationsOf(op)
      return {
        name: op.name,
        summary: op.summary,
        domain: op.domain,
        readOnly: annotations.readOnlyHint,
        destructive: annotations.destructiveHint,
        score: score(op),
      }
    })
  const backend: Hit[] = visibleBackendOperations(ctx.principal)
    .filter((op) => !domain || op.domain === domain)
    .map((op) => ({
      name: op.name,
      summary: op.summary,
      domain: op.domain,
      readOnly: op.annotations.readOnlyHint,
      destructive: op.annotations.destructiveHint,
      score: score(op),
    }))
  return [...catalog, ...backend]
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score)
}

const searchInput = z.object({
  query: z.string(),
  domain: z.enum(AGENT_DOMAINS).optional(),
  limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).optional(),
})

export function searchOperations(ctx: McpCallContext, args: unknown): CallToolResult {
  const startedAt = Date.now()
  const parsed = searchInput.safeParse(args)
  if (!parsed.success) return failure(`search-operations: ${parsed.error.issues.map((i) => i.message).join('; ')}`)
  const { query, domain, limit = DEFAULT_SEARCH_LIMIT } = parsed.data
  const hits = rank(ctx, query, domain)
  const shown = hits.slice(0, limit).map(({ score: _score, ...hit }) => hit)
  recordOperationCalled(ctx, { operation: 'search-operations', domain: domain ?? null, decision: 'run', status: 200, startedAt })
  return success({
    total: hits.length,
    operations: shown,
    next:
      shown.length === 0
        ? 'Nothing matched. Try other words, drop the domain filter, or call report-missing-operation.'
        : 'Call describe-operation for the input schema, then call-operation.',
  })
}

const describeInput = z.object({ name: z.string().min(1) })

export function describeOperation(ctx: McpCallContext, args: unknown): CallToolResult {
  const startedAt = Date.now()
  const parsed = describeInput.safeParse(args)
  if (!parsed.success) return failure('describe-operation needs { name }.')
  const backend = findVisibleBackendOperation(ctx.principal, parsed.data.name)
  if (backend) {
    recordOperationCalled(ctx, { operation: 'describe-operation', domain: backend.domain, decision: 'run', status: 200, startedAt })
    return success({
      name: backend.name,
      domain: backend.domain,
      summary: backend.summary,
      description: backend.description,
      annotations: backend.annotations,
      sensitivity: null,
      // Flat: call-operation takes these as `input` itself, with no params/query/body.
      inputSchema: backend.inputSchema,
    })
  }
  const op = findVisibleOperation(ctx.principal, parsed.data.name)
  recordOperationCalled(ctx, {
    operation: 'describe-operation',
    domain: op?.domain ?? null,
    decision: op ? 'run' : 'refused',
    status: op ? 200 : 404,
    startedAt,
  })
  if (!op) return unknownOperation(ctx, parsed.data.name)
  return success({
    name: op.name,
    domain: op.domain,
    summary: op.summary,
    description: op.description,
    annotations: annotationsOf(op),
    sensitivity: op.sensitivity ?? null,
    inputSchema: inputSchemaOf(op),
  })
}

const callInput = z.object({
  name: z.string().min(1),
  input: z
    .object({
      params: z.record(z.string()).optional(),
      query: z.record(z.unknown()).optional(),
      body: z.unknown().optional(),
      ifMatch: z.string().min(1).max(IF_MATCH_MAX_LENGTH).optional(),
    })
    .optional(),
})

const backendCallInput = z.object({ name: z.string().min(1), input: z.record(z.unknown()).optional() })

export function callOperationTool(ctx: McpCallContext, args: unknown): Promise<CallToolResult> {
  // A backend operation takes its own flat arguments (projectId among them), not { params, query, body }.
  const backendName = isRecord(args) && typeof args.name === 'string' ? args.name : null
  const backend = backendName ? findVisibleBackendOperation(ctx.principal, backendName) : undefined
  if (backend) {
    const flat = backendCallInput.safeParse(args)
    if (!flat.success) return Promise.resolve(failure(`call-operation needs { name, input } with ${backend.name}'s arguments.`))
    return runBackendOperation(ctx, backend, flat.data.input ?? {})
  }
  const parsed = callInput.safeParse(args)
  if (!parsed.success) {
    return Promise.resolve(failure('call-operation needs { name, input: { params?, query?, body? } }.'))
  }
  return runOperation(ctx, parsed.data.name, parsed.data.input ?? {})
}

const missingInput = z.object({ description: z.string().min(1).max(2_000) })

export function reportMissingOperation(ctx: McpCallContext, args: unknown): CallToolResult {
  const parsed = missingInput.safeParse(args)
  if (!parsed.success) return failure('report-missing-operation needs { description } of 1 to 2000 characters.')
  // Only the length leaves this process: server events are non-personal by rule.
  recordOperationMissing(ctx, parsed.data.description.length)
  return success({ status: 'recorded' })
}

// --- the meta-tools as JSON Schema ------------------------------------------

export const META_TOOLS = {
  'search-operations': {
    title: 'Search operations',
    description:
      'Find Piloti operations by plain words, ranked over name, summary and description. ' +
      'Start here: results name the operation to describe and call. Optionally narrow by domain.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words such as "add project member" or "document version". Empty lists a domain.' },
        domain: { type: 'string', enum: [...AGENT_DOMAINS], description: 'Only operations of this area.' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_SEARCH_LIMIT, description: `At most this many (default ${DEFAULT_SEARCH_LIMIT}).` },
      },
      required: ['query'],
      additionalProperties: false,
    },
    readOnly: true,
  },
  'describe-operation': {
    title: 'Describe an operation',
    description:
      'Full description, annotations and the input JSON Schema ({ params, query, body }) of one operation, ' +
      'by the name search-operations returned. Read it before call-operation.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'An operation name, e.g. project-list.' } },
      required: ['name'],
      additionalProperties: false,
    },
    readOnly: true,
  },
  'call-operation': {
    title: 'Call an operation',
    description:
      'Run one operation as the signed-in person, with the rights that person has. input is { params, query, body } ' +
      'as describe-operation shows (the read tools of the agent, such as knowledge-search, take their arguments flat in input, projectId among them). A refusal comes back with the route\'s own message. Destructive operations are ' +
      'marked in describe-operation; confirm those with the person first.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'An operation name from search-operations.' },
        input: {
          type: 'object',
          description: 'params: path ids; query: query string; body: JSON body; ifMatch: the version you read, for a write that refuses one over a newer version.',
          properties: {
            params: { type: 'object', additionalProperties: { type: 'string' } },
            query: { type: 'object' },
            body: {},
            ifMatch: IF_MATCH_SCHEMA,
          },
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
    readOnly: false,
  },
  'report-missing-operation': {
    title: 'Report a missing operation',
    description:
      'Tell the Piloti team what you tried to do and could not find an operation for. Use it after search-operations came back empty. ' +
      'Describe the goal, not the person or the documents involved.',
    inputSchema: {
      type: 'object',
      properties: { description: { type: 'string', minLength: 1, maxLength: 2000, description: 'What you wanted to do.' } },
      required: ['description'],
      additionalProperties: false,
    },
    readOnly: false,
  },
} as const
