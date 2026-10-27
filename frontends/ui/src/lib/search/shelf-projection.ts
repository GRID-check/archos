/**
 * The backstop that keeps a shelf's search rows current (ADR-0136).
 *
 * A row is written when its document settles (`reconcileDocumentStatuses`)
 * and when a person changes what it derives (`./refresh-rows.ts`). What both
 * miss (a write the agent makes on its own side, a refresh that failed, rows
 * from before the projection existed) a refresh of the whole shelf catches: a
 * search finds the shelf's fingerprint moved since its last sync, or the sync
 * older than {@link SHELF_SYNC_MAX_AGE_MS}, or the shelf marked stale by a
 * refresh that failed, and queues one `search_facets_sync` job, at most one per shelf per
 * {@link SHELF_REFRESH_MIN_INTERVAL_MS}, the way the office's conventions are
 * refreshed (`lib/office-conventions/service.ts`).
 *
 * The job runs as the system: it decides nothing about who reads what, and the
 * search joins every row it wrote under the reader's predicate.
 */

import 'server-only'
import type { DocumentShelf } from '@/lib/documents/shelf'
import { enqueueJob } from '@/lib/jobs-queue/enqueue'
import { BFF_JOB_PRIORITY, type JobSliceResult, type SearchFacetsSyncPayload } from '@/lib/jobs-queue/types'
import {
  claimShelfRefresh,
  listShelfDocumentsForProjection,
  markShelfSynced,
  PROJECTION_PAGE_SIZE,
  readShelfSyncStates,
  shelfKey,
  shelfOfKey,
  shelfSourceFingerprints,
} from './facets-repository'
import { projectDocuments } from './refresh-rows'

/** At most one refresh of a shelf is queued in this interval. */
export const SHELF_REFRESH_MIN_INTERVAL_MS = 10 * 60 * 1000

/** A sync older than this is refreshed even when the fingerprint did not move (agent-side edits). */
export const SHELF_SYNC_MAX_AGE_MS = 60 * 60 * 1000

/** Shelves one search may queue a refresh for, so a first search in a large office stays a bounded request. */
export const MAX_REFRESHES_PER_SEARCH = 20

/** One slice: a page of the shelf's documents, by id, read against their collections' listings. */
export async function runSearchFacetsSyncSlice(
  organizationId: string,
  payload: SearchFacetsSyncPayload
): Promise<JobSliceResult<SearchFacetsSyncPayload>> {
  const shelf = shelfOfKey(payload.shelfKey)
  if (!shelf) return { done: true, payload }
  const page = await listShelfDocumentsForProjection(organizationId, shelf, payload.afterId)
  // An unreadable listing throws, and the queue retries rather than reads it as "nothing known".
  const written = await projectDocuments(organizationId, page)
  const next = { ...payload, written: payload.written + written }
  if (page.length < PROJECTION_PAGE_SIZE) {
    await markShelfSynced(organizationId, shelf, payload.sourceFingerprint)
    return { done: true, payload: next }
  }
  return { done: false, payload: { ...next, afterId: page[page.length - 1].id } }
}

/** What a search learns about its shelves' projection. */
export interface ShelfFreshness {
  /** Shelves never synced: their documents are found by name, status and content, not yet by their facts. */
  building: string[]
}

/**
 * Queue a refresh of every shelf in `shelves` whose projection is stale, and
 * say which were never synced. Never throws: a search answers without it.
 */
export async function refreshStaleShelves(
  organizationId: string,
  shelves: readonly DocumentShelf[],
  now: Date = new Date()
): Promise<ShelfFreshness> {
  try {
    const [fingerprints, states] = await Promise.all([
      shelfSourceFingerprints(organizationId, shelves),
      readShelfSyncStates(organizationId, shelves.map(shelfKey)),
    ])
    const stateOf = new Map(states.map((state) => [state.shelfKey, state]))
    const building: string[] = []
    let queued = 0
    for (const shelf of shelves) {
      const key = shelfKey(shelf)
      const state = stateOf.get(key)
      const fingerprint = fingerprints.get(key) ?? '0'
      if (!state?.syncedAt) building.push(key)
      if (!isStale(state, fingerprint, now) || queued >= MAX_REFRESHES_PER_SEARCH) continue
      if (!(await claimShelfRefresh(organizationId, shelf, SHELF_REFRESH_MIN_INTERVAL_MS))) continue
      queued += 1
      await enqueueJob({
        kind: 'search_facets_sync',
        organizationId,
        payload: { shelfKey: key, afterId: null, sourceFingerprint: fingerprint, written: 0 } satisfies SearchFacetsSyncPayload,
        priority: BFF_JOB_PRIORITY.bulk,
      })
    }
    return { building }
  } catch (error) {
    console.warn('[search] could not check the projection of the shelves', error)
    return { building: [] }
  }
}

/** Whether a shelf's projection needs a refresh. Pure. */
export function isStale(
  state: { syncedAt: Date | null; sourceFingerprint: string | null } | undefined,
  fingerprint: string,
  now: Date
): boolean {
  if (!state?.syncedAt) return true
  if (state.sourceFingerprint !== fingerprint) return true
  return now.getTime() - new Date(state.syncedAt).getTime() > SHELF_SYNC_MAX_AGE_MS
}
