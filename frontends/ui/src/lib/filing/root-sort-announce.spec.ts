/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RootSortRun } from '@/lib/db/schema'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/db/tenant-context', () => ({
  getTenantContext: vi.fn(() => undefined),
  withTenant: vi.fn(async (_scope: unknown, fn: () => unknown) => await fn()),
}))
vi.mock('@/lib/inbox/repository', () => ({ recipientsHoldingGroup: vi.fn() }))
vi.mock('@/lib/inbox/service', () => ({ emitInboxItems: vi.fn() }))
vi.mock('@/lib/projects/repository', () => ({ findProjectInOrg: vi.fn() }))

import { recipientsHoldingGroup } from '@/lib/inbox/repository'
import { emitInboxItems } from '@/lib/inbox/service'
import { findProjectInOrg } from '@/lib/projects/repository'
import { announceRootSortRun } from './root-sort-announce'

const placement = (documentId: string, folderId: string | null, newFolderPath: string | null = null) => ({
  documentId,
  folderId,
  newFolderPath,
  reason: 'Passt.',
  confidence: 0.9,
})

const run = (overrides: Partial<RootSortRun> = {}): RootSortRun =>
  ({
    id: 'run-1',
    organizationId: 'org-1',
    scope: 'project',
    projectId: 'p1',
    requestedBy: 'user-1',
    status: 'ready',
    documentIds: ['d1', 'd2', 'd3'],
    placements: [placement('d1', 'f-plans'), placement('d2', null, 'Verträge'), placement('d3', null)],
    failedDocumentIds: [],
    newFolders: [],
    ...overrides,
  }) as RootSortRun

describe('announceRootSortRun', () => {
  beforeEach(() => {
    vi.mocked(emitInboxItems).mockReset().mockResolvedValue(1)
    vi.mocked(recipientsHoldingGroup).mockReset().mockResolvedValue(new Set())
    vi.mocked(findProjectInOrg).mockReset().mockResolvedValue({ name: 'Wohnhaus Nord' } as never)
  })

  it('tells the requester once that a project sort is ready, counting the files it proposes to move', async () => {
    await announceRootSortRun(run())

    expect(emitInboxItems).toHaveBeenCalledOnce()
    const [emissions] = vi.mocked(emitInboxItems).mock.calls[0]
    expect(emissions).toEqual([
      {
        organizationId: 'org-1',
        recipientUserId: 'user-1',
        type: 'root_sort.ready',
        resourceType: 'project',
        resourceId: 'p1',
        anchorId: 'run-1',
        actorUserId: null,
        groupKey: 'root_sort.ready:project:p1:run-1',
        occurrences: 2,
        payload: { subject: 'Wohnhaus Nord' },
      },
    ])
  })

  it('tells the requester that a run stopped, as one row of its own', async () => {
    await announceRootSortRun(run({ status: 'failed' }))

    expect(emitInboxItems).toHaveBeenCalledOnce()
    expect(vi.mocked(emitInboxItems).mock.calls[0][0]).toEqual([
      expect.objectContaining({
        type: 'root_sort.failed',
        recipientUserId: 'user-1',
        groupKey: 'root_sort.failed:project:p1:run-1',
        occurrences: 1,
      }),
    ])
  })

  it('names no place for the office filing, and points its row at the organization', async () => {
    await announceRootSortRun(run({ scope: 'office_shelf', projectId: null }))

    expect(findProjectInOrg).not.toHaveBeenCalled()
    expect(vi.mocked(emitInboxItems).mock.calls[0][0]).toEqual([
      expect.objectContaining({
        type: 'root_sort.ready',
        resourceType: 'organization',
        resourceId: 'org-1',
        groupKey: 'root_sort.ready:organization:org-1:run-1',
        payload: { variant: 'office' },
      }),
    ])
  })

  it('does not tell the requester again when they already hold the row for this run and kind', async () => {
    vi.mocked(recipientsHoldingGroup).mockResolvedValueOnce(new Set(['user-1']))
    await announceRootSortRun(run())

    expect(recipientsHoldingGroup).toHaveBeenCalledWith('org-1', 'root_sort.ready:project:p1:run-1', ['user-1'])
    expect(emitInboxItems).not.toHaveBeenCalled()
  })

  it('says nothing about a run that is not ready or failed', async () => {
    await announceRootSortRun(run({ status: 'applied' }))
    await announceRootSortRun(run({ status: 'judging' }))

    expect(emitInboxItems).not.toHaveBeenCalled()
    expect(recipientsHoldingGroup).not.toHaveBeenCalled()
  })

  it('says nothing about a ready run that proposes no move', async () => {
    await announceRootSortRun(run({ placements: [placement('d1', null)] }))

    expect(emitInboxItems).not.toHaveBeenCalled()
  })

  it('says nothing when the project is gone', async () => {
    vi.mocked(findProjectInOrg).mockResolvedValueOnce(null)
    await announceRootSortRun(run())

    expect(emitInboxItems).not.toHaveBeenCalled()
  })

  it('logs and resolves when the inbox write fails: it never fails the job that called it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.mocked(emitInboxItems).mockRejectedValueOnce(new Error('database refused'))

    await expect(announceRootSortRun(run())).resolves.toBeUndefined()
    expect(error).toHaveBeenCalledWith(expect.stringContaining('root_sort.ready for run run-1'), expect.any(Error))
    error.mockRestore()
  })

  it('resolves when reading the project fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.mocked(findProjectInOrg).mockRejectedValueOnce(new Error('connection reset'))

    await expect(announceRootSortRun(run({ status: 'failed' }))).resolves.toBeUndefined()
    expect(emitInboxItems).not.toHaveBeenCalled()
    error.mockRestore()
  })
})
