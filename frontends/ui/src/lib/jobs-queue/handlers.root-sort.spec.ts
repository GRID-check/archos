/**
 * @vitest-environment node
 */
/**
 * `root_sort` (ADR-0121): a slice runs as the person who started the run,
 * looked up strictly, so an identity provider that did not answer is retried
 * by the queue rather than read as "they left"; a requester who did leave ends
 * their run, so the shelf is not locked behind it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/auth/pinned-session', () => ({
  resolvePinnedRequesterSession: vi.fn(),
  resolvePinnedRequesterSessionStrict: vi.fn(),
}))
// The other kinds' work is out of scope; stubbed so the import graph stays out of the database.
vi.mock('@/lib/documents/extraction-jobs', () => ({
  runBimExtractJob: vi.fn(),
  runOfficeRenditionJob: vi.fn(),
}))
vi.mock('@/lib/documents/ingest-recovery', () => ({
  runReingestFailedSlice: vi.fn(),
}))
vi.mock('@/lib/documents/reindex', () => ({
  runReindexSlice: vi.fn(),
}))
vi.mock('@/lib/projects/folder-bin-jobs', () => ({ runPurgeBinnedChunksSlice: vi.fn(), runRestoreFolderSlice: vi.fn() }))
vi.mock('@/lib/projects/collection-placement', () => ({ runPlacementReingestSlice: vi.fn() }))
vi.mock('@/lib/mail-import/job', () => ({ runMailImportSlice: vi.fn() }))
vi.mock('@/lib/tasks/service', () => ({ runReportFilingJob: vi.fn() }))
vi.mock('@/lib/annotations/wake-job', () => ({ runPilotiWake: vi.fn() }))
vi.mock('@/lib/annotations/wake-stop-job', () => ({ runPilotiWakeStop: vi.fn() }))
vi.mock('@/lib/project-intake/service', () => ({ runIntakeReadSlice: vi.fn() }))
vi.mock('@/lib/filing/root-sort-run', () => ({
  endRunOfDepartedRequester: vi.fn(),
  runRootSortSlice: vi.fn(async (_session: unknown, payload: unknown) => ({ done: false, payload })),
}))

import { resolvePinnedRequesterSession, resolvePinnedRequesterSessionStrict } from '@/lib/auth/pinned-session'
import type { AuthorizedSession } from '@/lib/auth/types'
import { endRunOfDepartedRequester, runRootSortSlice } from '@/lib/filing/root-sort-run'
import { JOB_HANDLERS } from './handlers'

const RUN = '6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f'
const payload = {
  runId: RUN,
  requester: { userId: 'anna', email: 'anna@grid.test', organizationMembershipId: 'om-1', role: 'member', permissions: [] },
}
const SESSION = { userId: 'anna', organizationId: 'org-1' } as Partial<AuthorizedSession> as AuthorizedSession

beforeEach(() => vi.clearAllMocks())

describe('JOB_HANDLERS.root_sort', () => {
  it('runs the slice as the requester, looked up strictly', async () => {
    vi.mocked(resolvePinnedRequesterSessionStrict).mockResolvedValue(SESSION)
    expect(await JOB_HANDLERS.root_sort({ organizationId: 'org-1', payload, attempts: 1 })).toEqual({ done: false, payload })
    expect(resolvePinnedRequesterSessionStrict).toHaveBeenCalledWith({ userId: 'anna', email: 'anna@grid.test', organizationId: 'org-1' })
    expect(resolvePinnedRequesterSession).not.toHaveBeenCalled()
    expect(runRootSortSlice).toHaveBeenCalledWith(SESSION, payload)
  })

  it('lets a lookup the identity provider did not answer fail the slice, for the queue to retry', async () => {
    vi.mocked(resolvePinnedRequesterSessionStrict).mockRejectedValue(new Error('WorkOS 503'))
    await expect(JOB_HANDLERS.root_sort({ organizationId: 'org-1', payload, attempts: 1 })).rejects.toThrow('WorkOS 503')
    expect(endRunOfDepartedRequester).not.toHaveBeenCalled()
  })

  it('ends the run of a requester who left, so the shelf is not locked behind it', async () => {
    vi.mocked(resolvePinnedRequesterSessionStrict).mockResolvedValue(null)
    expect(await JOB_HANDLERS.root_sort({ organizationId: 'org-1', payload, attempts: 1 })).toEqual({ done: true, payload })
    expect(endRunOfDepartedRequester).toHaveBeenCalledWith('org-1', RUN)
    expect(runRootSortSlice).not.toHaveBeenCalled()
  })
})
