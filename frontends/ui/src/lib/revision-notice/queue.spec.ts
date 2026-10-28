/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/workos/feature-flags', () => ({ isOrgFeatureEnabled: vi.fn() }))
vi.mock('@/lib/jobs-queue/repository', () => ({ insertJobIfAbsent: vi.fn() }))
vi.mock('@/lib/db/tenant-context', () => ({ withTenant: (_scope: unknown, fn: () => unknown) => fn() }))

import { insertJobIfAbsent } from '@/lib/jobs-queue/repository'
import { BFF_JOB_PRIORITY } from '@/lib/jobs-queue/types'
import { isOrgFeatureEnabled } from '@/lib/workos/feature-flags'
import { revisionNoticeId } from './notice'
import { queueRevisionNotice } from './queue'

const request = { organizationId: 'org-1', actorUserId: 'editor', newerId: 'doc-b', olderId: 'doc-a' }
const NOW = new Date('2026-10-21T10:00:00Z')

beforeEach(() => {
  vi.resetAllMocks()
  vi.unstubAllEnvs()
  vi.mocked(isOrgFeatureEnabled).mockResolvedValue(true)
  vi.mocked(insertJobIfAbsent).mockResolvedValue(true)
})

describe('queueRevisionNotice', () => {
  it('queues one bulk job per pair, held for the debounce, naming the person and nothing of the content', async () => {
    expect(await queueRevisionNotice(request, NOW)).toBe(true)

    expect(isOrgFeatureEnabled).toHaveBeenCalledWith('piloti-notices', 'org-1')
    const noticeId = revisionNoticeId('doc-b', 'doc-a')
    expect(insertJobIfAbsent).toHaveBeenCalledWith({
      kind: 'revision_notice',
      organizationId: 'org-1',
      priority: BFF_JOB_PRIORITY.bulk,
      jobId: noticeId,
      notBefore: new Date('2026-10-21T10:02:00Z'),
      payload: { noticeId, newerId: 'doc-b', olderId: 'doc-a', actor: { userId: 'editor', email: null } },
    })
  })

  it('reads the debounce from the deployment', async () => {
    vi.stubEnv('REVISION_NOTICE_DELAY_SECONDS', '0')

    await queueRevisionNotice(request, NOW)

    expect(vi.mocked(insertJobIfAbsent).mock.calls[0][0].notBefore).toEqual(NOW)
  })

  it('queues nothing where the office has not switched it on', async () => {
    vi.mocked(isOrgFeatureEnabled).mockResolvedValue(false)

    expect(await queueRevisionNotice(request, NOW)).toBe(false)
    expect(insertJobIfAbsent).not.toHaveBeenCalled()
  })

  it('queues nothing without a person to act as, or for a document compared with itself', async () => {
    expect(await queueRevisionNotice({ ...request, actorUserId: null }, NOW)).toBe(false)
    expect(await queueRevisionNotice({ ...request, olderId: 'doc-b' }, NOW)).toBe(false)
    expect(isOrgFeatureEnabled).not.toHaveBeenCalled()
  })

  it('never throws into the announcement it rides on', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.mocked(insertJobIfAbsent).mockRejectedValue(new Error('db down'))

    await expect(queueRevisionNotice(request, NOW)).resolves.toBe(false)
  })
})
