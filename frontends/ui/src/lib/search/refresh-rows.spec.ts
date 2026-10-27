/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/documents/reconcile-status', () => ({ readCollectionReadings: vi.fn() }))
vi.mock('./facets-projector', () => ({ projectReadings: vi.fn().mockResolvedValue(1) }))
vi.mock('./facets-repository', () => ({ markShelvesStale: vi.fn().mockResolvedValue(undefined) }))

import { readCollectionReadings } from '@/lib/documents/reconcile-status'
import { projectReadings } from './facets-projector'
import { markShelvesStale } from './facets-repository'
import { projectDocuments, refreshSearchRows } from './refresh-rows'

const PROJECT = '11111111-1111-4111-8111-111111111111'
const doc = (id: string, overrides: Partial<{ collectionName: string; authoredBy: 'user' | 'agent'; projectId: string | null; scope: string }> = {}) => ({
  id,
  filename: `${id}.pdf`,
  collectionName: 'proj_a',
  authoredBy: 'user' as const,
  publishedVersionId: null,
  projectId: PROJECT,
  scope: 'project',
  ...overrides,
})

beforeEach(() => vi.clearAllMocks())

describe('projectDocuments', () => {
  it('reads each collection once and writes the rows its listing knows, superseded as the listing says', async () => {
    vi.mocked(readCollectionReadings).mockImplementation(async (collectionName) =>
      collectionName === 'proj_a'
        ? new Map([['older.pdf', { metadata: { summary: 's' }, superseded: true }]])
        : new Map([['other.pdf', { metadata: { tags: ['Gutachten'] }, superseded: false }]])
    )

    await projectDocuments('org-1', [doc('older'), doc('newer'), doc('other', { collectionName: 'proj_b' })])

    expect(readCollectionReadings).toHaveBeenCalledTimes(2)
    expect(projectReadings).toHaveBeenCalledWith('org-1', [
      { documentId: 'older', metadata: { summary: 's' }, superseded: true },
      { documentId: 'other', metadata: { tags: ['Gutachten'] }, superseded: false },
    ])
  })

  it('never asks the listing about a row a machine wrote', async () => {
    await projectDocuments('org-1', [doc('report', { authoredBy: 'agent' })])

    expect(readCollectionReadings).not.toHaveBeenCalled()
    expect(projectReadings).toHaveBeenCalledWith('org-1', [])
  })

  it('throws when a listing is unreadable, so nothing is written as if nothing were known', async () => {
    vi.mocked(readCollectionReadings).mockResolvedValue(null)

    await expect(projectDocuments('org-1', [doc('a')])).rejects.toThrow(/unreadable/)
    expect(projectReadings).not.toHaveBeenCalled()
  })
})

describe('refreshSearchRows', () => {
  it('writes the rows of the edited documents', async () => {
    vi.mocked(readCollectionReadings).mockResolvedValue(new Map([['a.pdf', { metadata: { summary: 's' }, superseded: false }]]))

    await refreshSearchRows('org-1', [doc('a')])

    expect(projectReadings).toHaveBeenCalledWith('org-1', [{ documentId: 'a', metadata: { summary: 's' }, superseded: false }])
    expect(markShelvesStale).not.toHaveBeenCalled()
  })

  it('does nothing for no documents', async () => {
    await refreshSearchRows('org-1', [])

    expect(readCollectionReadings).not.toHaveBeenCalled()
  })

  it('never fails the edit: a listing that could not be read marks the shelves stale for the next search', async () => {
    vi.mocked(readCollectionReadings).mockResolvedValue(null)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(
      refreshSearchRows('org-1', [doc('a'), doc('b'), doc('c', { projectId: null, scope: 'office_shelf' })])
    ).resolves.toBeUndefined()

    expect(markShelvesStale).toHaveBeenCalledWith('org-1', [{ kind: 'project', projectId: PROJECT }, { kind: 'office_shelf' }])
    warn.mockRestore()
  })

  it('never fails the edit even when marking the shelves stale fails too', async () => {
    vi.mocked(projectReadings).mockRejectedValueOnce(new Error('db down'))
    vi.mocked(readCollectionReadings).mockResolvedValue(new Map())
    vi.mocked(markShelvesStale).mockRejectedValueOnce(new Error('db down'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(refreshSearchRows('org-1', [doc('a')])).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })
})
