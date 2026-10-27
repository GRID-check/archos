/**
 * @vitest-environment node
 */
/**
 * The follow job (`inbound_mail_follow`, D31): a reply's text is decided as the
 * follower and filed by the filing job's own step only while ALL nine of D31's
 * conditions hold. Each case below breaks exactly one condition of a reply
 * that would otherwise be appended, and the mail must simply wait: no decision
 * written, nothing filed. Losing access or the thread document ends the
 * follow; a thread another filing holds makes the run try again shortly; a
 * text the job decided and could not finish is filed on that decision.
 *
 * Conditions 1–6 run through the real `judgeFollow` and `followEligibility`
 * (the database reads stood in); 7–9 through the follower's session, their
 * folder rights, the thread document's state and the caps the decision's
 * transaction answers (`follow.integration.spec.ts` runs that SQL).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const state = vi.hoisted(() => ({
  nameStops: [] as string[],
  followContext: null as unknown,
}))

vi.mock('./filing-repository', () => ({ findFilingWork: vi.fn() }))
vi.mock('./repository', () => ({
  findThreadFollowContext: vi.fn(async () => state.followContext),
  findFiledMessages: vi.fn(async () => []),
  findMailParts: vi.fn(),
}))
vi.mock('./staging', () => ({ readStagedObject: vi.fn() }))
vi.mock('./screening', () => ({
  mailScreeningFor: vi.fn(async () => ({ nameStops: () => state.nameStops, contentFindings: () => [] })),
}))
vi.mock('./file-job', () => ({ runInboundMailFiling: vi.fn() }))
vi.mock('./audit', () => ({ auditDecisions: vi.fn(async () => true) }))
vi.mock('./announce', () => ({ announceAppended: vi.fn(async () => true) }))
vi.mock('./suggest-scores', () => ({ scoreMailDecision: vi.fn(() => 'no_suggestion') }))
vi.mock('./service', () => ({ FILING_CLAIM_MS: 300_000, hoursWaitingBucket: () => 'lt_1h' }))
vi.mock('@/lib/analytics/posthog-server', () => ({ captureServer: vi.fn() }))
vi.mock('@/lib/auth/pinned-session', () => ({ resolvePinnedRequesterSessionStrict: vi.fn() }))
vi.mock('@/lib/authz/feature-flags', () => ({ isInboundMailEnabled: vi.fn(() => true) }))
vi.mock('@/lib/authz/folder-access', () => ({ requireFolderWrite: vi.fn(async () => undefined) }))
vi.mock('@/lib/mail-thread/follow-repository', () => ({
  findThreadDocumentState: vi.fn(async () => 'live'),
  writeFollowDecision: vi.fn(),
}))
vi.mock('@/lib/mail-thread/write-repository', () => ({ findWritableThread: vi.fn() }))
vi.mock('@/lib/mail-thread/follows', () => ({ endFollowBySystem: vi.fn(async () => true) }))

import { ForbiddenError, NotFoundError } from '@/lib/api/errors'
import { captureServer } from '@/lib/analytics/posthog-server'
import { resolvePinnedRequesterSessionStrict } from '@/lib/auth/pinned-session'
import type { AuthorizedSession } from '@/lib/auth/types'
import { isInboundMailEnabled } from '@/lib/authz/feature-flags'
import { requireFolderWrite } from '@/lib/authz/folder-access'
import type { InboundMailDecisionRow, InboundMailPartRow, InboundMailRow } from '@/lib/db/schema'
import { SCREENED_ONLY } from '@/lib/documents/document-reader'
import type { InboundMailFollowPayload } from '@/lib/jobs-queue/types'
import { findThreadDocumentState, writeFollowDecision } from '@/lib/mail-thread/follow-repository'
import { endFollowBySystem } from '@/lib/mail-thread/follows'
import { findWritableThread, type WritableThread } from '@/lib/mail-thread/write-repository'
import { PROJECT_CLOSED_REASON } from '@/lib/projects/project-status'
import { filePart, heldMail, MAIL_ID, PERSON, PROJECT_ID, textPart, THREAD_ID } from './__fixtures__/review'
import { announceAppended } from './announce'
import { auditDecisions } from './audit'
import { runInboundMailFiling } from './file-job'
import { findFilingWork } from './filing-repository'
import { followMail, runInboundMailFollow } from './follow-job'
import { findFiledMessages, findMailParts } from './repository'
import { readStagedObject } from './staging'
import { scoreMailDecision } from './suggest-scores'

const FOLLOW_ID = '6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d'
const OTHER_FOLLOWER = 'user_01JCX0R4D8M2W6YB3N5Q7T9V2B'
const DAY = 24 * 60 * 60 * 1000
const RECEIVED = new Date('2026-10-21T08:14:00.000Z')

const follower = { userId: PERSON, organizationId: 'org_1', email: 'petra@example.test' } as AuthorizedSession
const payload: InboundMailFollowPayload = {
  projectId: PROJECT_ID,
  mailId: MAIL_ID,
  followId: FOLLOW_ID,
  requester: {
    userId: PERSON,
    email: 'petra@example.test',
    organizationMembershipId: 'om_1',
    role: 'member',
    permissions: [],
  },
}

const follow = (overrides: Record<string, unknown> = {}) => ({
  id: FOLLOW_ID,
  userId: PERSON,
  createdAt: new Date(RECEIVED.getTime() - DAY),
  expiresAt: new Date(Date.now() + 30 * DAY),
  endedAt: null,
  ...overrides,
})

const writable = (overrides: Partial<WritableThread['thread']> = {}): WritableThread => ({
  thread: { id: THREAD_ID, entryCount: 3, renderedBytes: 4_096, ...overrides } as WritableThread['thread'],
  document: { id: 'doc-thread', filename: 'Statik Einreichung.md', folderId: 'folder-statik', contentHash: 'h' },
})

/** The reply's header block: To is present, and signed in the fixture's `signedHeaders`. */
const RAW = new TextEncoder().encode(
  'From: p.weber@statik-weber.at\r\nTo: wohnbau.abcdefgh2345@piloti.at\r\nSubject: AW: Statik\r\n\r\nFreigegeben.\r\n',
)

function given(
  mail: Partial<InboundMailRow> = {},
  text: Partial<InboundMailPartRow> = {},
  attachments: InboundMailPartRow[] = [filePart()],
  decisions = new Map<string, InboundMailDecisionRow>(),
) {
  vi.mocked(findFilingWork).mockResolvedValue([
    { mail: heldMail({ receivedAt: RECEIVED, ...mail }), parts: [textPart(text), ...attachments], decisions },
  ])
}

const decided = { id: 'decision-1', partId: textPart().id, via: 'follow', mailThreadId: THREAD_ID } as InboundMailDecisionRow

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('GRID_INBOUND_MAIL_DOMAIN', 'piloti.at')
  state.nameStops = []
  state.followContext = { threadId: THREAD_ID, participantDomains: ['statik-weber.at'], follows: [follow()] }
  given()
  vi.mocked(readStagedObject).mockResolvedValue(RAW)
  vi.mocked(resolvePinnedRequesterSessionStrict).mockResolvedValue(follower)
  vi.mocked(isInboundMailEnabled).mockReturnValue(true)
  vi.mocked(requireFolderWrite).mockResolvedValue(undefined)
  vi.mocked(findThreadDocumentState).mockResolvedValue('live')
  vi.mocked(findWritableThread).mockResolvedValue(writable())
  vi.mocked(findFiledMessages).mockResolvedValue([])
  vi.mocked(writeFollowDecision).mockResolvedValue({ kind: 'written', decision: decided })
  vi.mocked(runInboundMailFiling).mockResolvedValue({ done: true, payload: { ...payload, mailIds: [MAIL_ID] } })
  vi.mocked(findMailParts).mockResolvedValue([textPart({ state: 'filed' }), filePart()])
})

/** Nothing was decided or filed for the mail: it waits exactly as without a follow. */
function expectWaitsUntouched() {
  expect(writeFollowDecision).not.toHaveBeenCalled()
  expect(runInboundMailFiling).not.toHaveBeenCalled()
  expect(auditDecisions).not.toHaveBeenCalled()
}

describe('a reply every condition of D31 holds for', () => {
  it('is decided as the follower, audited, scored on its text alone, and filed by the filing step', async () => {
    expect(await followMail('org_1', payload)).toEqual({ kind: 'appended' })

    expect(writeFollowDecision).toHaveBeenCalledOnce()
    const write = vi.mocked(writeFollowDecision).mock.calls[0]![0]
    expect(write).toMatchObject({
      follow: { id: FOLLOW_ID, userId: PERSON, threadId: THREAD_ID },
      mail: { id: MAIL_ID, organizationId: 'org_1', projectId: PROJECT_ID, receivedAt: RECEIVED },
      partId: textPart().id,
      decision: { messageText: 'full', documentType: 'correspondence' },
    })
    expect(auditDecisions).toHaveBeenCalledWith([decided])
    const scored = vi.mocked(scoreMailDecision).mock.calls[0]![0]
    expect(scored).toMatchObject({
      decidedBy: PERSON,
      via: 'follow',
      decision: { parts: [], message: { partId: textPart().id, text: 'full', thread: { action: 'append', mailThreadId: THREAD_ID } } },
    })
    // The attachments still wait: scoring them now would score them as not filed.
    expect(scored.parts.map((part) => part.kind)).toEqual(['message'])
    expect(captureServer).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'inbound_mail_decided', properties: expect.objectContaining({ via: 'follow', files: 1 }) }),
    )
    // Filed as the follower, by the filing job's own step, for this one mail.
    const [asWho, filing] = vi.mocked(runInboundMailFiling).mock.calls[0]!
    expect(asWho).toBe(follower)
    expect(filing).toMatchObject({ projectId: PROJECT_ID, mailIds: [MAIL_ID], requester: { userId: PERSON } })
    // Its own decision only: a person's decision on the same mail is theirs to file.
    expect(filing.decisionIds).toEqual([decided.id])
    // Resolved strictly: a directory that does not answer retries, it never reads as "left".
    expect(resolvePinnedRequesterSessionStrict).toHaveBeenCalledWith({
      userId: PERSON,
      email: 'petra@example.test',
      organizationId: 'org_1',
    })
  })

  it('tells the follower their Verlauf took the reply (`inbound_mail.appended`), once', async () => {
    await followMail('org_1', payload)
    expect(announceAppended).toHaveBeenCalledOnce()
    expect(announceAppended).toHaveBeenCalledWith({
      organizationId: 'org_1',
      projectId: PROJECT_ID,
      mailId: MAIL_ID,
      threadId: THREAD_ID,
      followerUserId: PERSON,
    })
  })

  it('asks the thread document to have passed screening, not merely to be readable by the follower', async () => {
    await followMail('org_1', payload)
    expect(findWritableThread).toHaveBeenCalledWith(PROJECT_ID, THREAD_ID, SCREENED_ONLY)
    expect(requireFolderWrite).toHaveBeenCalledWith(follower, PROJECT_ID, ['folder-statik'])
  })

  it('appends as the earliest running follower, whoever the receive job named', async () => {
    state.followContext = {
      threadId: THREAD_ID,
      participantDomains: ['statik-weber.at'],
      follows: [follow({ id: 'f-early', userId: OTHER_FOLLOWER, createdAt: new Date(RECEIVED.getTime() - 2 * DAY) }), follow()],
    }
    await followMail('org_1', payload)
    expect(resolvePinnedRequesterSessionStrict).toHaveBeenCalledWith({ userId: OTHER_FOLLOWER, email: null, organizationId: 'org_1' })
    expect(vi.mocked(writeFollowDecision).mock.calls[0]![0].follow).toMatchObject({ id: 'f-early', userId: OTHER_FOLLOWER })
  })
})

describe('each of D31’s nine conditions, failing alone, leaves the mail waiting', () => {
  const cases: Array<[string, () => void]> = [
    ['1. the follow was made after the mail arrived', () => {
      state.followContext = { threadId: THREAD_ID, participantDomains: ['statik-weber.at'], follows: [follow({ createdAt: new Date(RECEIVED.getTime() + 1) })] }
    }],
    ['1. the follow ran out', () => {
      state.followContext = { threadId: THREAD_ID, participantDomains: ['statik-weber.at'], follows: [follow({ expiresAt: new Date(Date.now() - 1) })] }
    }],
    ['2. the sender’s domain is not verified', () => given({ senderTrust: 'external_unverified' })],
    ['3. the match is only by subject', () => given({ threadMatch: [{ threadId: THREAD_ID, strength: 'subject', headers: [] }] })],
    ['3. the reference header is outside the signature', () =>
      given({ signedHeaders: ['from', 'subject', 'date', 'message-id', 'to'] })],
    ['3. a recipient header is outside the signature', () =>
      given({ signedHeaders: ['from', 'subject', 'date', 'message-id', 'in-reply-to', 'references'] })],
    ['4. a refusing flag (stale date)', () => given({ senderFlags: ['stale_date'] })],
    ['4. automatic mail', () => given({ automatic: true })],
    ['5. a new participant domain', () =>
      given({ participants: [{ role: 'cc', name: null, address: 'neu@fremd-planer.at' }] })],
    ['6. the name check stopped the subject', () => {
      state.nameStops = ['Gehalt']
    }],
    ['6. the content check found something in the own text', () => given({}, { contentFindings: ['iban'] })],
    ['7. the office’s inbound-mail entitlement is off for the follower', () => {
      vi.mocked(isInboundMailEnabled).mockReturnValue(false)
    }],
    ['8. the follow made its appends for the day', () => {
      vi.mocked(writeFollowDecision).mockResolvedValue({ kind: 'follow_cap' })
    }],
    ['8. the project’s follows made theirs', () => {
      vi.mocked(writeFollowDecision).mockResolvedValue({ kind: 'project_cap' })
    }],
    ['8. the thread is at its entry cap', () => {
      vi.mocked(findWritableThread).mockResolvedValue(writable({ entryCount: 200 }))
    }],
    ['8. the thread is at its byte cap', () => {
      vi.mocked(findWritableThread).mockResolvedValue(writable({ renderedBytes: 2 * 1024 * 1024 }))
    }],
    ['9. the thread document is held by its screening', () => {
      vi.mocked(findWritableThread).mockResolvedValue(null)
    }],
    ['9. the thread document is held from the follower', () => {
      vi.mocked(findThreadDocumentState).mockResolvedValue('unseen')
    }],
    ['9. the project is closed', () => {
      vi.mocked(requireFolderWrite).mockRejectedValue(new ForbiddenError('closed', { reason: PROJECT_CLOSED_REASON }))
    }],
  ]

  it.each(cases)('%s', async (_name, breakIt) => {
    breakIt()
    const outcome = await followMail('org_1', payload)
    expect(outcome.kind).toBe('waits')
    expect(runInboundMailFiling).not.toHaveBeenCalled()
    expect(endFollowBySystem).not.toHaveBeenCalled()
    // A cap is the transaction's answer: it wrote nothing either.
    if (vi.mocked(writeFollowDecision).mock.calls.length === 0) expectWaitsUntouched()
    expect(auditDecisions).not.toHaveBeenCalled()
  })
})

describe('what ends the follow', () => {
  it('7. a follower who left the organization: access_lost, and the mail waits', async () => {
    vi.mocked(resolvePinnedRequesterSessionStrict).mockResolvedValue(null)
    expect(await followMail('org_1', payload)).toEqual({ kind: 'ended', reason: 'access_lost' })
    expect(endFollowBySystem).toHaveBeenCalledWith(expect.objectContaining({ id: FOLLOW_ID }), 'access_lost')
    expectWaitsUntouched()
  })

  it.each([
    ['lost the project', new NotFoundError()],
    ['may no longer write the folder', new NotFoundError('Folder not found')],
    ['lost the write permission', new ForbiddenError('no')],
  ])('7. a follower who %s: access_lost', async (_name, error) => {
    vi.mocked(requireFolderWrite).mockRejectedValue(error)
    expect(await followMail('org_1', payload)).toEqual({ kind: 'ended', reason: 'access_lost' })
    expect(endFollowBySystem).toHaveBeenCalledWith(expect.objectContaining({ id: FOLLOW_ID }), 'access_lost')
    expectWaitsUntouched()
  })

  it('9. a thread document deleted, archived or binned: document_gone', async () => {
    vi.mocked(findThreadDocumentState).mockResolvedValue('gone')
    expect(await followMail('org_1', payload)).toEqual({ kind: 'ended', reason: 'document_gone' })
    expect(endFollowBySystem).toHaveBeenCalledWith(expect.objectContaining({ id: FOLLOW_ID }), 'document_gone')
    expectWaitsUntouched()
  })

  it('never on a fault it cannot read as a refusal: the queue retries', async () => {
    vi.mocked(requireFolderWrite).mockRejectedValue(new Error('FGA timed out'))
    await expect(followMail('org_1', payload)).rejects.toThrow('FGA timed out')
    expect(endFollowBySystem).not.toHaveBeenCalled()
    vi.mocked(resolvePinnedRequesterSessionStrict).mockRejectedValue(new Error('WorkOS 503'))
    await expect(followMail('org_1', payload)).rejects.toThrow('WorkOS 503')
    expect(endFollowBySystem).not.toHaveBeenCalled()
  })
})

describe('the mail itself', () => {
  it('waits when a person decided first, or the text is no longer waiting', async () => {
    vi.mocked(findFilingWork).mockResolvedValue([])
    expect(await followMail('org_1', payload)).toEqual({ kind: 'waits', reason: 'not_waiting' })
    given({}, { state: 'dismissed' })
    expect(await followMail('org_1', payload)).toEqual({ kind: 'waits', reason: 'not_waiting' })
    vi.mocked(writeFollowDecision).mockResolvedValue({ kind: 'not_waiting' })
    given()
    expect(await followMail('org_1', payload)).toEqual({ kind: 'waits', reason: 'not_waiting' })
    expect(runInboundMailFiling).not.toHaveBeenCalled()
  })

  it('waits when its text could not be read', async () => {
    given({}, { riskFlags: ['unreadable'] })
    expect(await followMail('org_1', payload)).toEqual({ kind: 'waits', reason: 'unreadable' })
    given({ readStorageKey: null })
    expect(await followMail('org_1', payload)).toEqual({ kind: 'waits', reason: 'unreadable' })
    expectWaitsUntouched()
  })

  it('waits when its Message-ID was filed into a thread since it arrived', async () => {
    vi.mocked(findFiledMessages).mockResolvedValue([{ entryId: 'e', threadId: THREAD_ID, source: 'inbound', ownTextSha256: 'x' }])
    expect(await followMail('org_1', payload)).toEqual({ kind: 'waits', reason: 'already_filed' })
    expectWaitsUntouched()
  })

  it('waits with the upload path’s failure when the Fassung was refused', async () => {
    vi.mocked(findMailParts).mockResolvedValue([textPart({ lastFailure: 'quota' }), filePart()])
    expect(await followMail('org_1', payload)).toEqual({ kind: 'waits', reason: 'not_filed' })
    // Nothing went into the Verlauf, so nobody is told it did.
    expect(announceAppended).not.toHaveBeenCalled()
  })

  it('belongs to its organization only', async () => {
    expect(await followMail('org_2', payload)).toEqual({ kind: 'waits', reason: 'not_waiting' })
    expectWaitsUntouched()
  })
})

describe('the run', () => {
  it('tries again shortly, spending no attempt, while another filing writes the thread', async () => {
    vi.mocked(runInboundMailFiling).mockResolvedValue({
      done: false,
      payload: { ...payload, mailIds: [MAIL_ID] },
      notBefore: new Date(),
    })
    const before = Date.now()
    const result = await runInboundMailFollow('org_1', payload)
    expect(result.done).toBe(false)
    expect(result.notBefore!.getTime()).toBeGreaterThanOrEqual(before + 10_000)
    expect(announceAppended).not.toHaveBeenCalled()
  })

  it('files a text it decided and could not finish on that decision, as its decider, without deciding again', async () => {
    given({}, { state: 'filing', decisionId: 'decision-1' }, [filePart()], new Map([[textPart().id, { ...decided, decidedBy: OTHER_FOLLOWER }]]))
    vi.mocked(resolvePinnedRequesterSessionStrict).mockResolvedValue({ ...follower, userId: OTHER_FOLLOWER })
    expect(await followMail('org_1', payload)).toEqual({ kind: 'appended' })
    expect(writeFollowDecision).not.toHaveBeenCalled()
    expect(resolvePinnedRequesterSessionStrict).toHaveBeenCalledWith({ userId: OTHER_FOLLOWER, email: null, organizationId: 'org_1' })
    expect(runInboundMailFiling).toHaveBeenCalledOnce()
    expect(vi.mocked(runInboundMailFiling).mock.calls[0]![1].decisionIds).toEqual(['decision-1'])
    // The thread is the decision's own, and the one told is its decider.
    expect(announceAppended).toHaveBeenCalledWith(expect.objectContaining({ threadId: THREAD_ID, followerUserId: OTHER_FOLLOWER }))
  })

  it('leaves a text a person is filing to their filing job', async () => {
    given({}, { state: 'filing', decisionId: 'decision-p' }, [], new Map([[textPart().id, { ...decided, via: 'app' }]]))
    expect(await followMail('org_1', payload)).toEqual({ kind: 'waits', reason: 'not_waiting' })
    expect(runInboundMailFiling).not.toHaveBeenCalled()
  })

  it('logs the mail and the outcome code, nothing of the mail’s own', async () => {
    const info = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    given({ senderAddress: 'canary-sender@leak.test', subject: 'Canary subject' }, {}, [], new Map())
    await runInboundMailFollow('org_1', payload)
    const line = info.mock.calls.map((call) => call.join(' ')).join('\n')
    expect(line).toContain(MAIL_ID)
    expect(line).not.toMatch(/canary|leak\.test/i)
    info.mockRestore()
  })
})
