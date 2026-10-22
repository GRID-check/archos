/**
 * @vitest-environment node
 *
 * Who hears that mail waits (D9, RT-S14), and what the row may say: the
 * project's name and a count, never the mail.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/authz/project-membership', () => ({ userHoldsProjectPermission: vi.fn() }))
vi.mock('@/lib/sharing/directory', () => ({ loadOrganizationDirectory: vi.fn() }))
vi.mock('@/lib/projects/repository', () => ({ findProjectInOrg: vi.fn() }))
vi.mock('@/lib/inbox/service', () => ({
  emitInboxItems: vi.fn(async (rows: unknown[]) => rows.length),
  openRecipientsOf: vi.fn(async () => []),
  resolveInboxItemsFor: vi.fn(async () => 0),
  resolveInboxItemsAnchoredOn: vi.fn(async () => 0),
}))
vi.mock('@/lib/authz/folder-access', () => ({ isFolderVisibleToMember: vi.fn(async () => true) }))
vi.mock('./notice-repository', () => ({
  filedFolderIds: vi.fn(async () => []),
  projectNoticeState: vi.fn(async () => ({ waiting: false, expiring: false })),
}))
vi.mock('@/lib/mail-thread/write-repository', () => ({ findThreadRow: vi.fn(async () => ({ documentId: DOCUMENT_ID })) }))
vi.mock('./repository', () => ({ findLiveFolders: vi.fn(async (_p: string, ids: string[]) => new Map(ids.map((id) => [id, 'Behörde/Bescheide']))) }))

import { userHoldsProjectPermission } from '@/lib/authz/project-membership'
import { isFolderVisibleToMember } from '@/lib/authz/folder-access'
import { DEFAULT_PUSH_PREFERENCES } from '@/lib/inbox/push-categories'
import { buildPushMessage } from '@/lib/push/payload'
import {
  emitInboxItems,
  openRecipientsOf,
  resolveInboxItemsAnchoredOn,
  resolveInboxItemsFor,
  type InboxEmission,
} from '@/lib/inbox/service'
import type { InboxItemView } from '@/lib/inbox/types'
import { findProjectInOrg } from '@/lib/projects/repository'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
import {
  announceAppended,
  announceCapReached,
  announceDecided,
  announceExpiring,
  announceFilingFailed,
  announceFollowExpiring,
  announceWaiting,
  INBOUND_MAIL_INBOX_TYPES,
  notifiesSender,
  settleCapReached,
  settleFilingFailed,
  settleFollowExpiring,
  settleProjectNotices,
  type WaitingMail,
} from './announce'
import { filedFolderIds, projectNoticeState } from './notice-repository'

const DOCUMENT_ID = '7d6c5b4a-0000-4000-8000-00000000d001'
const ORG = 'org_01ANNOUNCE'
const PROJECT = '0e5b4f2e-1d7c-4c3a-9a51-2f0d8c6b7a10'
const MEMBER = 'user_01HZX3Y4Z5A6B7C8D9E0F1G2H3'
const MANAGER = 'user_01HZX3Y4Z5A6B7C8D9E0F1G2M1'
const OTHER = 'user_01HZX3Y4Z5A6B7C8D9E0F1G2O1'

const mail = (overrides: Partial<WaitingMail> = {}): WaitingMail => ({
  organizationId: ORG,
  projectId: PROJECT,
  mailId: '3c2b1a00-0000-4000-8000-00000000a001',
  senderTrust: 'member_verified',
  senderUserId: MEMBER,
  senderFlags: [],
  automatic: false,
  ...overrides,
})

const emitted = () => (vi.mocked(emitInboxItems).mock.calls[0]?.[0] ?? []) as InboxEmission[]

beforeEach(() => {
  vi.mocked(findProjectInOrg).mockResolvedValue({ id: PROJECT, name: 'Wohnbau Hietzing' } as never)
  vi.mocked(loadOrganizationDirectory).mockResolvedValue(
    new Map([MEMBER, MANAGER, OTHER].map((userId) => [userId, { userId, email: null, name: userId, profilePictureUrl: null }])),
  )
  vi.mocked(userHoldsProjectPermission).mockImplementation(async (_session, _project, userId, permission) =>
    permission === 'project:view' ? userId !== OTHER : userId === MANAGER,
  )
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('inbound_mail.waiting', () => {
  it('tells a verified member about their own mail to the project, and nobody else', async () => {
    await announceWaiting(mail())

    expect(emitted().map((row) => row.recipientUserId)).toEqual([MEMBER])
  })

  it('tells the member about their own Bcc copy, but the managers about a replay to someone else', () => {
    expect(notifiesSender(mail({ senderFlags: ['not_addressed_to_project', 'bcc_own'] }))).toBe(true)
    expect(notifiesSender(mail({ senderFlags: ['not_addressed_to_project'] }))).toBe(false)
  })

  it('never tells the member a mail with an unverified domain names: the managers hear of it (RT-S14)', async () => {
    await announceWaiting(mail({ senderTrust: 'member_unverified' }))

    expect(emitted().map((row) => row.recipientUserId)).toEqual([MANAGER])
  })

  it('tells the managers about a stranger’s mail, and about a member’s when the member may not read the project', async () => {
    await announceWaiting(mail({ senderTrust: 'external_verified', senderUserId: null }))
    expect(emitted().map((row) => row.recipientUserId)).toEqual([MANAGER])

    vi.mocked(emitInboxItems).mockClear()
    vi.mocked(userHoldsProjectPermission).mockImplementation(async (_s, _p, userId, permission) =>
      permission === 'project:manage' && userId === MANAGER,
    )
    await announceWaiting(mail())
    expect(emitted().map((row) => row.recipientUserId)).toEqual([MANAGER])
  })

  it('names the project and never the mail, and says when the domain is unconfirmed or the mail automatic', async () => {
    await announceWaiting(mail({ senderTrust: 'external_unverified', senderUserId: null }))
    await announceWaiting(mail({ automatic: true }))
    await announceWaiting(mail())

    const [unverified, automatic, verified] = vi.mocked(emitInboxItems).mock.calls.map(([rows]) => rows[0])
    expect(unverified.payload).toEqual({ subject: 'Wohnbau Hietzing', variant: 'unconfirmed' })
    expect(automatic.payload).toEqual({ subject: 'Wohnbau Hietzing', variant: 'unconfirmed' })
    expect(verified.payload).toEqual({ subject: 'Wohnbau Hietzing' })
    // One counted row per recipient and project, whatever the mail.
    expect(new Set([unverified, automatic, verified].map((row) => row.groupKey))).toEqual(
      new Set([`inbound_mail.waiting:project:${PROJECT}`]),
    )
    expect(verified).toMatchObject({ type: 'inbound_mail.waiting', resourceType: 'project', resourceId: PROJECT, actorUserId: null })
  })

  it('never throws into the job: a failed write costs a row, not the mail', async () => {
    vi.mocked(emitInboxItems).mockRejectedValue(new Error('db down'))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(announceWaiting(mail())).resolves.toBe(false)
  })
})

const DECIDER = 'user_01HZX3Y4Z5A6B7C8D9E0F1G2D1'
const MAIL = '3c2b1a00-0000-4000-8000-00000000a001'
const DOCUMENT = DOCUMENT_ID
const THREAD = '6c5b4a39-0000-4000-8000-00000000c001'

describe('inbound_mail.expiring', () => {
  it('tells whoever was told the mail waits, in the project’s collapsed row, and says when the domain is unconfirmed', async () => {
    await announceExpiring(mail({ senderTrust: 'external_unverified', senderUserId: null }))

    expect(emitted()).toEqual([
      expect.objectContaining({
        recipientUserId: MANAGER,
        type: 'inbound_mail.expiring',
        groupKey: `inbound_mail.expiring:project:${PROJECT}`,
        payload: { subject: 'Wohnbau Hietzing', variant: 'unconfirmed' },
      }),
    ])
  })
})

describe('inbound_mail.decided (D9)', () => {
  const decided = (overrides = {}) => ({ ...mail(), decidedBy: DECIDER, outcome: 'filed' as const, ...overrides })

  it('tells the verified member sender, per mail, naming the one folder they may open', async () => {
    vi.mocked(filedFolderIds).mockResolvedValueOnce(['folder-1', 'folder-1'])

    await announceDecided(decided())

    expect(emitted()).toEqual([
      expect.objectContaining({
        recipientUserId: MEMBER,
        type: 'inbound_mail.decided',
        anchorId: 'folder-1',
        actorUserId: DECIDER,
        groupKey: `inbound_mail.decided:project:${PROJECT}:${MAIL}`,
        payload: { subject: 'Wohnbau Hietzing', related: 'Behörde/Bescheide' },
      }),
    ])
    // The folders are read as the member reads the files: one held from them by its screening names none.
    expect(filedFolderIds).toHaveBeenCalledWith(MAIL, { kind: 'member', userId: MEMBER })
  })

  it('names no folder the member may not open, nor one of several (RT-S13)', async () => {
    vi.mocked(filedFolderIds).mockResolvedValueOnce(['folder-1'])
    vi.mocked(isFolderVisibleToMember).mockResolvedValueOnce(false)
    await announceDecided(decided())
    vi.mocked(filedFolderIds).mockResolvedValueOnce(['folder-1', 'folder-2'])
    await announceDecided(decided())

    for (const [rows] of vi.mocked(emitInboxItems).mock.calls) {
      expect(rows[0]).toMatchObject({ anchorId: null, payload: { subject: 'Wohnbau Hietzing' } })
      expect(rows[0]?.payload).not.toHaveProperty('related')
    }
  })

  it('says dismissed, and never tells anyone about an unverified or a stranger’s mail', async () => {
    await announceDecided(decided({ outcome: 'dismissed' }))
    expect(emitted()[0]?.payload).toEqual({ subject: 'Wohnbau Hietzing', variant: 'dismissed' })

    vi.mocked(emitInboxItems).mockClear()
    expect(await announceDecided(decided({ senderTrust: 'member_unverified' }))).toBe(false)
    expect(await announceDecided(decided({ senderTrust: 'external_verified', senderUserId: null }))).toBe(false)
    expect(await announceDecided(decided({ senderTrust: null }))).toBe(false)
    expect(emitInboxItems).not.toHaveBeenCalled()
  })
})

describe('inbound_mail.filing_failed', () => {
  it('tells the decider, per mail, with the failure as its variant; a later decision settles it', async () => {
    await announceFilingFailed({ organizationId: ORG, projectId: PROJECT, mailId: MAIL, decidedBy: DECIDER, failure: 'quota' })

    expect(emitted()).toEqual([
      expect.objectContaining({
        recipientUserId: DECIDER,
        type: 'inbound_mail.filing_failed',
        anchorId: MAIL,
        groupKey: `inbound_mail.filing_failed:project:${PROJECT}:${MAIL}`,
        payload: { subject: 'Wohnbau Hietzing', variant: 'quota' },
      }),
    ])

    await settleFilingFailed(ORG, [MAIL])
    expect(resolveInboxItemsAnchoredOn).toHaveBeenCalledWith({ organizationId: ORG, types: ['inbound_mail.filing_failed'], anchorId: MAIL })
  })
})

describe('inbound_mail.cap_reached', () => {
  it('tells the managers, per address; settling resolves the address’s rows', async () => {
    await announceCapReached({ organizationId: ORG, projectId: PROJECT, addressId: 'address-1', notice: 'full' })

    expect(emitted()).toEqual([
      expect.objectContaining({
        recipientUserId: MANAGER,
        anchorId: 'address-1',
        groupKey: `inbound_mail.cap_reached:project:${PROJECT}:address-1`,
        payload: { subject: 'Wohnbau Hietzing', variant: 'full' },
      }),
    ])
    await settleCapReached(ORG, 'address-1')
    expect(resolveInboxItemsAnchoredOn).toHaveBeenCalledWith({ organizationId: ORG, types: ['inbound_mail.cap_reached'], anchorId: 'address-1' })
  })
})

describe('inbound_mail.appended and mail_thread.follow_expiring', () => {
  it('tells the follower on the Verlauf document, one row per Verlauf and day, anchored on the newest mail', async () => {
    await announceAppended({ organizationId: ORG, projectId: PROJECT, mailId: MAIL, threadId: THREAD, followerUserId: MEMBER, at: new Date('2026-10-22T18:00:00Z') })
    await announceAppended({ organizationId: ORG, projectId: PROJECT, mailId: 'mail-2', threadId: THREAD, followerUserId: MEMBER, at: new Date('2026-10-22T23:00:00Z') })

    const [first, second] = vi.mocked(emitInboxItems).mock.calls.map(([rows]) => rows[0])
    expect(first).toMatchObject({ recipientUserId: MEMBER, resourceType: 'document', resourceId: DOCUMENT, anchorId: MAIL, actorUserId: null })
    expect(second?.groupKey).toBe(first?.groupKey)
    expect(first?.groupKey).toBe(`inbound_mail.appended:document:${DOCUMENT}:day:2026-10-22`)
  })

  it('asks the follower to renew, per follow; renewing or ending settles it', async () => {
    await announceFollowExpiring({ organizationId: ORG, projectId: PROJECT, followId: 'follow-1', threadDocumentId: DOCUMENT, followerUserId: MEMBER })

    expect(emitted()).toEqual([
      expect.objectContaining({ type: 'mail_thread.follow_expiring', anchorId: 'follow-1', groupKey: `mail_thread.follow_expiring:document:${DOCUMENT}:follow-1` }),
    ])
    await settleFollowExpiring(ORG, ['follow-1'])
    expect(resolveInboxItemsAnchoredOn).toHaveBeenCalledWith({ organizationId: ORG, types: ['mail_thread.follow_expiring'], anchorId: 'follow-1' })
  })
})

describe('settling the project’s collapsed rows', () => {
  it('settles `waiting` and `expiring` for everyone once nothing they count waits, whichever mail anchors them', async () => {
    vi.mocked(openRecipientsOf).mockResolvedValue([MANAGER])
    await settleProjectNotices(ORG, PROJECT)

    expect(resolveInboxItemsFor).toHaveBeenCalledWith([{ organizationId: ORG, recipientUserId: MANAGER, groupKey: `inbound_mail.waiting:project:${PROJECT}` }])
    expect(resolveInboxItemsFor).toHaveBeenCalledWith([{ organizationId: ORG, recipientUserId: MANAGER, groupKey: `inbound_mail.expiring:project:${PROJECT}` }])
  })

  it('keeps a row while a mail it counts still waits', async () => {
    vi.mocked(projectNoticeState).mockResolvedValueOnce({ waiting: true, expiring: true })
    await settleProjectNotices(ORG, PROJECT)
    expect(resolveInboxItemsFor).not.toHaveBeenCalled()
  })
})

describe('redacted by construction (RT-X1)', () => {
  // Strings a stranger could write. None is passed in a field the emitters read,
  // and the extra fields below stand for a caller that hands the whole row over.
  const CANARY = ['canary-sender@evil.example', 'Canary Subject Zeile', 'canary-file.pdf', 'Canary Absender']
  const leaky = { senderAddress: CANARY[0], subject: CANARY[1], filename: CANARY[2], senderName: CANARY[3] }

  it('no row and no push of any type carries a sender, a subject or a file name', async () => {
    const base = { ...mail(), ...leaky } as WaitingMail
    vi.mocked(filedFolderIds).mockResolvedValue(['folder-1'])
    await announceWaiting(base)
    await announceExpiring(base)
    await announceDecided({ ...base, decidedBy: DECIDER, outcome: 'filed' })
    await announceFilingFailed({ ...leaky, organizationId: ORG, projectId: PROJECT, mailId: MAIL, decidedBy: DECIDER, failure: 'screened' })
    await announceCapReached({ ...leaky, organizationId: ORG, projectId: PROJECT, addressId: 'address-1', notice: 'nearly_full' })
    await announceAppended({ ...leaky, organizationId: ORG, projectId: PROJECT, mailId: MAIL, threadId: THREAD, followerUserId: MEMBER })
    await announceFollowExpiring({ ...leaky, organizationId: ORG, projectId: PROJECT, followId: 'follow-1', threadDocumentId: DOCUMENT, followerUserId: MEMBER })
    vi.mocked(filedFolderIds).mockResolvedValue([])

    const rows = vi.mocked(emitInboxItems).mock.calls.flatMap(([batch]) => batch)
    expect(new Set(rows.map((row) => row.type))).toEqual(new Set(INBOUND_MAIL_INBOX_TYPES))
    for (const row of rows) {
      const view: InboxItemView = {
        id: 'item-1',
        type: row.type,
        state: 'unread',
        archived: false,
        actionable: false,
        resourceType: row.resourceType,
        resourceId: row.resourceId,
        anchorId: row.anchorId ?? null,
        actorName: null,
        actorUserId: null,
        count: 1,
        href: '/app/inbox',
        subject: String(row.payload?.subject ?? ''),
        related: typeof row.payload?.related === 'string' ? row.payload.related : null,
        excerpt: null,
        mentions: [],
        variant: typeof row.payload?.variant === 'string' ? row.payload.variant : null,
        answerIn: null,
        createdAt: '2026-10-22T10:00:00.000Z',
        updatedAt: '2026-10-22T10:00:00.000Z',
      }
      const push = buildPushMessage(view, row.groupKey, DEFAULT_PUSH_PREFERENCES, 'de')
      const told = JSON.stringify([row.payload, push])
      for (const canary of CANARY) expect(told, `${row.type} carries ${canary}`).not.toContain(canary)
      expect(push?.title).toContain('Wohnbau Hietzing')
    }
  })
})
