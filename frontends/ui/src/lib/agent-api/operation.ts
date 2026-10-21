/**
 * One thing a person can do in Piloti, described for an agent (ADR-0121).
 *
 * An operation is not a new door. It names a route the UI already calls
 * (`method` + `path`), says in words an agent can act on when to call it and
 * what comes back, and states the input as zod so it can be shown as JSON
 * Schema. The route stays the gate: its `authz` declaration, its rate limit,
 * its tenant slot and its own body parsing apply to an agent exactly as they
 * apply to a browser. The catalog only makes the door findable.
 *
 * The shape follows PostHog's MCP catalog, which is the reference for this
 * record: kebab-case `<entity>-<verb>` names under 52 characters, a short
 * summary for search, a description that names the next call, and annotations
 * that say whether a call reads, writes or destroys.
 */

import type { z } from 'zod'

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/** A route handler as `lib/api/handler.ts` builds one. */
export type RouteHandler = (
  request: Request,
  context?: { params?: Promise<Record<string, string | string[]>> },
) => Promise<Response>

/** What `import('@/app/api/…/route')` resolves to, as far as the dispatcher reads it. */
export type RouteModule = Partial<Record<HttpMethod, RouteHandler>>

/** The areas of the workspace, in the order `tools` lists them. */
export const AGENT_DOMAINS = [
  'projects',
  'documents',
  'folders',
  'review',
  'conversations',
  'collaboration',
  'tasks',
  'skills',
  'knowledge',
  'bim',
  'organization',
  'platform',
] as const

export type AgentDomain = (typeof AGENT_DOMAINS)[number]

export interface AgentOperation {
  /** `<entity>-<verb>`, kebab-case, at most 52 characters, unique. */
  readonly name: string
  readonly domain: AgentDomain
  /** One line for `tools` and `search`. */
  readonly summary: string
  /**
   * When to call it, what it returns, and what to call next. Written for the
   * model: the description is the only guidance that reaches it.
   */
  readonly description: string
  readonly method: HttpMethod
  /** The route's path as its folder spells it: `/api/projects/[id]/members`. */
  readonly path: `/api/${string}`
  /**
   * The route module, imported lazily: `() => import('@/app/api/projects/[id]/members/route')`.
   * The dispatcher calls its `method` export, so the call runs the browser's
   * handler. `agent-reachability.spec.ts` holds the import to `path`.
   */
  readonly load: () => Promise<RouteModule>
  /** The dynamic segments, one key per `[name]` in `path`. */
  readonly params?: z.ZodObject<z.ZodRawShape>
  /** Query string parameters. */
  readonly query?: z.ZodObject<z.ZodRawShape>
  /** The JSON body the route parses, reused from the route's own schema where it is exported. */
  readonly body?: z.ZodTypeAny
  /**
   * A call that changes nothing. Defaults to `method === 'GET'`; a POST that
   * searches or computes says `true`.
   */
  readonly readOnly?: boolean
  /**
   * A call a person would confirm in the UI: it deletes, revokes or releases
   * something. Defaults to `method === 'DELETE'`.
   */
  readonly destructive?: boolean
  /** Calling it twice with the same input leaves the same state. Defaults to GET, PUT and DELETE. */
  readonly idempotent?: boolean
  /**
   * An operation that widens who may do what (`access`: sharing, folder
   * access, role definitions) or touches the organization's secrets
   * (`secret`: LLM provider keys). An agent may call it for a person who holds
   * the right, under the extra guards ADR-0121 names: the organization opted
   * in, the client was granted the step-up scope, the person confirms, and
   * Piloti in-product only ever proposes it.
   */
  readonly sensitivity?: Sensitivity
}

export const SENSITIVITIES = ['access', 'secret'] as const
export type Sensitivity = (typeof SENSITIVITIES)[number]

/**
 * The MCP tool annotations for `op` (specification, `ToolAnnotations`), every
 * hint stated rather than left to the spec's defaults: an absent
 * `destructiveHint` means "destructive", which would make every write look
 * like a delete to a client that asks its user before each one.
 */
export interface ToolAnnotations {
  readonly title: string
  readonly readOnlyHint: boolean
  readonly destructiveHint: boolean
  readonly idempotentHint: boolean
  /** Piloti's operations reach the organization's own workspace, a closed world. */
  readonly openWorldHint: false
}

export function annotationsOf(op: AgentOperation): ToolAnnotations {
  const readOnlyHint = op.readOnly ?? op.method === 'GET'
  return {
    title: op.summary,
    readOnlyHint,
    // A sensitive write is always one the client confirms with the person.
    destructiveHint: !readOnlyHint && (op.sensitivity !== undefined || (op.destructive ?? op.method === 'DELETE')),
    idempotentHint: readOnlyHint || (op.idempotent ?? (op.method === 'PUT' || op.method === 'DELETE')),
    openWorldHint: false,
  }
}

/** The `[name]` segments of a route path, in order. */
export function pathParams(path: string): string[] {
  return [...path.matchAll(/\[(?:\.\.\.)?([^\]]+)\]/g)].map((match) => match[1] as string)
}
