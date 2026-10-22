import 'server-only'
/**
 * Progressive discovery for the agent door (ADR-0122).
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
import { type SearchableOperation, operationScorer } from '@/lib/text/operation-search'
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
  validateOperationInput,
} from './dispatch'
import { type BackendOperation, type JsonSchemaObject, callBackendOperation, toMcpContent } from './backend-operations'
import { AGENT_OPERATIONS } from './catalog'
import { type AgentOperation, annotationsOf } from './operation'
import { proposeOperation } from './operation-proposals'
import {
  type AgentDoor,
  callDecision,
  canSee,
  doorOfPrincipal,
  findVisibleBackendOperation,
  findVisibleOperation,
  isOnDoor,
  nativeToolOf,
  visibleBackendOperations,
  visibleDomains,
  visibleOperations,
} from './policy'
import type { AgentPrincipal } from './principal'
import { readGateFor, sharedConversationReadRefusal } from './read-gate'
import { type McpCallContext, recordOperationCalled, recordOperationMissing } from './telemetry'

/**
 * Longest text a result carries; beyond it the call must be narrowed. The one
 * cap on what an agent reads from this server: Piloti's own client
 * (`tools/workspace/client.py`) adds none of its own.
 */
export const MAX_RESULT_CHARS = 40_000
const DEFAULT_SEARCH_LIMIT = 10
const MAX_SEARCH_LIMIT = 50
/** A search is a few words; past this it is not one, and ranking it would cost every tenant the time. */
export const MAX_SEARCH_QUERY_LENGTH = 200

// --- results ---------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const GENERIC_NARROWING_HINT = 'Narrow the call to page through it: pass a smaller limit or filters in input.query, or fetch one item by id.'

/**
 * How to narrow `op`'s answer, from the input it really takes: the query
 * parameters it names, or, when it has none, a plain statement that it has no
 * filter. A hint naming a parameter the operation lacks sends the agent into a
 * refusal.
 */
export function narrowingHint(op: { readonly query?: z.ZodObject<z.ZodRawShape>; readonly inputSchema?: JsonSchemaObject }): string {
  const names = op.inputSchema
    ? Object.keys(op.inputSchema.properties ?? {}).filter((name) => name !== 'projectId')
    : Object.keys(op.query?.shape ?? {})
  if (names.length === 0) {
    return (
      'This operation has no limit or filter, so its answer cannot be narrowed here. ' +
      'Use a narrower operation (search-operations with this domain lists them), or one that fetches a single item by id.'
    )
  }
  const where = op.inputSchema ? 'in input' : 'in input.query'
  return `Narrow the call with the parameters this operation takes (${names.join(', ')}) ${where}, or fetch one item by id with a narrower operation.`
}

/**
 * Text for a model, capped; whether it was cut. Compact JSON: indentation is a
 * third of a pretty-printed answer, and the model reads it as tokens it pays for.
 */
function renderText(value: unknown, hint = GENERIC_NARROWING_HINT): { text: string; truncated: boolean } {
  const full = typeof value === 'string' ? value : (JSON.stringify(value) ?? 'null')
  if (full.length <= MAX_RESULT_CHARS) return { text: full, truncated: false }
  const note =
    `\n\n[Truncated: showing ${MAX_RESULT_CHARS} of ${full.length} characters. ` +
    `${hint}]`
  return { text: full.slice(0, MAX_RESULT_CHARS) + note, truncated: true }
}

function success(value: unknown, hint?: string): CallToolResult {
  const { text, truncated } = renderText(value, hint)
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
            'For a document, read it by its pages with passage-read, or call document-download for a ' +
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
function oversizedResult(op: AgentOperation | BackendOperation, body: OversizedBody): CallToolResult {
  const opName = op.name
  return failure(
    `${opName} answered with more than ${sizeText(MAX_TEXT_BYTES)} of ${body.contentType || 'text'}` +
      (body.bytes === null ? '' : ` (${sizeText(body.bytes)})`) +
      `, so it was not read. ${narrowingHint(op)}`
  )
}

/**
 * A refusal in the error envelope every route answers with (`{ error, code,
 * details }`, `errorResponse` in `lib/api/handler.ts`), which the backend's
 * refusals are normalised to as well (`callBackendOperation`). The refuser's own
 * words: errors teach.
 */
function refusalResult(result: OperationResult): CallToolResult {
  const body = isRecord(result.body) ? result.body : null
  const message = typeof body?.error === 'string' ? body.error : `The server answered HTTP ${result.status}.`
  const code = typeof body?.code === 'string' ? `, ${body.code}` : ''
  const details = body?.details === undefined ? '' : `\nDetails: ${JSON.stringify(body.details)}`
  return failure(`${message} (HTTP ${result.status}${code})${details}`)
}

/** A route's answer as the tool result. */
function fromOperationResult(op: AgentOperation, result: OperationResult): CallToolResult {
  const opName = op.name
  if (isOversizedBody(result.body)) return oversizedResult(op, result.body)
  if (!result.ok) return refusalResult(result)
  if (isBinaryBody(result.body)) return binaryResult(opName, result.body)
  if (isRedirectBody(result.body)) return redirectResult(opName, result.body.location)
  return success(result.body, narrowingHint(op))
}

/**
 * The backend's answer to a read tool as the tool result. Success is
 * `{ tool, result }`: the result is capped text with structuredContent, except
 * the page-image tool's content blocks, which stay images.
 */
function fromBackendResult(op: BackendOperation, result: OperationResult): CallToolResult {
  const hint = narrowingHint(op)
  if (isOversizedBody(result.body)) return oversizedResult(op, result.body)
  if (!result.ok) return refusalResult(result)
  const value = isRecord(result.body) && 'result' in result.body ? result.body.result : result.body
  if (!Array.isArray(value)) return success(value, hint)
  const content = toMcpContent(value).map((block) =>
    block.type === 'text' ? { type: 'text' as const, text: renderText(block.text, hint).text } : block,
  )
  return { content }
}

// --- the input schema of one operation -------------------------------------

/** An ETag is short; anything longer is not one. */
const IF_MATCH_MAX_LENGTH = 256

const IF_MATCH_SCHEMA = {
  type: 'string',
  minLength: 1,
  maxLength: IF_MATCH_MAX_LENGTH,
  description: 'Sent as If-Match: the version you read. A write over a newer one is refused (409); read again, then retry.',
} as const

const schemaCache = new Map<string, JsonSchemaNode>()

/**
 * `node` without what JSON Schema already means when it is absent:
 * `additionalProperties: true` (the zod exporter writes it on every object that
 * is not strict). An agent pays for every token of a tool list, and this one
 * says nothing; validation is unchanged.
 */
export function withoutDefaults(node: JsonSchemaNode): JsonSchemaNode {
  if (Array.isArray(node)) return node.map((item) => withoutDefaults(item as JsonSchemaNode)) as unknown as JsonSchemaNode
  if (typeof node !== 'object' || node === null) return node
  return Object.fromEntries(
    Object.entries(node)
      .filter(([key, value]) => !(key === 'additionalProperties' && value === true))
      .map(([key, value]) => [key, typeof value === 'object' && value !== null ? withoutDefaults(value as JsonSchemaNode) : value]),
  ) as JsonSchemaNode
}

function part(schema: Parameters<typeof toJsonSchema>[0]): { node: JsonSchemaNode; required: boolean } {
  try {
    const node = withoutDefaults(toJsonSchema(schema))
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
  // Only where the route reads the header: offered anywhere else, it would be a version check nobody makes.
  if (op.ifMatchHeader) properties.ifMatch = IF_MATCH_SCHEMA
  const schema: JsonSchemaNode = { type: 'object', properties, additionalProperties: false }
  if (required.length > 0) schema.required = required
  // JSON Schema's own keyword for sample instances (2020-12, `examples`).
  if (op.examples && op.examples.length > 0) schema.examples = op.examples as unknown as JsonSchemaNode
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
    return fromBackendResult(op, result)
  } catch (error) {
    console.error('[mcp] backend operation failed', op.name, error)
    record(500)
    return failure(`${op.name} failed on the server. Try again; if it persists, report it.`)
  }
}

/**
 * What Piloti reads when it names an operation it does with a native tool
 * (`piloti: 'native:<tool>'` in `exposure.config.ts`): the tool, not a search.
 */
export function nativeToolRefusal(name: string, tool: string): string {
  return `${name} is not offered to you: you do this with your own tool ${tool}. Call that instead.`
}

function unknownOperation(ctx: McpCallContext, name: string): CallToolResult {
  const native = ctx.principal.actor === 'piloti' ? nativeToolOf(name) : undefined
  if (native) return failure(nativeToolRefusal(name, native))
  // The search schema bounds a query; a name the agent typed is bounded here, the one unchecked text ranked.
  const near = rank(ctx, name.slice(0, MAX_SEARCH_QUERY_LENGTH), undefined)
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
      const parsed = validateOperationInput(op, input)
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
    const refused = await gate.beforeRead(op, input)
    if (refused) {
      record(403)
      return failure(refused)
    }
    // An agent reads the answer: a route that words its refusal in the person's locale words it in English.
    const result = await callOperation(op, input, ctx.principal.session, 'agent')
    record(result.status)
    // A link works for whoever holds it, with the requester's access: never into a transcript others read.
    if (isRedirectBody(result.body) && !(await gate.mayHandOnLink())) return failure(sharedConversationReadRefusal())
    return fromOperationResult(op, result)
  } catch (error) {
    if (error instanceof OperationInputError) {
      record(400)
      return failure(inputRefusal(op, error))
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

/** Longest input schema quoted in a refusal; a larger one is a describe-operation away. */
const INLINE_SCHEMA_CHARS = 2_000

/** What was wrong with the input, and the schema to fix it with when it is short: one round, not two. */
function inputRefusal(op: AgentOperation, error: OperationInputError): string {
  const schema = JSON.stringify(inputSchemaOf(op))
  return schema.length <= INLINE_SCHEMA_CHARS
    ? `${error.message}. The input schema of ${op.name}: ${schema}`
    : `${error.message}. Use describe-operation for ${op.name} to see its input schema.`
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

/**
 * The scorer for `query` on `ctx`'s door: a word weighs by how rare it is among
 * every operation this caller can see, so the weights do not move with a domain
 * filter and a hidden operation is never part of them.
 */
function scorerFor(ctx: McpCallContext, query: string): (op: SearchableOperation) => number {
  return operationScorer(query, [...visibleOperations(ctx.principal), ...visibleBackendOperations(ctx.principal)])
}

/**
 * Ranks with {@link operationScorer}: German and English words find the same operation (ADR-0123).
 * `query` is at most {@link MAX_SEARCH_QUERY_LENGTH} characters: the search schema refuses a longer one.
 */
function rank(ctx: McpCallContext, query: string, domain: string | undefined): Hit[] {
  const score = scorerFor(ctx, query)
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

/** The search input on `principal`'s door: only the domains the door offers may be named. */
function searchInput(principal: AgentPrincipal) {
  const domains = visibleDomains(doorOfPrincipal(principal)) as [string, ...string[]]
  return z.object({
    query: z.string().max(MAX_SEARCH_QUERY_LENGTH),
    domain: z.enum(domains).optional(),
    limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).optional(),
  })
}

/**
 * The sentence a search adds when an operation it does not offer this caller
 * (one that widens access, touches a credential or turns a control down) would
 * have ranked first: without it the top hit is the nearest thing that is NOT
 * what was asked (`Mitglied hinzufügen` finds the people list, not a project
 * role). It names no operation: what is hidden stays absent from the listing.
 */
export const SENSITIVE_MATCH_NOTE =
  'An operation that changes who may do what, a credential or a security control matches this request, and it ' +
  'is not offered to you: none of the operations listed does that. Tell the person to make that change in Piloti themselves.'

function sensitiveMatchOutranks(ctx: McpCallContext, query: string, domain: string | undefined, best: number): boolean {
  const score = scorerFor(ctx, query)
  return AGENT_OPERATIONS.some(
    (op) =>
      op.sensitivity !== undefined &&
      // Off the door is unknown to everyone, never a hint (`isOnDoor`).
      isOnDoor(op.name, doorOfPrincipal(ctx.principal)) &&
      (!domain || op.domain === domain) &&
      !canSee(ctx.principal, op) &&
      score(op) > 0 &&
      score(op) >= best,
  )
}

/**
 * Where to go when no operation matched. The words of a question about what a
 * document or the law SAYS (`Brandschutz Anforderungen Gebäudeklasse 5`) are
 * in the documents, not in the catalog, so the search finds nothing and the
 * agent concluded the door could not answer. It names the operations that read
 * content, when this caller can see them.
 */
export function nothingMatched(ctx: McpCallContext): string {
  const visible = new Set(visibleBackendOperations(ctx.principal).map((op) => op.name))
  for (const op of visibleOperations(ctx.principal)) visible.add(op.name)
  const readers = CONTENT_READERS.filter(({ name }) => visible.has(name)).map(({ name, what }) => `${name} (${what})`)
  const retry = 'try other words (the catalog is English), drop the domain filter, or call report-missing-operation.'
  if (readers.length === 0) return `Nothing matched. Try ${retry.slice(4)}`
  return (
    "Nothing matched. The catalog lists actions, not what documents say: for a question about a document's or " +
    `the law's content, call ${readers.join(', or ')}. Otherwise ${retry}`
  )
}

/** The operations that answer from content rather than act, in the order an agent should try them. */
const CONTENT_READERS = [
  { name: 'knowledge-search', what: 'quotable passages from the project, the office and the building-law corpus' },
  { name: 'law-lookup', what: 'a provision of Austrian law' },
  { name: 'piloti-ask-create', what: 'Piloti answers it with sources' },
] as const

export function searchOperations(ctx: McpCallContext, args: unknown): CallToolResult {
  const startedAt = Date.now()
  const parsed = searchInput(ctx.principal).safeParse(args)
  if (!parsed.success) return failure(`search-operations: ${parsed.error.issues.map((i) => i.message).join('; ')}`)
  const { query, domain, limit = DEFAULT_SEARCH_LIMIT } = parsed.data
  const hits = rank(ctx, query, domain)
  const shown = hits.slice(0, limit).map(({ score: _score, ...hit }) => hit)
  recordOperationCalled(ctx, { operation: 'search-operations', domain: domain ?? null, decision: 'run', status: 200, startedAt })
  const next =
    shown.length === 0
      ? nothingMatched(ctx)
      : 'Call call-operation with the name; call describe-operation first when you do not know its input.'
  const hidden = query.trim() !== '' && sensitiveMatchOutranks(ctx, query, domain, hits[0]?.score ?? 0)
  return success({ total: hits.length, operations: shown, next: hidden ? `${SENSITIVE_MATCH_NOTE} ${next}` : next })
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
  // A name the caller cannot see is unknown whatever shape its input has: say that, not how to shape it.
  if (backendName && !findVisibleOperation(ctx.principal, backendName)) {
    return runOperation(ctx, backendName, {})
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

/** One meta-tool as `tools/list` shows it. */
export interface MetaTool {
  readonly title: string
  readonly description: string
  readonly inputSchema: JsonSchemaNode
  readonly readOnly: boolean
}

export type MetaToolName = 'search-operations' | 'describe-operation' | 'call-operation' | 'report-missing-operation'

/** What `search-operations` says it searches, per door, and the example query it gives. */
const SEARCH_SCOPE: Readonly<Record<AgentDoor, { area: string; example: string; operation: string }>> = {
  office: {
    area:
      'the Piloti workspace (projects, members, documents and their versions, review, the inbox, tasks, building-law ' +
      'knowledge, BIM models)',
    example: 'add project member',
    operation: 'project-list',
  },
  platform: {
    area:
      'the Piloti platform console (organizations and their limits, fleet-wide models, reasoning, retrieval and pricing, ' +
      'the base knowledge corpus, platform skills, lessons, feedback and quality views, maintenance)',
    example: 'set default models',
    operation: 'platform-overview-get',
  },
}

/**
 * The four meta-tools of `search` mode, as `principal` sees them: the domain
 * list names only the areas the door offers. The single source of their words: Piloti's own client reads the
 * in-product variant from `src/aiq_agent/tools/workspace/meta_tools.json`,
 * which `meta-tools.spec.ts` writes from here and holds current.
 */
export function metaToolsFor(principal: Pick<AgentPrincipal, 'actor' | 'door'>): Record<MetaToolName, MetaTool> {
  const piloti = principal.actor === 'piloti'
  const door = doorOfPrincipal(principal)
  const scope = SEARCH_SCOPE[door]
  // Piloti has the agent read tools natively and never sees them here; the platform door does not offer them.
  const flatTools =
    piloti || door !== 'office' ? '' : '; the agent read tools such as knowledge-search take their own arguments flat in `input` instead'
  const writes = piloti
    ? 'A write is never run: the result says "Proposed" and nothing changed, because the person decides on a card. Say in one ' +
      'sentence what is proposed, and never claim it is done.'
    : 'Destructive operations are marked in search and describe results; confirm those with the person first.'
  return {
    'search-operations': {
      title: 'Search operations',
      description:
        `Find what can be done in ${scope.area} by plain words, ranked over each operation's name, summary and description. Start here. Answers ` +
        'operation names with one line each and whether each reads, writes or destroys. Then call-operation.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            maxLength: MAX_SEARCH_QUERY_LENGTH,
            description: `The goal in a few plain words, e.g. "${scope.example}". Empty lists everything, or a whole domain.`,
          },
          domain: { type: 'string', enum: [...visibleDomains(door)], description: 'Only operations of this area.' },
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
        'One operation\'s description, annotations and input JSON Schema ({ params, query, body }), by the exact name ' +
        'search-operations returned. Call it before the first call of an operation whose input you do not know. An unknown ' +
        'name comes back with similar names.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: `An operation name, e.g. ${scope.operation}.` } },
        required: ['name'],
        additionalProperties: false,
      },
      readOnly: true,
    },
    'call-operation': {
      title: 'Call an operation',
      description:
        'Run one operation as the signed-in person, with that person\'s rights. `input` is { params, query, body } as ' +
        `describe-operation shows it (params: path ids; query: the query string; body: the JSON body)${flatTools}. ` +
        'Input that does not fit comes back with the reason. A refusal names the reason and the next step; do not repeat ' +
        `the same call. ${writes}`,
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'An operation name from search-operations.' },
          // Untyped on purpose: the catalog's operations take { params, query, body }, the agent read tools their
          // own flat arguments (knowledge-search's `query` is a string). The handler validates per operation.
          input: { type: 'object', description: 'The operation\'s input, as describe-operation shows it.' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      readOnly: false,
    },
    'report-missing-operation': {
      title: 'Report a missing operation',
      description:
        'Count a gap: the person wants something done in the workspace and search-operations found no operation for it with ' +
        'two different phrasings. The Piloti team sees that a gap was reported, never your words, so describe the goal ' +
        'without names or document contents. Then tell the person it cannot be done here yet.',
      inputSchema: {
        type: 'object',
        properties: { description: { type: 'string', minLength: 1, maxLength: 2000, description: 'The goal that has no operation.' } },
        required: ['description'],
        additionalProperties: false,
      },
      readOnly: false,
    },
  }
}
