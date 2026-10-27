/**
 * @vitest-environment node
 *
 * The archive import's half of one shape for mail (D33): what an archived
 * mail becomes as an entry, which Verlauf it may join, what its section says
 * about its attachments (D36), and how a slice renders each Verlauf it wrote
 * into once. The SQL is `archive.integration.spec.ts`'s, on Postgres.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('./write-repository', () => ({
  acquireRenderLease: vi.fn(async () => true),
  releaseRenderLease: vi.fn(async () => {}),
  findThreadRow: vi.fn(),
  findThreadEntryRows: vi.fn(async () => []),
  findEntryAttachmentRows: vi.fn(async () => new Map()),
  findWritableThread: vi.fn(async () => null),
  findCurrentVersions: vi.fn(async () => new Map()),
}))
vi.mock('./archive-repository', () => ({
  commitArchiveEntry: vi.fn(async () => 'committed'),
  commitArchiveRender: vi.fn(async () => {}),
  findArchiveEntry: vi.fn(async () => null),
  findEntryWithMessageId: vi.fn(async () => null),
  findPendingThreadsOfImport: vi.fn(async () => []),
  giveUpPendingRender: vi.fn(async () => {}),
  importWroteInto: vi.fn(async () => false),
  threadHoldingDocument: vi.fn(async () => false),
}))
vi.mock('./append', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./append')>()
  return { ...actual, uploadThreadVersion: vi.fn() }
})
vi.mock('@/lib/inbound-mail/repository', () => ({ findThreadCandidates: vi.fn(async () => []) }))
vi.mock('@/lib/authz/folder-access', () => ({ canWriteFolder: vi.fn(async () => true) }))
vi.mock('@/lib/authz/folder-access-repository', () => ({ listProjectFolderTree: vi.fn(async () => []) }))

import type { AuthorizedSession } from '@/lib/auth/types'
import type { MailImport, MailImportSkipReason, MailThreadEntryRow, MailThreadRow } from '@/lib/db/schema'
import type { ArchiveMail } from '@/lib/mail-import/archive-client'
import { canWriteFolder } from '@/lib/authz/folder-access'
import { findThreadCandidates } from '@/lib/inbound-mail/repository'
import { chunkerReads } from '@/test-utils/markdown-chunker'
import { uploadThreadVersion } from './append'
import {
  appendArchiveEntry,
  archiveAttachmentRowsOf,
  archiveEntryIdOf,
  archiveEntryOf,
  archiveMessageOf,
  archiveThreadIdOf,
  archiveThreadMatches,
  counterpartOf,
  FolderTree,
  NOT_FILED_REASON_OF_SKIP,
  renderPendingThreads,
  type ArchiveFiling,
} from './archive'
import {
  commitArchiveEntry,
  commitArchiveRender,
  findArchiveEntry,
  findEntryWithMessageId,
  findPendingThreadsOfImport,
  giveUpPendingRender,
  importWroteInto,
  threadHoldingDocument,
} from './archive-repository'
import type { ThreadCandidate } from './mail-threading'
import { MAIL_THREAD_ATTACHMENT_NOT_FILED_REASONS } from './mail-thread-vocabulary'
import { mailThreadEntryHeading, renderMailThread } from './render'
import { renderEntryOf } from './append'
import {
  acquireRenderLease,
  findThreadEntryRows,
  findThreadRow,
  findWritableThread,
  releaseRenderLease,
} from './write-repository'

const IMPORT = { id: '11111111-1111-4111-8111-111111111111', organizationId: 'org_1', projectId: 'p1', userId: 'user_anna', userEmail: 'anna@buero.at', createdAt: new Date('2026-10-01T00:00:00Z') }
const session = { userId: 'user_anna', organizationId: 'org_1' } as AuthorizedSession

const mail: ArchiveMail = {
  kind: 'mail',
  position: 4,
  message_class: 'IPM.Note',
  folder_path: ['Posteingang'],
  subject: 'AW: Stellplatznachweis',
  sender: { name: 'Mag. Huber', address: 'Huber@MA37.Wien.gv.at' },
  to: [{ name: 'Anna Berger', address: 'anna@buero.at' }],
  cc: [{ name: '', address: 'statik@weber.at' }],
  bcc: [{ name: 'Geheim', address: 'geheim@buero.at' }],
  sent_at: '2026-05-12T07:10:00Z',
  received_at: '2026-05-12T07:12:00Z',
  message_id: '<Abc.1@MA37.Wien.gv.at>',
  in_reply_to: '<first@buero.at>',
  references: '<root@buero.at> <first@buero.at>',
  conversation_index: null,
  body: { text: 'Bitte reichen Sie den Nachweis bis 29.05.2026 nach.', source: 'plain', truncated: false },
  attachments: [],
}

function filing(overrides: Partial<ArchiveFiling> = {}): ArchiveFiling {
  return {
    session,
    mailImport: IMPORT as unknown as MailImport,
    archiveFolderId: 'folder_archive',
    holder: '22222222-2222-4222-8222-222222222222',
    locale: 'de',
    folderTree: new FolderTree('org_1', 'p1'),
    request: new Request('http://bff-jobs.internal'),
    ...overrides,
  }
}

function candidate(overrides: Partial<ThreadCandidate>): ThreadCandidate {
  return {
    threadId: 't',
    baseSubject: 'stellplatznachweis',
    threadIndexGuid: null,
    receivedIds: [],
    referencedIds: [],
    participants: [],
    lastEntryAt: new Date('2026-05-10T00:00:00Z'),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('an archived mail as an entry', () => {
  it('normalizes its ids and subject the way inbound mail is keyed, and keeps no Bcc', () => {
    const message = archiveMessageOf(mail, IMPORT.createdAt)
    expect(message.messageId).toBe('Abc.1@ma37.wien.gv.at')
    expect(message.inReplyTo).toEqual(['first@buero.at'])
    expect(message.references).toEqual(['root@buero.at', 'first@buero.at'])
    expect(message.baseSubject).toBe('stellplatznachweis')
    expect(message.participants.map((p) => `${p.role}:${p.address}`)).toEqual([
      'from:Huber@MA37.Wien.gv.at',
      'to:anna@buero.at',
      'cc:statik@weber.at',
    ])
    expect(JSON.stringify(message)).not.toContain('geheim')
  })

  it('derives the Outlook conversation GUID from the conversation index, as from a Thread-Index header', () => {
    const index = Buffer.from([1, 2, 3, 4, 5, 6, ...Array.from({ length: 16 }, (_, i) => i + 16)]).toString('base64')
    expect(archiveMessageOf({ ...mail, conversation_index: index }, IMPORT.createdAt).threadIndexGuid).toBe(
      '10111213-1415-1617-1819-1a1b1c1d1e1f',
    )
  })

  it('takes the send time for a sent item’s receipt, and the import’s start for a mail without any date', () => {
    const sent = archiveMessageOf({ ...mail, received_at: null }, IMPORT.createdAt)
    expect(sent.receivedAt.toISOString()).toBe('2026-05-12T07:10:00.000Z')
    const undated = archiveMessageOf({ ...mail, sent_at: null, received_at: 'not a date' }, IMPORT.createdAt)
    expect(undated.receivedAt).toEqual(IMPORT.createdAt)
    expect(undated.sentAt).toEqual(IMPORT.createdAt)
  })

  it('claims nothing it did not check: not_checked, filed by the import as the person, no signer, no original', () => {
    const message = archiveMessageOf(mail, IMPORT.createdAt)
    const entry = archiveEntryOf({
      id: archiveEntryIdOf(IMPORT.id, 4),
      threadId: 't',
      mailImport: IMPORT,
      message,
      heading: 'h',
      inReplyToEntryId: null,
      filedAt: new Date(),
    })
    expect(entry).toMatchObject({
      source: 'archive',
      senderTrust: 'not_checked',
      filedVia: 'archive_import',
      filedBy: 'user_anna',
      mailImportId: IMPORT.id,
      inboundMailId: null,
      signerDomain: null,
      authenticationResults: null,
      senderDomain: 'ma37.wien.gv.at',
      messageId: 'Abc.1@ma37.wien.gv.at',
    })
    expect(entry).not.toHaveProperty('originalStorageKey')
  })

  it('gives a mail the same entry and the same new Verlauf on every retry, and another mail other ones', () => {
    expect(archiveEntryIdOf(IMPORT.id, 4)).toBe(archiveEntryIdOf(IMPORT.id, 4))
    expect(archiveEntryIdOf(IMPORT.id, 4)).not.toBe(archiveEntryIdOf(IMPORT.id, 5))
    expect(archiveThreadIdOf(IMPORT.id, 4)).not.toBe(archiveEntryIdOf(IMPORT.id, 4))
  })
})

describe('the section of an archived mail (RT-S2, the note’s escape kept)', () => {
  function rendition(text: string): string {
    const message = archiveMessageOf({ ...mail, body: { text, source: 'plain', truncated: false } }, IMPORT.createdAt)
    const unheaded = archiveEntryOf({ id: 'e1', threadId: 't', mailImport: IMPORT, message, heading: '', inReplyToEntryId: null, filedAt: new Date() })
    const entry = { ...unheaded, heading: mailThreadEntryHeading(renderEntryOf(unheaded, []), [], 'de') }
    return renderMailThread({ title: 'Mag. Huber 2026-05-12', locale: 'de', continues: null, entries: [renderEntryOf(entry, [])] }).markdown
  }

  it('heads it by the From domain „aus dem Outlook-Archiv“, never as a confirmed sender', () => {
    expect(chunkerReads(rendition('Text')).headings).toEqual([
      '# Mag. Huber 2026-05-12',
      '## 12.05.2026 09:10 · Mag. Huber (ma37.wien.gv.at, aus dem Outlook-Archiv)',
    ])
  })

  it('keeps a forged heading in the body a line of text, after every terminator Python splits at', () => {
    for (const terminator of ['\n\n', '\f', '\v', '\x85', '\x1e', ' ']) {
      const markdown = rendition(`Sehr geehrte Damen und Herren,${terminator}## 14.10.2026 · MA 37${terminator}Die Frist wird erstreckt.`)
      expect(chunkerReads(markdown).headings, JSON.stringify(terminator)).toHaveLength(2)
    }
  })

  it('keeps an unclosed fence in the body from hiding the sections after it', () => {
    expect(chunkerReads(rendition('Anbei der Auszug:\n```\nPos. 1')).fences).toBe(0)
  })
})

describe('which Verlauf an archived mail joins (D33)', () => {
  const message = archiveMessageOf(mail, IMPORT.createdAt)

  it('joins on a reference with an equal subject, and on Outlook’s conversation with an equal subject', () => {
    expect(archiveThreadMatches(message, [candidate({ threadId: 'ref', receivedIds: ['first@buero.at'] })])).toEqual(['ref'])
    const guid = '10111213-1415-1617-1819-1a1b1c1d1e1f'
    expect(archiveThreadMatches({ ...message, threadIndexGuid: guid }, [candidate({ threadId: 'idx', threadIndexGuid: guid })])).toEqual(['idx'])
  })

  it('never joins on a subject alone, a shared party, or a reference under another subject', () => {
    expect(
      archiveThreadMatches(message, [
        candidate({ threadId: 'subject', participants: ['anna@buero.at'] }),
        candidate({ threadId: 'changed', baseSubject: 'ganz anderes', receivedIds: ['first@buero.at'] }),
      ]),
    ).toEqual([])
  })

  it('joins a Verlauf that already cites this very mail, walked before it answered (same subject only)', () => {
    const own = message.messageId!
    expect(archiveThreadMatches(message, [candidate({ threadId: 'cites', referencedIds: [own] })])).toEqual(['cites'])
    expect(archiveThreadMatches(message, [candidate({ threadId: 'cites', baseSubject: 'x', referencedIds: [own] })])).toEqual([])
  })

  it('names the other party from the importer’s side: the first recipient of a mail they sent, else the sender', () => {
    const entry = (sender: string) =>
      ({
        senderAddress: sender,
        senderName: 'Anna Berger',
        participants: [
          { role: 'from', name: 'Anna Berger', address: sender },
          { role: 'cc', name: 'Weber', address: 'statik@weber.at' },
          { role: 'to', name: 'MA 37', address: 'post@ma37.wien.gv.at' },
        ],
      }) as Pick<MailThreadEntryRow, 'senderAddress' | 'senderName' | 'participants'>
    expect(counterpartOf(entry('Anna@Buero.at'), 'anna@buero.at')).toEqual({ name: 'MA 37', address: 'post@ma37.wien.gv.at' })
    expect(counterpartOf(entry('huber@ma37.wien.gv.at'), 'anna@buero.at')).toEqual({ name: 'Anna Berger', address: 'huber@ma37.wien.gv.at' })
    expect(counterpartOf({ senderAddress: null, senderName: null, participants: [] }, null)).toBeNull()
  })
})

describe('what came with an archived mail (D36)', () => {
  const rows = (visible: boolean) =>
    archiveAttachmentRowsOf({
      entryId: 'e1',
      organizationId: 'org_1',
      projectId: 'p1',
      outcomes: [
        { index: 0, filename: 'Plan.pdf', filed: true, documentId: 'd1', documentName: 'M – Plan.pdf', folderId: 'f1' },
        { index: 1, filename: 'Fwd', filed: false, reason: 'embedded_message' },
        { index: 2, filename: 'Vertrag.pdf', filed: false, reason: 'screened' },
        { index: 3, filename: 'x.exe', filed: false, reason: 'type' },
        { index: 4, filename: 'Gone.pdf', filed: true, documentId: 'd_gone', documentName: 'M – Gone.pdf', folderId: 'f1' },
      ],
      versions: new Map([['d1', 'v1']]),
      folderPaths: new Map([['f1', 'E-Mail-Import/Büro/M']]),
      visibleWithThread: () => visible,
    })

  it('writes one row per attachment whatever became of it, naming a filed one only beside a Verlauf as visible', () => {
    expect(rows(true)).toEqual([
      expect.objectContaining({ position: 0, disposition: 'filed', documentId: 'd1', documentVersionId: 'v1', sectionName: 'M – Plan.pdf', sectionFolderPath: 'E-Mail-Import/Büro/M' }),
      expect.objectContaining({ position: 1, disposition: 'not_filed', notFiledReason: 'unreadable', filename: 'Fwd' }),
      expect.objectContaining({ position: 2, disposition: 'not_filed', notFiledReason: 'screened', filename: 'Vertrag.pdf' }),
      expect.objectContaining({ position: 3, disposition: 'not_filed', notFiledReason: 'type_not_accepted' }),
      // Gone (or unreadable for the importer) since it was filed: the row says it came, names nothing.
      expect.objectContaining({ position: 4, disposition: 'filed', documentId: null, documentVersionId: null, sectionName: null }),
    ])
    for (const row of rows(true).filter((row) => row.disposition === 'not_filed')) {
      expect(row).not.toHaveProperty('sectionName')
    }
  })

  it('counts, never names, an attachment in a folder fewer people read than the Verlauf (RT-S13)', () => {
    expect(rows(false)[0]).toMatchObject({ disposition: 'filed', documentId: 'd1', sectionName: null, sectionFolderPath: null })
  })

  it('maps every skip of the import to a reason the table holds', () => {
    const skips: MailImportSkipReason[] = ['embedded_message', 'type', 'size', 'unreadable', 'screened', 'access', 'name_taken']
    for (const skip of skips) expect(MAIL_THREAD_ATTACHMENT_NOT_FILED_REASONS).toContain(NOT_FILED_REASON_OF_SKIP[skip])
  })
})

describe('appendArchiveEntry', () => {
  const pendingThread = { id: 'own', documentId: null, renderPendingAt: new Date(), locale: 'de' } as unknown as MailThreadRow

  it('skips a text the project already holds by Message-ID, writing nothing', async () => {
    vi.mocked(findEntryWithMessageId).mockResolvedValueOnce({ entryId: 'e_inbound', threadId: 't_inbound' })
    expect(await appendArchiveEntry(filing(), mail, { outcomes: [], folder: null })).toEqual({ kind: 'already_in_project' })
    expect(findEntryWithMessageId).toHaveBeenCalledWith('p1', 'Abc.1@ma37.wien.gv.at', archiveEntryIdOf(IMPORT.id, 4))
    expect(commitArchiveEntry).not.toHaveBeenCalled()
  })

  it('finds a retried mail’s own entry and writes nothing again', async () => {
    vi.mocked(findArchiveEntry).mockResolvedValueOnce({ id: archiveEntryIdOf(IMPORT.id, 4), threadId: archiveThreadIdOf(IMPORT.id, 4) })
    expect(await appendArchiveEntry(filing(), mail, { outcomes: [], folder: null })).toMatchObject({ kind: 'filed', threadCreated: true })
    expect(findEntryWithMessageId).not.toHaveBeenCalled()
    expect(commitArchiveEntry).not.toHaveBeenCalled()
  })

  it('opens a Verlauf of its own in the archive’s folder when nothing matches, waiting for its first Fassung', async () => {
    expect(await appendArchiveEntry(filing(), mail, { outcomes: [], folder: null })).toEqual({
      kind: 'filed',
      threadId: archiveThreadIdOf(IMPORT.id, 4),
      threadCreated: true,
      threadJoined: false,
    })
    const commit = vi.mocked(commitArchiveEntry).mock.calls[0][0]
    expect(commit.newThread).toMatchObject({ id: archiveThreadIdOf(IMPORT.id, 4), documentId: null, locale: 'de', createdBy: 'user_anna', baseSubject: 'stellplatznachweis' })
    expect(commit.entry).toMatchObject({ threadId: archiveThreadIdOf(IMPORT.id, 4), heading: '12.05.2026 09:10 · Mag. Huber (ma37.wien.gv.at, aus dem Outlook-Archiv)' })
    expect(commit.messageIds).toEqual({ received: 'Abc.1@ma37.wien.gv.at', referenced: ['first@buero.at', 'root@buero.at', 'first@buero.at'] })
    // The lease is the writers' of a Verlauf that exists; nobody else can see this one yet.
    expect(acquireRenderLease).not.toHaveBeenCalled()
  })

  it('joins a matching Verlauf under its lease, headed against every heading it has', async () => {
    vi.mocked(findThreadCandidates).mockResolvedValueOnce([candidate({ threadId: 'match', receivedIds: ['first@buero.at'] })])
    vi.mocked(findThreadRow).mockResolvedValue({ id: 'match', documentId: 'doc', locale: 'de', renderPendingAt: null } as unknown as MailThreadRow)
    vi.mocked(findWritableThread).mockResolvedValueOnce({ thread: {} as MailThreadRow, document: { id: 'doc', filename: 'Stellplatz.md', folderId: null, contentHash: null } })
    // An earlier copy of the same mail under another Message-ID: same minute, same sender, same heading.
    const earlier = archiveEntryOf({
      id: 'e0',
      threadId: 'match',
      mailImport: IMPORT,
      message: archiveMessageOf(mail, IMPORT.createdAt),
      heading: '12.05.2026 09:10 · Mag. Huber (ma37.wien.gv.at, aus dem Outlook-Archiv)',
      inReplyToEntryId: null,
      filedAt: new Date('2026-10-01T00:00:00Z'),
    }) as MailThreadEntryRow
    vi.mocked(findThreadEntryRows).mockResolvedValueOnce([earlier])

    const outcome = await appendArchiveEntry(filing(), mail, { outcomes: [], folder: null })
    expect(outcome).toEqual({ kind: 'filed', threadId: 'match', threadCreated: false, threadJoined: true })
    expect(acquireRenderLease).toHaveBeenCalledWith('match', filing().holder, expect.any(Date))
    expect(vi.mocked(commitArchiveEntry).mock.calls[0][0]).toMatchObject({
      newThread: null,
      entry: { threadId: 'match', heading: '12.05.2026 09:10 · Mag. Huber (ma37.wien.gv.at, aus dem Outlook-Archiv) (2)' },
    })
    expect(releaseRenderLease).toHaveBeenCalledWith('match', filing().holder)
    expect(importWroteInto).toHaveBeenCalledWith('match', IMPORT.id, archiveEntryIdOf(IMPORT.id, 4))
    vi.mocked(findThreadRow).mockReset()
  })

  it('never appends into a Verlauf the person may not write: it opens its own instead', async () => {
    vi.mocked(findThreadCandidates).mockResolvedValueOnce([candidate({ threadId: 'match', receivedIds: ['first@buero.at'] })])
    vi.mocked(findThreadRow).mockResolvedValue({ id: 'match', documentId: 'doc', locale: 'de' } as unknown as MailThreadRow)
    vi.mocked(findWritableThread).mockResolvedValueOnce({ thread: {} as MailThreadRow, document: { id: 'doc', filename: 'S.md', folderId: 'f_read_only', contentHash: null } })
    vi.mocked(canWriteFolder).mockResolvedValueOnce(false)

    const outcome = await appendArchiveEntry(filing(), mail, { outcomes: [], folder: null })
    expect(outcome).toMatchObject({ threadId: archiveThreadIdOf(IMPORT.id, 4), threadCreated: true })
    expect(canWriteFolder).toHaveBeenCalledWith(session, 'p1', 'f_read_only')
    expect(releaseRenderLease).toHaveBeenCalledWith('match', filing().holder)
    vi.mocked(findThreadRow).mockReset()
  })

  it('never appends into a Verlauf the person cannot read, nor into one that is full', async () => {
    vi.mocked(findThreadCandidates).mockResolvedValueOnce([
      candidate({ threadId: 'hidden', receivedIds: ['first@buero.at'] }),
      candidate({ threadId: 'full', receivedIds: ['first@buero.at'] }),
    ])
    vi.mocked(findThreadRow).mockImplementation(async (_p, id) => ({ id, documentId: `doc_${id}`, locale: 'de' }) as unknown as MailThreadRow)
    vi.mocked(findWritableThread).mockImplementation(async (_p, id) =>
      id === 'hidden' ? null : { thread: {} as MailThreadRow, document: { id: 'doc_full', filename: 'F.md', folderId: null, contentHash: null } },
    )
    vi.mocked(findThreadEntryRows).mockResolvedValueOnce(Array.from({ length: 200 }, () => ({}) as MailThreadEntryRow))

    expect(await appendArchiveEntry(filing(), mail, { outcomes: [], folder: null })).toMatchObject({ threadCreated: true })
    vi.mocked(findThreadRow).mockReset()
    vi.mocked(findWritableThread).mockReset()
  })

  it('answers busy when another writer keeps the Verlauf it belongs in, writing nothing', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(findThreadCandidates).mockResolvedValueOnce([candidate({ threadId: 'match', receivedIds: ['first@buero.at'] })])
      vi.mocked(acquireRenderLease).mockResolvedValue(false)
      const pending = appendArchiveEntry(filing(), mail, { outcomes: [], folder: null })
      await vi.advanceTimersByTimeAsync(20_000)
      expect(await pending).toEqual({ kind: 'busy' })
      expect(commitArchiveEntry).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
      vi.mocked(acquireRenderLease).mockResolvedValue(true)
    }
  })

  it('joins the Verlauf it opened earlier in the slice, before it has a document', async () => {
    vi.mocked(findThreadCandidates).mockResolvedValueOnce([candidate({ threadId: 'own', receivedIds: ['first@buero.at'] })])
    vi.mocked(findThreadRow).mockResolvedValue(pendingThread)

    expect(await appendArchiveEntry(filing(), mail, { outcomes: [], folder: null })).toMatchObject({ threadId: 'own', threadCreated: false })
    expect(findThreadCandidates).toHaveBeenCalledWith('p1', expect.anything(), { pendingOfImport: IMPORT.id })
    expect(findWritableThread).not.toHaveBeenCalled()
    vi.mocked(findThreadRow).mockReset()
  })
})

describe('renderPendingThreads: one Fassung per Verlauf per slice', () => {
  const target = (deadline = Date.now() + 60_000) => ({
    uploadBatchId: vi.fn(async () => 'batch_threads'),
    counted: vi.fn(),
    deadline,
  })
  const row = (overrides: Partial<MailThreadRow> = {}) =>
    ({ id: 'own', documentId: null, renderPendingAt: new Date(), locale: 'de', participantDomains: [], ...overrides }) as MailThreadRow
  const entryRow = archiveEntryOf({
    id: 'e1',
    threadId: 'own',
    mailImport: IMPORT,
    message: archiveMessageOf(mail, IMPORT.createdAt),
    heading: '12.05.2026 09:10 · Mag. Huber (ma37.wien.gv.at, aus dem Outlook-Archiv)',
    inReplyToEntryId: null,
    filedAt: new Date('2026-10-01T00:00:00Z'),
  }) as MailThreadEntryRow

  beforeEach(() => {
    // A test that failed must not leave its queued answers to the next one.
    vi.mocked(uploadThreadVersion).mockReset()
    vi.mocked(threadHoldingDocument).mockReset().mockResolvedValue(false)
    vi.mocked(findPendingThreadsOfImport).mockResolvedValue([row()])
    vi.mocked(findThreadRow).mockResolvedValue(row())
    vi.mocked(findThreadEntryRows).mockResolvedValue([entryRow])
  })

  it('uploads a new Verlauf once, named after the other party and the day, into the archive’s folder at bulk priority', async () => {
    vi.mocked(uploadThreadVersion).mockResolvedValueOnce({ ok: true, documentId: 'doc_new', versionId: 'v1' })
    const result = await renderPendingThreads(filing(), target())

    expect(result).toEqual({ rendered: 1, waiting: 0, skipped: [], quotaFull: false })
    expect(uploadThreadVersion).toHaveBeenCalledOnce()
    expect(vi.mocked(uploadThreadVersion).mock.calls[0][0]).toMatchObject({
      filename: 'Mag. Huber 2026-05-12.md',
      folderId: 'folder_archive',
      current: null,
      screeningRelease: false,
      uploadBatchId: 'batch_threads',
      priority: 'bulk',
      facts: { message_count: 1, locale: 'de' },
    })
    expect(commitArchiveRender).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'own', documentId: 'doc_new', versionId: 'v1', entryCount: 1 }))
    expect(releaseRenderLease).toHaveBeenCalledWith('own', filing().holder)
  })

  it('numbers the name another document of the project holds, and never shares another Verlauf’s document', async () => {
    vi.mocked(uploadThreadVersion)
      .mockResolvedValueOnce({ ok: false, failure: 'name_taken' })
      .mockResolvedValueOnce({ ok: true, documentId: 'doc_other_thread', versionId: 'v' })
      .mockResolvedValueOnce({ ok: true, documentId: 'doc_3', versionId: 'v3' })
    vi.mocked(threadHoldingDocument).mockResolvedValueOnce(true).mockResolvedValueOnce(false)

    await renderPendingThreads(filing(), target())
    expect(vi.mocked(uploadThreadVersion).mock.calls.map(([upload]) => upload.filename)).toEqual([
      'Mag. Huber 2026-05-12.md',
      'Mag. Huber 2026-05-12 (2).md',
      'Mag. Huber 2026-05-12 (3).md',
    ])
    expect(commitArchiveRender).toHaveBeenCalledWith(expect.objectContaining({ documentId: 'doc_3' }))
  })

  it('writes the next Fassung of a Verlauf that was there under its own name, keeping its parties', async () => {
    vi.mocked(findThreadRow).mockResolvedValue(row({ documentId: 'doc', participantDomains: ['buero.at'] }))
    vi.mocked(findWritableThread).mockResolvedValueOnce({ thread: {} as MailThreadRow, document: { id: 'doc', filename: 'Stellplatz.md', folderId: 'f', contentHash: 'h' } })
    vi.mocked(uploadThreadVersion).mockResolvedValueOnce({ ok: true, documentId: 'doc', versionId: 'v2' })

    await renderPendingThreads(filing(), target())
    expect(vi.mocked(uploadThreadVersion).mock.calls[0][0]).toMatchObject({ filename: 'Stellplatz.md', folderId: 'f', current: { id: 'doc' } })
    expect(commitArchiveRender).toHaveBeenCalledWith(expect.objectContaining({ participantDomains: ['buero.at'] }))
  })

  it('gives up a Verlauf the upload path refuses for good, and names it for the import', async () => {
    vi.mocked(uploadThreadVersion).mockResolvedValueOnce({ ok: false, failure: 'screened' })
    const result = await renderPendingThreads(filing(), target())
    expect(result.skipped).toEqual([{ name: 'Mag. Huber 2026-05-12', reason: 'screened' }])
    expect(giveUpPendingRender).toHaveBeenCalledWith('own')
    expect(commitArchiveRender).not.toHaveBeenCalled()
  })

  it('says the storage is full and leaves the Verlauf pending', async () => {
    vi.mocked(uploadThreadVersion).mockResolvedValueOnce({ ok: false, failure: 'quota' })
    expect(await renderPendingThreads(filing(), target())).toMatchObject({ quotaFull: true })
    expect(giveUpPendingRender).not.toHaveBeenCalled()
  })

  it('leaves a Verlauf another writer holds, or one the slice has no time for, to the next slice', async () => {
    vi.mocked(acquireRenderLease).mockResolvedValueOnce(false)
    expect(await renderPendingThreads(filing(), target())).toMatchObject({ rendered: 0, waiting: 1 })
    expect(await renderPendingThreads(filing(), target(Date.now() - 1))).toMatchObject({ rendered: 0, waiting: 1 })
    expect(uploadThreadVersion).not.toHaveBeenCalled()
  })

  it('renders nothing when a Verlauf was rendered meanwhile (another writer took its entries along)', async () => {
    vi.mocked(findThreadRow).mockResolvedValue(row({ renderPendingAt: null }))
    expect(await renderPendingThreads(filing(), target())).toMatchObject({ rendered: 0, waiting: 0 })
    expect(uploadThreadVersion).not.toHaveBeenCalled()
  })
})
