/**
 * The typed client for proposed changes (ADR-0055, ADR-0105): the person
 * routes under `/api/proposals/[id]`.
 *
 * The paths, the verbs and the response shapes are written once, here; the
 * file-operation card and the route specs both go through it, so a second
 * consumer cannot disagree with the first about what `…/apply` returns.
 * Responses are parsed with the zod schemas from `./types`, not cast.
 *
 * No `server-only` and no drizzle: the browser imports this.
 */

import { proposalResponseSchema, type ProposalResponse } from './types'

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

async function request(run: ProposalFetch, path: string, method: 'GET' | 'POST'): Promise<ProposalResponse> {
  const response = await run(path, { method })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const error = (body ?? {}) as { error?: string; code?: string }
    throw new ProposalRequestError(
      response.status,
      error.code ?? 'UNKNOWN',
      error.error ?? `Request failed with ${response.status}`
    )
  }
  return proposalResponseSchema.parse(body)
}

/** The proposal as the reader may see it, with `canDecide`. */
export function getProposal(id: string, run: ProposalFetch = defaultFetch): Promise<ProposalResponse> {
  return request(run, proposalPath(id), 'GET')
}

/** Apply it in the reader's session; the answer carries one result per item. 409 unless it is `proposed`. */
export function applyProposal(id: string, run: ProposalFetch = defaultFetch): Promise<ProposalResponse> {
  return request(run, `${proposalPath(id)}/apply`, 'POST')
}

/** Dismiss it. 409 unless it is `proposed`. */
export function dismissProposal(id: string, run: ProposalFetch = defaultFetch): Promise<ProposalResponse> {
  return request(run, `${proposalPath(id)}/dismiss`, 'POST')
}
