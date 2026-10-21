/**
 * The typed client for sorting a shelf's root (ADR-0055): the scan, the
 * per-chunk plan and the bulk move. Paths, verbs and response shapes are
 * written once, here, and parsed with the schemas of `./root-sort-types`.
 *
 * `planRootSort` and `applyFolderMoves` drive a whole run from the browser:
 * they split it into bounded requests, keep a few in flight, and report
 * progress, so a thousand files are many short requests rather than one long
 * one. A chunk that fails is reported and the run goes on.
 *
 * No `server-only`: the browser imports this.
 */

import type { ZodType, ZodTypeDef } from 'zod'
import {
  folderMovesResponseSchema,
  MAX_FOLDER_MOVES,
  ROOT_SORT_CHUNK,
  ensuredFoldersSchema,
  newFoldersSchema,
  rootSortPlanSchema,
  rootSortScanSchema,
  type FolderMove,
  type FolderMovesResponse,
  type NewFolders,
  type RootSortPlacement,
  type RootSortPlan,
  type RootSortScan,
  type RootSortShelf,
} from './root-sort-types'

/** How a request is made: `fetch` in a browser, the real handler in a route spec. */
export type RootSortFetch = (path: string, init?: RequestInit) => Promise<Response>

const defaultFetch: RootSortFetch = (path, init) => fetch(path, init)

/** Plan requests in flight at once: each is one model call of up to a minute. */
const PLAN_CONCURRENCY = 3
/** Move requests in flight at once. */
const MOVE_CONCURRENCY = 2

export class RootSortRequestError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'RootSortRequestError'
  }
}

export function rootSortPath(shelf: RootSortShelf): string {
  return shelf.kind === 'project'
    ? `/api/projects/${encodeURIComponent(shelf.projectId)}/root-sort`
    : '/api/office-shelf/root-sort'
}

function ensureFoldersPath(shelf: RootSortShelf): string {
  return shelf.kind === 'project'
    ? `/api/projects/${encodeURIComponent(shelf.projectId)}/folders/ensure`
    : '/api/office-shelf/folders/ensure'
}

export const FOLDER_MOVES_PATH = '/api/documents/folder-moves'

async function requestAs<T>(
  schema: ZodType<T, ZodTypeDef, unknown>,
  run: RootSortFetch,
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
    const error = (body ?? {}) as { error?: string }
    throw new RootSortRequestError(response.status, error.error ?? `Request failed with ${response.status}`)
  }
  return schema.parse(body)
}

export function fetchRootSortScan(shelf: RootSortShelf, run: RootSortFetch = defaultFetch): Promise<RootSortScan> {
  return requestAs(rootSortScanSchema, run, rootSortPath(shelf), 'GET')
}

export function planRootSortChunk(
  shelf: RootSortShelf,
  documentIds: readonly string[],
  run: RootSortFetch = defaultFetch
): Promise<RootSortPlan> {
  return requestAs(rootSortPlanSchema, run, rootSortPath(shelf), 'POST', { documentIds })
}

/** Propose new folders for the documents no folder fits. Never throws: a failure is `error` and no proposals. */
export function proposeNewFolders(
  shelf: RootSortShelf,
  documentIds: readonly string[],
  run: RootSortFetch = defaultFetch
): Promise<NewFolders> {
  return requestAs(newFoldersSchema, run, `${rootSortPath(shelf)}/new-folders`, 'POST', { documentIds }).catch(
    (error: unknown): NewFolders => ({
      proposals: [],
      error: error instanceof Error ? error.message : 'request_failed',
      traceId: null,
    })
  )
}

/** Get or create every path at the shelf root; answers each path's folder id. */
export async function ensureFolders(
  shelf: RootSortShelf,
  paths: readonly string[],
  run: RootSortFetch = defaultFetch
): Promise<Record<string, string>> {
  if (paths.length === 0) return {}
  const ensured = await requestAs(ensuredFoldersSchema, run, ensureFoldersPath(shelf), 'POST', {
    parentId: null,
    paths,
  })
  return ensured.folderIdByPath
}

export function moveDocuments(moves: readonly FolderMove[], run: RootSortFetch = defaultFetch): Promise<FolderMovesResponse> {
  return requestAs(folderMovesResponseSchema, run, FOLDER_MOVES_PATH, 'POST', { moves })
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let start = 0; start < items.length; start += size) chunks.push(items.slice(start, start + size))
  return chunks
}

/** Run `work` over every item with at most `limit` in flight; results keep the input order. */
async function pooled<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await work(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

export interface RootSortRunProgress {
  done: number
  total: number
}

export interface RootSortRun {
  placements: RootSortPlacement[]
  /** Documents whose chunk could not be judged; they stay where they are. */
  failedDocumentIds: string[]
  /** The first chunk error, for the notice. */
  error: string | null
}

/** Judge every document, a chunk at a time. Never throws for a chunk: its documents are reported as failed. */
export async function planRootSort(
  shelf: RootSortShelf,
  documentIds: readonly string[],
  onProgress: (progress: RootSortRunProgress) => void,
  run: RootSortFetch = defaultFetch
): Promise<RootSortRun> {
  const chunks = chunk(documentIds, ROOT_SORT_CHUNK)
  let done = 0
  onProgress({ done, total: documentIds.length })
  const plans = await pooled(chunks, PLAN_CONCURRENCY, async (ids) => {
    const plan = await planRootSortChunk(shelf, ids, run).catch(
      (error: unknown): RootSortPlan => ({
        placements: [],
        error: error instanceof Error ? error.message : 'request_failed',
        traceId: null,
      })
    )
    done += ids.length
    onProgress({ done, total: documentIds.length })
    return { ids, plan }
  })
  return {
    placements: plans.flatMap(({ plan }) => plan.placements),
    failedDocumentIds: plans.flatMap(({ ids, plan }) => (plan.error ? ids : [])),
    error: plans.find(({ plan }) => plan.error)?.plan.error ?? null,
  }
}

export interface FolderMovesRun {
  moved: string[]
  failed: Array<{ documentId: string; error: string }>
}

/** Apply every move, a request at a time. Never throws for a request: its moves are reported as failed. */
export async function applyFolderMoves(
  moves: readonly FolderMove[],
  onProgress: (progress: RootSortRunProgress) => void,
  run: RootSortFetch = defaultFetch
): Promise<FolderMovesRun> {
  let done = 0
  onProgress({ done, total: moves.length })
  const responses = await pooled(chunk(moves, MAX_FOLDER_MOVES), MOVE_CONCURRENCY, async (batch) => {
    const response = await moveDocuments(batch, run).catch(
      (error: unknown): FolderMovesResponse => ({
        results: batch.map((move) => ({
          documentId: move.documentId,
          ok: false,
          error: error instanceof Error ? error.message : 'request_failed',
        })),
      })
    )
    done += batch.length
    onProgress({ done, total: moves.length })
    return response
  })
  const results = responses.flatMap((response) => response.results)
  return {
    moved: results.filter((result) => result.ok).map((result) => result.documentId),
    failed: results.flatMap((result) =>
      result.ok ? [] : [{ documentId: result.documentId, error: result.error ?? 'move_failed' }]
    ),
  }
}
