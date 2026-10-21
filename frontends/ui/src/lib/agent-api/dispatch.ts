import 'server-only'
/**
 * Run one operation as a person, through the browser's own route handler
 * (ADR-0121).
 *
 * The call is a `Request` built from the operation's method and path and
 * handed to the route's exported handler in-process, inside
 * {@link runAsActingSession}. The handler's factory then does what it does for
 * a browser: resolves the session (now the acting one), checks the `authz`
 * declaration, charges the rate limit, opens the tenant slot and parses the
 * body with the route's own schema. Nothing here re-states a rule a route
 * already holds; the operation's zod input only shapes what the agent sends.
 *
 * In-process, not over HTTP: a loopback request would need a credential that
 * every route accepts, which is exactly the second door this design refuses.
 */

import type { AuthorizedSession } from '@/lib/auth/types'
import { runAsActingSession } from './acting-session'
import { type AgentOperation, pathParams } from './operation'

/** Where a dispatched request appears to come from. Never resolved; routes only parse it. */
const DISPATCH_ORIGIN = 'http://piloti.mcp.internal'

export interface OperationInput {
  /** One entry per `[name]` segment of the operation's path. */
  readonly params?: Record<string, string>
  readonly query?: Record<string, unknown>
  readonly body?: unknown
}

export interface OperationResult {
  readonly status: number
  readonly ok: boolean
  /** Parsed JSON, the text of a text response, or a note for a binary one. */
  readonly body: unknown
}

export class OperationInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OperationInputError'
  }
}

/** The concrete path: each `[name]` replaced by its encoded value. */
export function resolvePath(op: AgentOperation, params: Record<string, string> = {}): string {
  const missing = pathParams(op.path).filter((name) => !params[name])
  if (missing.length > 0) {
    throw new OperationInputError(`${op.name} needs ${missing.map((name) => `params.${name}`).join(', ')}`)
  }
  return op.path.replace(/\[(?:\.\.\.)?([^\]]+)\]/g, (_, name: string) =>
    encodeURIComponent(params[name] as string),
  )
}

/** Query values as the UI sends them: scalars as strings, arrays repeated, objects as JSON. */
export function searchParamsOf(query: Record<string, unknown> = {}): URLSearchParams {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue
    const values = Array.isArray(value) ? value : [value]
    for (const item of values) {
      search.append(key, typeof item === 'object' ? JSON.stringify(item) : String(item))
    }
  }
  return search
}

async function readBody(response: Response): Promise<unknown> {
  const type = response.headers.get('content-type') ?? ''
  if (response.status === 204) return null
  if (type.includes('json')) return response.json().catch(() => null)
  if (type.startsWith('text/')) return response.text()
  const size = response.headers.get('content-length')
  return { binary: true, contentType: type || null, bytes: size ? Number(size) : null }
}

/** Validate `input` against the operation's schemas; the parsed input, or an {@link OperationInputError}. */
export function parseOperationInput(op: AgentOperation, input: OperationInput): OperationInput {
  const parse = (schema: AgentOperation['params'] | AgentOperation['body'], value: unknown, label: string) => {
    if (!schema) return value
    const result = schema.safeParse(value ?? {})
    if (result.success) return result.data
    const issues = result.error.issues.map((issue) => `${label}.${issue.path.join('.')}: ${issue.message}`)
    throw new OperationInputError(`${op.name}: ${issues.join('; ')}`)
  }
  return {
    params: parse(op.params, input.params, 'params') as Record<string, string> | undefined,
    query: parse(op.query, input.query, 'query') as Record<string, unknown> | undefined,
    body: op.body ? parse(op.body, input.body, 'body') : input.body,
  }
}

/**
 * Call `op` as `session`. Route refusals come back as a result with their
 * status and the route's error envelope, exactly as the browser sees them;
 * only input the operation cannot even address throws.
 */
export async function callOperation(
  op: AgentOperation,
  input: OperationInput,
  session: AuthorizedSession,
): Promise<OperationResult> {
  const parsed = parseOperationInput(op, input)
  const url = new URL(resolvePath(op, parsed.params), DISPATCH_ORIGIN)
  url.search = searchParamsOf(parsed.query).toString()

  const hasBody = op.method !== 'GET' && parsed.body !== undefined
  const request = new Request(url, {
    method: op.method,
    headers: hasBody ? { 'content-type': 'application/json' } : {},
    body: hasBody ? JSON.stringify(parsed.body) : undefined,
  })

  const module = await op.load()
  const handler = module[op.method]
  if (!handler) throw new Error(`${op.path} exports no ${op.method} handler`)

  const response = await runAsActingSession(session, () =>
    handler(request, { params: Promise.resolve(parsed.params ?? {}) }),
  )
  return { status: response.status, ok: response.ok, body: await readBody(response) }
}
