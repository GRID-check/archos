/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/workos/feature-flags', () => ({ isOrgFeatureEnabled: vi.fn() }))
vi.mock('@/lib/limits', () => ({ consumeLimit: vi.fn() }))
vi.mock('@/lib/jobs-queue/repository', () => ({ insertJobIfAbsent: vi.fn() }))
vi.mock('@/lib/db/tenant-context', () => ({ withTenant: (_scope: unknown, fn: () => unknown) => fn() }))
vi.mock('@/lib/documents/revision-announcement-repository', () => ({
  claimRevisionAnnouncement: vi.fn(),
  releaseRevisionAnnouncement: vi.fn(),
}))

import { claimRevisionAnnouncement, releaseRevisionAnnouncement } from '@/lib/documents/revision-announcement-repository'
import { consumeLimit } from '@/lib/limits'
import { insertJobIfAbsent } from '@/lib/jobs-queue/repository'
import { BFF_JOB_PRIORITY } from '@/lib/jobs-queue/types'
import { isOrgFeatureEnabled } from '@/lib/workos/feature-flags'
import { documentCheckId } from './check'
import { queueDocumentCheck } from './queue'

const request = { organizationId: 'org-1', actorUserId: 'uploader', documentId: 'doc-1', versionId: 'v1' }
const NOW = new Date('2026-10-22T10:00:00Z')

beforeEach(() => {
  vi.resetAllMocks()
  vi.unstubAllEnvs()
  vi.mocked(isOrgFeatureEnabled).mockResolvedValue(true)
  vi.mocked(claimRevisionAnnouncement).mockResolvedValue(true)
  vi.mocked(releaseRevisionAnnouncement).mockResolvedValue(undefined)
  vi.mocked(insertJobIfAbsent).mockResolvedValue(true)
  vi.mocked(consumeLimit).mockResolvedValue({ allowed: true } as never)
})

describe('queueDocumentCheck', () => {
  it('queues one bulk job for a first upload, held for the debounce, naming the person and no content', async () => {
    expect(await queueDocumentCheck(request, NOW)).toBe(true)

    const checkId = documentCheckId('doc-1', 'v1')
    expect(isOrgFeatureEnabled).toHaveBeenCalledWith('piloti-notices', 'org-1')
    expect(insertJobIfAbsent).toHaveBeenCalledWith({
      kind: 'document_check',
      organizationId: 'org-1',
      priority: BFF_JOB_PRIORITY.bulk,
      jobId: checkId,
      notBefore: new Date('2026-10-22T10:02:00Z'),
      payload: {
        checkId,
        documentId: 'doc-1',
        actor: { userId: 'uploader', email: null },
        conversationId: null,
        waits: 0,
      },
    })
  })

  it('queues nothing, and claims nothing, where the office has not switched it on', async () => {
    vi.mocked(isOrgFeatureEnabled).mockResolvedValue(false)

    expect(await queueDocumentCheck(request, NOW)).toBe(false)
    expect(claimRevisionAnnouncement).not.toHaveBeenCalled()
    expect(insertJobIfAbsent).not.toHaveBeenCalled()
  })

  it('queues nothing without a person to act as', async () => {
    expect(await queueDocumentCheck({ ...request, actorUserId: null }, NOW)).toBe(false)
    expect(isOrgFeatureEnabled).not.toHaveBeenCalled()
  })

  it('checks a version once: a second settle finds the claim taken', async () => {
    vi.mocked(claimRevisionAnnouncement).mockResolvedValue(false)

    expect(await queueDocumentCheck(request, NOW)).toBe(false)
    expect(insertJobIfAbsent).not.toHaveBeenCalled()
  })

  it('keys the claim on the version, so a new version is checked again', async () => {
    await queueDocumentCheck(request, NOW)
    await queueDocumentCheck({ ...request, versionId: 'v2' }, NOW)

    const anchors = vi.mocked(claimRevisionAnnouncement).mock.calls.map((call) => call[0].anchorId)
    expect(new Set(anchors).size).toBe(2)
  })

  it('gives the claim back when no job was queued, or the queue failed, and never throws', async () => {
    vi.mocked(insertJobIfAbsent).mockResolvedValueOnce(false)
    expect(await queueDocumentCheck(request, NOW)).toBe(false)
    expect(releaseRevisionAnnouncement).toHaveBeenCalledTimes(1)

    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.mocked(insertJobIfAbsent).mockRejectedValueOnce(new Error('db down'))
    await expect(queueDocumentCheck(request, NOW)).resolves.toBe(false)
    expect(releaseRevisionAnnouncement).toHaveBeenCalledTimes(2)
  })

  it('spends one of the organization\'s daily checks, 25 by default', async () => {
    await queueDocumentCheck(request, NOW)

    expect(consumeLimit).toHaveBeenCalledWith(
      { name: 'document-check-daily', limit: 25, windowMs: 86_400_000 },
      'org-1',
    )
  })

  it('reads the cap from the deployment', async () => {
    vi.stubEnv('DOCUMENT_CHECK_DAILY_LIMIT', '3')

    await queueDocumentCheck(request, NOW)

    expect(vi.mocked(consumeLimit).mock.calls[0][0]).toMatchObject({ limit: 3 })
  })

  it('does not queue a version over the daily cap, and keeps it claimed so a burst never queues it later', async () => {
    vi.mocked(consumeLimit).mockResolvedValue({ allowed: false } as never)
    vi.spyOn(console, 'info').mockImplementation(() => undefined)

    expect(await queueDocumentCheck(request, NOW)).toBe(false)
    expect(insertJobIfAbsent).not.toHaveBeenCalled()
    expect(releaseRevisionAnnouncement).not.toHaveBeenCalled()
  })

  it('switches the checks off with a cap of 0, before anything is read or claimed', async () => {
    vi.stubEnv('DOCUMENT_CHECK_DAILY_LIMIT', '0')

    expect(await queueDocumentCheck(request, NOW)).toBe(false)
    expect(isOrgFeatureEnabled).not.toHaveBeenCalled()
    expect(claimRevisionAnnouncement).not.toHaveBeenCalled()
  })
})
