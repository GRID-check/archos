/**
 * The typed client for a project's intake (ADR-0055, ADR-0111): the person
 * routes under `/api/projects/[id]/intake`.
 *
 * The paths, the verbs and the response shapes are written once, here; the
 * setup page and the route specs both go through it, so a second consumer
 * cannot disagree with the first about what a route returns. Responses are
 * parsed with the zod schemas from `./types`, not cast.
 *
 * No `server-only` and no drizzle: the browser imports this.
 */

import {
  intakeDecisionsResponseSchema,
  intakeResponseSchema,
  type IntakeDecision,
  type IntakeDecisionResult,
  type IntakeView,
  type StartIntakeRequest,
} from './types'

/** How a request is made: `fetch` in a browser, the real handler in a route spec. */
export type ProjectIntakeFetch = (path: string, init?: RequestInit) => Promise<Response>

const defaultFetch: ProjectIntakeFetch = (path, init) => fetch(path, init)

/**
 * A request the API refused: its status, the body's code (`CONFLICT`,
 * `NOT_FOUND` …) and, where the API names one, the reason (`project-closed`,
 * `intake-completed`, `submit-failed`).
 */
export class ProjectIntakeRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly reason: string | null = null
  ) {
    super(message)
    this.name = 'ProjectIntakeRequestError'
  }
}

export const projectIntakePath = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/intake`

export interface ProjectIntakeClient {
  /** The review, with `canDecide` and `canComplete` for the reader. */
  get(projectId: string): Promise<IntakeView>
  /** Start a reading now; `all` forgets what was read. While one runs, the next is queued behind it. */
  start(projectId: string, body: StartIntakeRequest): Promise<IntakeView>
  /** Apply 1..60 decisions; one result per decision, in order, and the review after them. */
  decide(projectId: string, decisions: IntakeDecision[]): Promise<{ results: IntakeDecisionResult[]; intake: IntakeView }>
  /** Finish the review; a closing intent closes the project with it. */
  complete(projectId: string): Promise<IntakeView>
}

async function send(run: ProjectIntakeFetch, path: string, method: 'GET' | 'POST', payload?: unknown): Promise<unknown> {
  const init: RequestInit =
    payload === undefined
      ? { method }
      : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }
  const response = await run(path, init)
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const error = (body ?? {}) as { error?: string; code?: string; details?: { reason?: unknown } }
    const reason = typeof error.details?.reason === 'string' ? error.details.reason : null
    throw new ProjectIntakeRequestError(
      response.status,
      error.code ?? 'UNKNOWN',
      error.error ?? `Request failed with ${response.status}`,
      reason
    )
  }
  return body
}

export function createProjectIntakeClient(fetchImpl: ProjectIntakeFetch = defaultFetch): ProjectIntakeClient {
  const view = async (path: string, method: 'GET' | 'POST', payload?: unknown) =>
    intakeResponseSchema.parse(await send(fetchImpl, path, method, payload)).intake
  return {
    get: (projectId) => view(projectIntakePath(projectId), 'GET'),
    start: (projectId, body) => view(projectIntakePath(projectId), 'POST', body),
    decide: async (projectId, decisions) =>
      intakeDecisionsResponseSchema.parse(
        await send(fetchImpl, `${projectIntakePath(projectId)}/decisions`, 'POST', { decisions })
      ),
    complete: (projectId) => view(`${projectIntakePath(projectId)}/complete`, 'POST'),
  }
}
