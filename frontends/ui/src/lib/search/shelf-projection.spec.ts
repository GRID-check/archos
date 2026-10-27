/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const repository = vi.hoisted(() => ({
  claimShelfRefresh: vi.fn(),
  listShelfDocumentsForProjection: vi.fn(),
  markShelfSynced: vi.fn(),
  readShelfSyncStates: vi.fn(),
  shelfSourceFingerprints: vi.fn(),
}))
vi.mock('./facets-repository', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./facets-repository')>()),
  ...repository,
}))
vi.mock('@/lib/documents/reconcile-status', () => ({ readCollectionReadings: vi.fn() }))
vi.mock('./facets-projector', () => ({ projectReadings: vi.fn().mockResolvedValue(1) }))
vi.mock('@/lib/jobs-queue/enqueue', () => ({ enqueueJob: vi.fn().mockResolvedValue({ jobId: 'j' }) }))

import { readCollectionReadings } from '@/lib/documents/reconcile-status'
import { enqueueJob } from '@/lib/jobs-queue/enqueue'
import { projectReadings } from './facets-projector'
import { PROJECTION_PAGE_SIZE } from './facets-repository'
import { isStale, refreshStaleShelves, runSearchFacetsSyncSlice, SHELF_SYNC_MAX_AGE_MS } from './shelf-projection'

const PROJECT = '11111111-1111-4111-8111-111111111111'
const doc = (n: number) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  filename: `plan-${n}.pdf`,
  collectionName: 'proj_a',
  authoredBy: 'user' as const,
  publishedVersionId: null,
})
const payload = { shelfKey: `project:${PROJECT}`, afterId: null, sourceFingerprint: '3@x', written: 0 }

beforeEach(() => vi.clearAllMocks())

describe('runSearchFacetsSyncSlice', () => {
  it('writes the rows the listing knows and marks the shelf synced on its last page', async () => {
    repository.listShelfDocumentsForProjection.mockResolvedValue([doc(1), doc(2)])
    vi.mocked(readCollectionReadings).mockResolvedValue(
      new Map([['plan-1.pdf', { metadata: { summary: 's' }, superseded: false }]])
    )

    const result = await runSearchFacetsSyncSlice('org-1', payload)

    expect(projectReadings).toHaveBeenCalledWith('org-1', [
      { documentId: doc(1).id, metadata: { summary: 's' }, superseded: false },
    ])
    expect(repository.markShelfSynced).toHaveBeenCalledWith('org-1', { kind: 'project', projectId: PROJECT }, '3@x')
    expect(result).toEqual({ done: true, payload: { ...payload, written: 1 } })
  })

  it('continues after the last id of a full page and does not mark the shelf yet', async () => {
    const page = Array.from({ length: PROJECTION_PAGE_SIZE }, (_, i) => doc(i + 1))
    repository.listShelfDocumentsForProjection.mockResolvedValue(page)
    vi.mocked(readCollectionReadings).mockResolvedValue(new Map())

    const result = await runSearchFacetsSyncSlice('org-1', payload)

    expect(result.done).toBe(false)
    expect(result.payload.afterId).toBe(page.at(-1)?.id)
    expect(repository.markShelfSynced).not.toHaveBeenCalled()
  })

  it('throws on an unreadable listing, so the queue retries instead of recording nothing as the truth', async () => {
    repository.listShelfDocumentsForProjection.mockResolvedValue([doc(1)])
    vi.mocked(readCollectionReadings).mockResolvedValue(null)

    await expect(runSearchFacetsSyncSlice('org-1', payload)).rejects.toThrow('unreadable')
    expect(repository.markShelfSynced).not.toHaveBeenCalled()
  })
})

describe('refreshStaleShelves', () => {
  const now = new Date('2026-10-27T10:00:00Z')

  it('queues one refresh for a stale shelf it claims, and names the shelves never synced', async () => {
    repository.shelfSourceFingerprints.mockResolvedValue(new Map([[`project:${PROJECT}`, '3@x'], ['office_shelf', '1@y']]))
    repository.readShelfSyncStates.mockResolvedValue([
      { shelfKey: 'office_shelf', syncedAt: now, sourceFingerprint: '1@y' },
    ])
    repository.claimShelfRefresh.mockResolvedValue(true)

    const freshness = await refreshStaleShelves(
      'org-1',
      [{ kind: 'project', projectId: PROJECT }, { kind: 'office_shelf' }],
      now
    )

    expect(freshness.building).toEqual([`project:${PROJECT}`])
    expect(enqueueJob).toHaveBeenCalledTimes(1)
    expect(vi.mocked(enqueueJob).mock.calls[0][0]).toMatchObject({
      kind: 'search_facets_sync',
      payload: { shelfKey: `project:${PROJECT}`, afterId: null, sourceFingerprint: '3@x' },
    })
  })

  it('queues nothing when another search already claimed the refresh', async () => {
    repository.shelfSourceFingerprints.mockResolvedValue(new Map([['office_shelf', '1@y']]))
    repository.readShelfSyncStates.mockResolvedValue([])
    repository.claimShelfRefresh.mockResolvedValue(false)

    await refreshStaleShelves('org-1', [{ kind: 'office_shelf' }], now)

    expect(enqueueJob).not.toHaveBeenCalled()
  })

  it('answers without a refresh when the check itself fails', async () => {
    repository.shelfSourceFingerprints.mockRejectedValue(new Error('db down'))
    await expect(refreshStaleShelves('org-1', [{ kind: 'office_shelf' }], now)).resolves.toEqual({ building: [] })
  })
})

describe('isStale', () => {
  const now = new Date('2026-10-27T10:00:00Z')
  it('is stale when never synced, when the fingerprint moved, or when the sync is old', () => {
    expect(isStale(undefined, 'a', now)).toBe(true)
    expect(isStale({ syncedAt: now, sourceFingerprint: 'b' }, 'a', now)).toBe(true)
    expect(isStale({ syncedAt: new Date(now.getTime() - SHELF_SYNC_MAX_AGE_MS - 1), sourceFingerprint: 'a' }, 'a', now)).toBe(true)
    expect(isStale({ syncedAt: now, sourceFingerprint: 'a' }, 'a', now)).toBe(false)
  })
})
