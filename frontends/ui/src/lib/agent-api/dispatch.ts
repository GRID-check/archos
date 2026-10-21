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
import { type UploadBody, decodeBase64 } from './upload-wire'

/** Where a dispatched request appears to come from. Never resolved; routes only parse it. */
const DISPATCH_ORIGIN = 'http://piloti.mcp.internal'

export interface OperationInput {
  /** One entry per `[name]` segment of the operation's path. */
  readonly params?: Record<string, string>
  readonly query?: Record<string, unknown>
  readonly body?: unknown
  /**
   * Sent as `If-Match`: the version the caller read, for the routes that
   * refuse a write over a newer one (the project profile, a version's content).
   * The only header an operation carries; everything else a route reads from
   * the session or the body.
   */
  readonly ifMatch?: string
}

/**
 * The most bytes of a binary answer that travel inline, as base64 in the tool
 * result. 5 MiB of file is about 7 MB of base64: what a model client can hold
 * in one turn. A larger answer is described, never sent; the agent gets a way
 * to read it in parts or as text instead.
 */
export const MAX_INLINE_BYTES = 5 * 1024 * 1024

/** A binary answer (a PDF, a Word file, a zip) read from a route. */
export interface BinaryBody {
  readonly binary: true
  readonly contentType: string | null
  /** The size when known; `null` for a stream that did not say and was cut off. */
  readonly bytes: number | null
  /** From `Content-Disposition`, when the route names the file. */
  readonly filename?: string
  /** The bytes as base64; absent when {@link tooLarge}. */
  readonly base64?: string
  readonly tooLarge?: true
}

/** A route that answered with a redirect, usually to a presigned URL. Never followed server-side. */
export interface RedirectBody {
  readonly redirect: true
  readonly location: string
}

export function isBinaryBody(value: unknown): value is BinaryBody {
  return typeof value === 'object' && value !== null && (value as { binary?: unknown }).binary === true
}

export function isRedirectBody(value: unknown): value is RedirectBody {
  return typeof value === 'object' && value !== null && (value as { redirect?: unknown }).redirect === true
}

export interface OperationResult {
  readonly status: number
  readonly ok: boolean
  /** Parsed JSON, the text of a text response, a {@link BinaryBody} or a {@link RedirectBody}. */
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

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/** The file name a `Content-Disposition` header carries (`filename*` first), or `undefined`. */
export function filenameFromDisposition(header: string | null): string | undefined {
  if (!header) return undefined
  const extended = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header)?.[1]
  if (extended) {
    try {
      return decodeURIComponent(extended.trim())
    } catch {
      // Fall through to the plain form.
    }
  }
  const plain = /filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]+))/.exec(header)
  const name = (plain?.[1] ?? plain?.[2])?.trim().replace(/\\(.)/g, '$1')
  return name || undefined
}

/** Read at most `max` bytes of `response`; `null` as soon as it is clear there are more. */
async function readAtMost(response: Response, max: number): Promise<Uint8Array | null> {
  const reader = response.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

async function readBinary(response: Response, contentType: string | null): Promise<BinaryBody> {
  const declared = Number(response.headers.get('content-length'))
  const size = response.headers.get('content-length') !== null && Number.isFinite(declared) ? declared : null
  const filename = filenameFromDisposition(response.headers.get('content-disposition'))
  const named = filename ? { filename } : {}
  if (size !== null && size > MAX_INLINE_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    return { binary: true, contentType, bytes: size, ...named, tooLarge: true }
  }
  const bytes = await readAtMost(response, MAX_INLINE_BYTES)
  if (!bytes) return { binary: true, contentType, bytes: size, ...named, tooLarge: true }
  return {
    binary: true,
    contentType,
    bytes: bytes.byteLength,
    ...named,
    base64: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64'),
  }
}

async function readBody(response: Response): Promise<unknown> {
  const type = response.headers.get('content-type') ?? ''
  if (response.status === 204) return null
  const location = response.headers.get('location')
  if (REDIRECT_STATUSES.has(response.status) && location) return { redirect: true, location }
  if (type.includes('json')) return response.json().catch(() => null)
  if (type.startsWith('text/')) return response.text()
  const binary = await readBinary(response, type || null)
  // An answer with no type and no bytes is an empty success, not a file.
  return !type && binary.bytes === 0 ? null : binary
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
    ifMatch: typeof input.ifMatch === 'string' ? input.ifMatch : undefined,
  }
}

/** The multipart form the UI's uploader would send: a `file` part and the route's text fields. */
export function formDataOf(body: UploadBody): FormData {
  const form = new FormData()
  for (const [key, value] of Object.entries(body.fields ?? {})) {
    if (typeof value === 'string' && value !== '') form.append(key, value)
  }
  for (const file of body.files) {
    const bytes = decodeBase64(file.contentBase64)
    if (!bytes) throw new OperationInputError('body.files: contentBase64 is not valid base64 or is over the size cap')
    form.append('file', new File([bytes], file.name, { type: file.mimeType || 'application/octet-stream' }))
  }
  return form
}

function requestInit(op: AgentOperation, parsed: OperationInput): Pick<RequestInit, 'headers' | 'body'> {
  const headers: Record<string, string> = {}
  if (parsed.ifMatch) headers['if-match'] = parsed.ifMatch
  if (op.method === 'GET' || parsed.body === undefined) return { headers }
  if (op.bodyEncoding === 'multipart') {
    // No content-type: `Request` adds `multipart/form-data` with its boundary.
    return { headers, body: formDataOf(parsed.body as UploadBody) }
  }
  if (op.bodyEncoding === 'raw') {
    const bytes = decodeBase64((parsed.body as { contentBase64: string }).contentBase64)
    if (!bytes) throw new OperationInputError('body.contentBase64 is not valid base64 or is over the size cap')
    headers['content-type'] = 'application/octet-stream'
    // A browser states the length; the mail import checks it against the part size.
    headers['content-length'] = String(bytes.byteLength)
    return { headers, body: bytes }
  }
  headers['content-type'] = 'application/json'
  return { headers, body: JSON.stringify(parsed.body) }
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

  const request = new Request(url, { method: op.method, ...requestInit(op, parsed) })

  const routeModule = await op.load()
  const handler = routeModule[op.method]
  if (!handler) throw new Error(`${op.path} exports no ${op.method} handler`)

  const response = await runAsActingSession(session, () =>
    handler(request, { params: Promise.resolve(parsed.params ?? {}) }),
  )
  const body = await readBody(response)
  // A redirect is an answer (the link), not a failure, though `Response.ok` is false for it.
  return { status: response.status, ok: response.ok || isRedirectBody(body), body }
}
