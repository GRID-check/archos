/**
 * @vitest-environment node
 */
/**
 * `project_intake_read` (ADR-0111): the job runs AS the uploader, resolved
 * from the identity provider when it runs, not from the payload's snapshot;
 * an uploader who left ends it quietly, and what the reading does is the
 * intake service's (`runIntakeReadSlice`).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/auth/pinned-session', () => ({ resolvePinnedRequesterSession: vi.fn() }))
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
vi.mock('@/lib/annotations/wake-job', () => ({ runAgentWake: vi.fn() }))
vi.mock('@/lib/annotations/wake-stop-job', () => ({ runAgentWakeStop: vi.fn() }))
vi.mock('@/lib/project-intake/service', () => ({
  runIntakeReadSlice: vi.fn(async (_session: unknown, payload: unknown) => ({ done: true, payload })),
}))

import { resolvePinnedRequesterSession } from '@/lib/auth/pinned-session'
import type { AuthorizedSession } from '@/lib/auth/types'
import { runIntakeReadSlice } from '@/lib/project-intake/service'
import { JOB_HANDLERS } from './handlers'

const PROJECT = '6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f'
const payload = {
  projectId: PROJECT,
  requester: { userId: 'anna', email: 'anna@example.test', organizationMembershipId: 'om-1', role: 'admin', permissions: ['x'] },
}
const NOW_SESSION = { userId: 'anna', organizationId: 'org-1', role: 'member' } as Partial<AuthorizedSession> as AuthorizedSession

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(resolvePinnedRequesterSession).mockResolvedValue(NOW_SESSION)
})

describe('JOB_HANDLERS.project_intake_read', () => {
  it('starts the reading as the uploader’s session of today', async () => {
    expect(await JOB_HANDLERS.project_intake_read({ organizationId: 'org-1', payload, attempts: 1 })).toEqual({
      done: true,
      payload,
    })
    expect(resolvePinnedRequesterSession).toHaveBeenCalledWith({ userId: 'anna', email: 'anna@example.test', organizationId: 'org-1' })
    expect(runIntakeReadSlice).toHaveBeenCalledWith(NOW_SESSION, payload)
  })

  it('ends quietly for an uploader who left', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.mocked(resolvePinnedRequesterSession).mockResolvedValue(null)
    expect(await JOB_HANDLERS.project_intake_read({ organizationId: 'org-1', payload, attempts: 1 })).toMatchObject({ done: true })
    expect(runIntakeReadSlice).not.toHaveBeenCalled()
  })

  it('refuses a payload that does not parse, so the queue counts a failed attempt', async () => {
    await expect(
      JOB_HANDLERS.project_intake_read({ organizationId: 'org-1', payload: { projectId: 'nope' }, attempts: 1 })
    ).rejects.toThrow()
  })
})
