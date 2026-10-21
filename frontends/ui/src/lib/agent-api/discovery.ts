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
 *   report-missing-capability, for the day search finds nothing
 *
 * The handlers here are plain functions over an {@link McpCallContext};
 * `mcp-server.ts` registers them, and registers the per-operation tools of
 * `tools` mode over the same {@link runOperation}, so both modes run one path.
 */

import type { CallToolResult } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { ApiError } from '@/lib/api/errors'
import { type JsonSchemaNode, toJsonSchema } from '@/lib/api/zod-json-schema'
import { type OperationInput, type OperationResult, OperationInputError, callOperation, parseOperationInput } from './dispatch'
import { AGENT_DOMAINS, type AgentOperation, annotationsOf } from './operation'
import { proposeOperation } from './operation-proposals'
import { callDecision, findVisibleOperation, visibleOperations } from './policy'
import { type McpCallContext, recordCapabilityMissing, recordOperationCalled } from './telemetry'

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

/** A route's answer as the tool result. A refusal keeps the route's own words: errors teach. */
function fromOperationResult(result: OperationResult): CallToolResult {
  if (result.ok) return success(result.body)
  const body = isRecord(result.body) ? result.body : null
  const message = typeof body?.error === 'string' ? body.error : `The route answered HTTP ${result.status}.`
  const code = typeof body?.code === 'string' ? `, ${body.code}` : ''
  const details = body?.details === undefined ? '' : `\nDetails: ${JSON.stringify(body.details)}`
  return failure(`${message} (HTTP ${result.status}${code})${details}`)
}

// --- the input schema of one operation -------------------------------------

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
  const schema: JsonSchemaNode = { type: 'object', properties, additionalProperties: false }
  if (required.length > 0) schema.required = required
  schemaCache.set(op.name, schema)
  return schema
}

// --- running one operation --------------------------------------------------

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
    recordOperationCalled(ctx, { operation: name, domain: null, decision: 'refused', status: 404, startedAt })
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
      return success({
        proposed: true,
        applied: false,
        proposalId: proposal.proposalId,
        summary: proposal.summary,
        note: 'Nothing was changed. The person sees this proposal in Piloti and accepts or dismisses it.',
      })
    }
    const result = await callOperation(op, input, ctx.principal.session)
    record(result.status)
    return fromOperationResult(result)
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

function wordsOf(query: string): string[] {
  return query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}

/**
 * Plain words only. A regular expression built from the caller's text would let
 * one catastrophic pattern hold the event loop for every tenant (ReDoS), and
 * kebab-case names already split into words: `document version list` finds
 * `document-version-list`.
 */
function scorerFor(query: string): (op: AgentOperation) => number {
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
  return visibleOperations(ctx.principal)
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
        ? 'Nothing matched. Try other words, drop the domain filter, or call report-missing-capability.'
        : 'Call describe-operation for the input schema, then call-operation.',
  })
}

const describeInput = z.object({ name: z.string().min(1) })

export function describeOperation(ctx: McpCallContext, args: unknown): CallToolResult {
  const startedAt = Date.now()
  const parsed = describeInput.safeParse(args)
  if (!parsed.success) return failure('describe-operation needs { name }.')
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
    })
    .optional(),
})

export function callOperationTool(ctx: McpCallContext, args: unknown): Promise<CallToolResult> {
  const parsed = callInput.safeParse(args)
  if (!parsed.success) {
    return Promise.resolve(failure('call-operation needs { name, input: { params?, query?, body? } }.'))
  }
  return runOperation(ctx, parsed.data.name, parsed.data.input ?? {})
}

const missingInput = z.object({ description: z.string().min(1).max(2_000) })

export function reportMissingCapability(ctx: McpCallContext, args: unknown): CallToolResult {
  const parsed = missingInput.safeParse(args)
  if (!parsed.success) return failure('report-missing-capability needs { description } of 1 to 2000 characters.')
  // Only the length leaves this process: server events are non-personal by rule.
  recordCapabilityMissing(ctx, parsed.data.description.length)
  return success({ status: 'recorded' })
}

// --- the meta-tools as JSON Schema ------------------------------------------

export const META_TOOLS = {
  'search-operations': {
    title: 'Search operations',
    description:
      'Find Piloti operations by plain words (ranked over name, summary, description) or a regular expression. ' +
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
      'as describe-operation shows. A refusal comes back with the route\'s own message. Destructive operations are ' +
      'marked in describe-operation; confirm those with the person first.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'An operation name from search-operations.' },
        input: {
          type: 'object',
          description: 'params: path ids; query: query string; body: JSON body.',
          properties: {
            params: { type: 'object', additionalProperties: { type: 'string' } },
            query: { type: 'object' },
            body: {},
          },
          additionalProperties: false,
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
    readOnly: false,
  },
  'report-missing-capability': {
    title: 'Report a missing capability',
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
