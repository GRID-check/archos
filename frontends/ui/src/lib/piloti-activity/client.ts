/**
 * The browser's typed client for „Was Piloti tut": `GET /api/projects/[id]/piloti-activity`
 * (ADR-0055). The path, the query and the response shape are written once,
 * here; the section, the Overview tile and the route spec all go through it.
 *
 * Parsed with `pilotiActivityResponseSchema`, never cast: a body this build
 * does not recognise is a zod error, which the caller treats like a failed
 * read (keep what is shown, say it could not be loaded).
 *
 * The actions a row offers are not here: they are the existing clients'
 * (`updateAnnotation` in `lib/annotations/client` to take a delegation back,
 * `cancelRun` in `lib/runs/run-view-client` to stop a run). Re-read this view
 * after either.
 *
 * No `server-only` and no drizzle: the browser imports this.
 */

import { z } from 'zod'
import {
  pilotiActivityResponseSchema,
  type PilotiActivityQueryInput,
  type PilotiActivityResponse,
} from './types'

/** How a request is made: `fetch` in a browser, the real handler in a route spec. */
export type PilotiActivityFetch = (path: string, init?: RequestInit) => Promise<Response>

const defaultFetch: PilotiActivityFetch = (path, init) => fetch(path, init)

/** A read the API refused, with its status and the API's own `code` when the body named one (404: no such project for you). */
export class PilotiActivityRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string | null = null
  ) {
    super(message)
    this.name = 'PilotiActivityRequestError'
  }
}

/** The API's error envelope (`errorResponse` in `lib/api/handler.ts`): `{ error, code }`. */
const apiRefusalSchema = z.object({ error: z.string().min(1), code: z.string().min(1) })

/** The route, with the query when it names anything. */
export function pilotiActivityPath(projectId: string, query: PilotiActivityQueryInput = {}): string {
  const params = new URLSearchParams()
  if (query.since) params.set('since', query.since)
  if (query.limit !== undefined) params.set('limit', String(query.limit))
  const search = params.toString()
  return `/api/projects/${encodeURIComponent(projectId)}/piloti-activity${search ? `?${search}` : ''}`
}

/**
 * What Piloti is doing in the project, as this reader may see it. Throws
 * `PilotiActivityRequestError` on a refused read and a zod error on a body
 * this build does not recognise.
 */
export async function fetchPilotiActivity(
  projectId: string,
  query: PilotiActivityQueryInput = {},
  run: PilotiActivityFetch = defaultFetch
): Promise<PilotiActivityResponse> {
  const response = await run(pilotiActivityPath(projectId, query), {
    method: 'GET',
    headers: { Accept: 'application/json' },
    credentials: 'same-origin',
  })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const refusal = apiRefusalSchema.safeParse(body)
    throw refusal.success
      ? new PilotiActivityRequestError(response.status, refusal.data.error, refusal.data.code)
      : new PilotiActivityRequestError(response.status, `Piloti activity request failed with ${response.status}`)
  }
  return pilotiActivityResponseSchema.parse(body)
}
