/**
 * @vitest-environment node
 */
/**
 * „Verlauf folgen“ as a decision (D31): who may follow a thread and with which
 * rights, how a second call renews rather than duplicates, that a follow run
 * out is ended before a new one starts, who may end whose follow, and that
 * every start, renewal and end reaches the audit trail and PostHog with ids
 * and codes only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('./follow-repository', () => ({
  endFollow: vi.fn(),
  findRunningFollow: vi.fn(),
  renewFollow: vi.fn(),
  startFollow: vi.fn(),
}))
vi.mock('./repository', () => ({ findVisibleThread: vi.fn() }))
vi.mock('./write-repository', () => ({ findWritableThread: vi.fn() }))
vi.mock('@/lib/inbound-mail/access', () => ({
  managesProject: vi.fn(async () => false),
  requireInboundMailEnabled: vi.fn(),
  requireMailReviewer: vi.fn(async () => ({ closed: false })),
}))
vi.mock('@/lib/authz/folder-access', () => ({
  getHiddenFolderIds: vi.fn(async () => []),
  requireFolderWrite: vi.fn(async () => undefined),
}))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn(async () => ({ closed: false })) }))
vi.mock('@/lib/audit/after-commit', () => ({ recordAuditEventAfterCommit: vi.fn() }))
vi.mock('@/lib/analytics/posthog-server', () => ({ captureServer: vi.fn() }))
vi.mock('@/lib/realtime/door-events', () => ({ publishProjectChanged: vi.fn() }))

import { ForbiddenError, NotFoundError } from '@/lib/api/errors'
import { captureServer } from '@/lib/analytics/posthog-server'
import { recordAuditEventAfterCommit } from '@/lib/audit/after-commit'
import type { AuthorizedSession } from '@/lib/auth/types'
import { requireFolderWrite } from '@/lib/authz/folder-access'
import { requireProjectAccess } from '@/lib/authz/projects'
import type { MailThreadFollowRow } from '@/lib/db/schema'
import { managesProject, requireInboundMailEnabled, requireMailReviewer } from '@/lib/inbound-mail/access'
import { endFollow, findRunningFollow, renewFollow, startFollow } from './follow-repository'
import { endFollowBySystem, followMailThread, unfollowMailThread } from './follows'
import type { ThreadRow } from './repository'
import { findVisibleThread } from './repository'
import { findWritableThread, type WritableThread } from './write-repository'

const PROJECT = '3f0b1c2d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const THREAD = '4e5f6a7b-8c9d-4e0f-8a1b-2c3d4e5f6a7b'
const ME = 'user_01JCX0R4D8M2W6YB3N5Q7T9V1A'
const COLLEAGUE = 'user_01JCX0R4D8M2W6YB3N5Q7T9V2B'
const DAY = 24 * 60 * 60 * 1000
const session = { userId: ME, organizationId: 'org_1', email: 'petra@example.test' } as AuthorizedSession

function followRow(overrides: Partial<MailThreadFollowRow> = {}): MailThreadFollowRow {
  const createdAt = new Date(Date.now() - 10 * DAY)
  return {
    id: 'f-1',
    organizationId: 'org_1',
    projectId: PROJECT,
    threadId: THREAD,
    userId: ME,
    createdAt,
    expiresAt: new Date(Date.now() + 50 * DAY),
    renewedAt: null,
    dailyCap: 20,
    expiringNotifiedAt: null,
    endedAt: null,
    endedBy: null,
    endedReason: null,
    ...overrides,
  }
}

const thread: WritableThread = {
  thread: { id: THREAD } as WritableThread['thread'],
  document: { id: 'doc-1', filename: 'Statik.md', folderId: 'folder-statik', contentHash: 'h' },
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(findVisibleThread).mockResolvedValue({ id: THREAD } as ThreadRow)
  vi.mocked(findWritableThread).mockResolvedValue(thread)
  vi.mocked(findRunningFollow).mockResolvedValue(null)
  vi.mocked(startFollow).mockImplementation(async (row) => followRow({ ...row, createdAt: row.createdAt as Date, expiresAt: row.expiresAt as Date }))
  vi.mocked(renewFollow).mockImplementation(async (id, until, now) => followRow({ id, expiresAt: until, renewedAt: now }))
  vi.mocked(endFollow).mockImplementation(async (id, end, now) =>
    followRow({ id, endedAt: now ?? new Date(), endedBy: end.endedBy, endedReason: end.reason }),
  )
  vi.mocked(managesProject).mockResolvedValue(false)
})

describe('followMailThread', () => {
  it('starts a follow of 60 days as the caller, audited and counted', async () => {
    const before = Date.now()
    const result = await followMailThread(session, PROJECT, THREAD, {})
    expect(result.renewed).toBe(false)
    const row = vi.mocked(startFollow).mock.calls[0]![0]
    expect(row).toMatchObject({ organizationId: 'org_1', projectId: PROJECT, threadId: THREAD, userId: ME })
    const days = ((row.expiresAt as Date).getTime() - before) / DAY
    expect(days).toBeGreaterThan(59.99)
    expect(days).toBeLessThan(60.01)
    expect(recordAuditEventAfterCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'mail_thread.follow_started',
        actor: { userId: ME, email: 'petra@example.test' },
        targetId: THREAD,
        metadata: { projectId: PROJECT, followId: 'f-1', days: 60, renewed: false },
      }),
    )
    expect(captureServer).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'mail_thread_followed', distinctId: ME, properties: { action: 'start', days: 60 } }),
    )
  })

  it('asks the rights an append is filed with: a reviewer of the mail, the thread readable, its folder writable', async () => {
    await followMailThread(session, PROJECT, THREAD, { days: 7 })
    expect(requireMailReviewer).toHaveBeenCalledWith(session, PROJECT)
    expect(requireFolderWrite).toHaveBeenCalledWith(session, PROJECT, ['folder-statik'])
  })

  it('is not found for a thread the caller may not read, or whose document is not live for them', async () => {
    vi.mocked(findVisibleThread).mockResolvedValueOnce(null)
    await expect(followMailThread(session, PROJECT, THREAD, {})).rejects.toBeInstanceOf(NotFoundError)
    vi.mocked(findWritableThread).mockResolvedValueOnce(null)
    await expect(followMailThread(session, PROJECT, THREAD, {})).rejects.toBeInstanceOf(NotFoundError)
    expect(startFollow).not.toHaveBeenCalled()
  })

  it('refuses a caller who may not write the thread document’s folder, or a closed project, and starts nothing', async () => {
    vi.mocked(requireFolderWrite).mockRejectedValueOnce(new ForbiddenError('closed', { reason: 'project-closed' }))
    await expect(followMailThread(session, PROJECT, THREAD, {})).rejects.toBeInstanceOf(ForbiddenError)
    expect(startFollow).not.toHaveBeenCalled()
    expect(recordAuditEventAfterCommit).not.toHaveBeenCalled()
  })

  it('renews the running follow rather than starting a second', async () => {
    vi.mocked(findRunningFollow).mockResolvedValue(followRow())
    const result = await followMailThread(session, PROJECT, THREAD, { days: 90 })
    expect(result.renewed).toBe(true)
    expect(startFollow).not.toHaveBeenCalled()
    expect(renewFollow).toHaveBeenCalledWith('f-1', expect.any(Date), expect.any(Date))
    expect(captureServer).toHaveBeenCalledWith(expect.objectContaining({ properties: { action: 'renew', days: 90 } }))
  })

  it('ends a follow that ran out but was not swept yet, then starts a new one', async () => {
    vi.mocked(findRunningFollow).mockResolvedValue(followRow({ id: 'f-old', expiresAt: new Date(Date.now() - 1) }))
    vi.mocked(startFollow).mockResolvedValue(followRow({ id: 'f-new' }))
    const result = await followMailThread(session, PROJECT, THREAD, {})
    expect(endFollow).toHaveBeenCalledWith('f-old', { reason: 'expired', endedBy: null }, expect.any(Date))
    expect(result).toMatchObject({ renewed: false, follow: { id: 'f-new' } })
  })

  it('renews the follow another request started between its read and its insert', async () => {
    vi.mocked(startFollow).mockResolvedValueOnce(null)
    vi.mocked(findRunningFollow).mockResolvedValueOnce(null).mockResolvedValueOnce(followRow({ id: 'f-race' }))
    const result = await followMailThread(session, PROJECT, THREAD, {})
    expect(result).toMatchObject({ renewed: true, follow: { id: 'f-race' } })
  })
})

describe('unfollowMailThread', () => {
  it('ends the caller’s own follow as `unfollowed`, by them', async () => {
    vi.mocked(findRunningFollow).mockResolvedValue(followRow())
    expect(await unfollowMailThread(session, PROJECT, THREAD, {})).toEqual({ endedFollowId: 'f-1' })
    expect(requireInboundMailEnabled).toHaveBeenCalledWith(session)
    expect(requireProjectAccess).toHaveBeenCalledWith(session, PROJECT, 'project:view')
    expect(endFollow).toHaveBeenCalledWith('f-1', { reason: 'unfollowed', endedBy: ME })
    expect(recordAuditEventAfterCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'mail_thread.follow_ended',
        actor: { userId: ME, email: 'petra@example.test' },
        metadata: { projectId: PROJECT, followId: 'f-1', reason: 'unfollowed', followerUserId: ME },
        idempotencyKey: 'mail_thread.follow_ended:f-1',
      }),
    )
    expect(captureServer).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'mail_thread_followed', distinctId: ME, properties: { action: 'end', reason: 'unfollowed' } }),
    )
  })

  it('refuses ending someone else’s follow without project:manage', async () => {
    vi.mocked(findRunningFollow).mockResolvedValue(followRow({ userId: COLLEAGUE }))
    await expect(unfollowMailThread(session, PROJECT, THREAD, { userId: COLLEAGUE })).rejects.toBeInstanceOf(ForbiddenError)
    expect(endFollow).not.toHaveBeenCalled()
  })

  it('lets a project manager end someone else’s follow, recorded as revoked by them', async () => {
    vi.mocked(managesProject).mockResolvedValue(true)
    vi.mocked(findRunningFollow).mockResolvedValue(followRow({ userId: COLLEAGUE }))
    expect(await unfollowMailThread(session, PROJECT, THREAD, { userId: COLLEAGUE })).toEqual({ endedFollowId: 'f-1' })
    expect(findRunningFollow).toHaveBeenCalledWith(THREAD, COLLEAGUE)
    expect(endFollow).toHaveBeenCalledWith('f-1', { reason: 'revoked_by_manager', endedBy: ME })
  })

  it('changes nothing when no follow runs, and is not found for a thread the caller may not read', async () => {
    expect(await unfollowMailThread(session, PROJECT, THREAD, {})).toEqual({ endedFollowId: null })
    vi.mocked(findVisibleThread).mockResolvedValue(null)
    await expect(unfollowMailThread(session, PROJECT, THREAD, {})).rejects.toBeInstanceOf(NotFoundError)
    expect(endFollow).not.toHaveBeenCalled()
  })

  it('never ends a follow of another project named through this one', async () => {
    vi.mocked(findRunningFollow).mockResolvedValue(followRow({ projectId: 'another-project' }))
    expect(await unfollowMailThread(session, PROJECT, THREAD, {})).toEqual({ endedFollowId: null })
    expect(endFollow).not.toHaveBeenCalled()
  })

  it('records nothing when the follow ended in between', async () => {
    vi.mocked(findRunningFollow).mockResolvedValue(followRow())
    vi.mocked(endFollow).mockResolvedValue(null)
    expect(await unfollowMailThread(session, PROJECT, THREAD, {})).toEqual({ endedFollowId: null })
    expect(recordAuditEventAfterCommit).not.toHaveBeenCalled()
  })
})

describe('endFollowBySystem', () => {
  it('ends with the reason, by nobody, as the inbound mail system, and personless in PostHog', async () => {
    expect(await endFollowBySystem({ id: 'f-1' }, 'access_lost')).toBe(true)
    expect(endFollow).toHaveBeenCalledWith('f-1', { reason: 'access_lost', endedBy: null }, expect.any(Date))
    expect(recordAuditEventAfterCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { userId: 'system:inbound_mail', email: null },
        metadata: expect.objectContaining({ reason: 'access_lost', followerUserId: ME }),
      }),
    )
    expect(captureServer).toHaveBeenCalledWith(
      expect.objectContaining({ distinctId: null, properties: { action: 'end', reason: 'access_lost' } }),
    )
  })

  it('records once: a follow already ended is left as it is', async () => {
    vi.mocked(endFollow).mockResolvedValue(null)
    expect(await endFollowBySystem({ id: 'f-1' }, 'document_gone')).toBe(false)
    expect(recordAuditEventAfterCommit).not.toHaveBeenCalled()
  })
})
