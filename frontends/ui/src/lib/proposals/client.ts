/**
 * The typed client for proposed changes (ADR-0055, ADR-0105): the person
 * routes under `/api/proposals` (a shelf's open proposals) and
 * `/api/proposals/[id]`.
 *
 * The paths, the verbs and the response shapes are written once, here; the
 * file-operation card and the route specs both go through it, so a second
 * consumer cannot disagree with the first about what `…/apply` returns.
 * Responses are parsed with the zod schemas from `./types`, not cast.
 *
 * No `server-only` and no drizzle: the browser imports this.
 */

import type { ZodType, ZodTypeDef } from 'zod'
import {
  proposalListResponseSchema,
  proposalResponseSchema,
  type ApplyProposalRequest,
  type ProposalListQuery,
  type ProposalListResponse,
  type ProposalResponse,
} from './types'

/** How a request is made: `fetch` in a browser, the real handler in a route spec. */
export type ProposalFetch = (path: string, init?: RequestInit) => Promise<Response>

const defaultFetch: ProposalFetch = (path, init) => fetch(path, init)

/** A request the API refused, with its status and the body's own code (409 `CONFLICT`: already decided). */
export class ProposalRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'ProposalRequestError'
  }
}

export const proposalPath = (id: string) => `/api/proposals/${encodeURIComponent(id)}`

async function request(
  run: ProposalFetch,
  path: string,
  method: 'GET' | 'POST',
  payload?: unknown
): Promise<ProposalResponse> {
  return requestAs(proposalResponseSchema, run, path, method, payload)
}

async function requestAs<T>(
  schema: ZodType<T, ZodTypeDef, unknown>,
  run: ProposalFetch,
  path: string,
  method: 'GET' | 'POST',
  payload?: unknown
): Promise<T> {
  const init: RequestInit =
    payload === undefined
      ? { method }
      : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }
  const response = await run(path, init)
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const error = (body ?? {}) as { error?: string; code?: string }
    throw new ProposalRequestError(
      response.status,
      error.code ?? 'UNKNOWN',
      error.error ?? `Request failed with ${response.status}`
    )
  }
  return schema.parse(body)
}

/** `/api/proposals` with the shelf (and the kind) as its query. */
export function proposalListPath(query: ProposalListQuery): string {
  const params = new URLSearchParams()
  if (query.projectId) params.set('projectId', query.projectId)
  else params.set('shelf', 'office_shelf')
  if (query.kind) params.set('kind', query.kind)
  if (query.limit) params.set('limit', String(query.limit))
  if (query.cursor) params.set('cursor', query.cursor)
  return `/api/proposals?${params.toString()}`
}

/**
 * The open proposals of a shelf this reader may read, each with the documents
 * it names resolved to ids (a project's with `projectId`, the Büroablage's with
 * `shelf: 'office_shelf'`).
 */
export function listOpenProposals(
  query: ProposalListQuery,
  run: ProposalFetch = defaultFetch
): Promise<ProposalListResponse> {
  return requestAs(proposalListResponseSchema, run, proposalListPath(query), 'GET')
}

/** The proposal as the reader may see it, with `canDecide`. */
export function getProposal(id: string, run: ProposalFetch = defaultFetch): Promise<ProposalResponse> {
  return request(run, proposalPath(id), 'GET')
}

/**
 * Apply it in the reader's session; the answer carries one result per item.
 * 409 unless it is `proposed`. `body.memoryScope: 'project'` files an
 * organization note in the project's memory instead. `applyProposal(id, run)`
 * still works: a function in second place is the fetch.
 */
export function applyProposal(id: string, run?: ProposalFetch): Promise<ProposalResponse>
export function applyProposal(id: string, body: ApplyProposalRequest, run?: ProposalFetch): Promise<ProposalResponse>
export function applyProposal(
  id: string,
  bodyOrRun?: ApplyProposalRequest | ProposalFetch,
  maybeRun?: ProposalFetch
): Promise<ProposalResponse> {
  const body = typeof bodyOrRun === 'function' ? undefined : bodyOrRun
  const run = (typeof bodyOrRun === 'function' ? bodyOrRun : maybeRun) ?? defaultFetch
  return request(run, `${proposalPath(id)}/apply`, 'POST', body)
}

/** Dismiss it. 409 unless it is `proposed`. */
export function dismissProposal(id: string, run: ProposalFetch = defaultFetch): Promise<ProposalResponse> {
  return request(run, `${proposalPath(id)}/dismiss`, 'POST')
}
