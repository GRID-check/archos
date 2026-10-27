/**
 * @vitest-environment node
 *
 * The Outlook archive's mails written into E-Mail-Verläufe (D33), against a
 * REAL Postgres with migration 0188, through the restricted runtime role
 * (`scripts/rls-test-db.sh`):
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/mail-thread/archive.integration.spec.ts
 *
 * DECISION §10's three promises, each as SQL rather than a mocked handle:
 * Message-ID dedupe both ways (an archive mail the project's address already
 * filed is skipped, and an inbound mail an archive entry holds is found as
 * one); one Fassung per Verlauf per slice (a conversation of three mails is
 * one upload, and the next slice's Fassung holds every section of the last);
 * and no append into a Verlauf the person may not write. Also: a retried mail
 * writes nothing twice, a Verlauf another writer holds answers busy, every
 * attachment is a row (D36), and the import's counts add up and refuse to go
 * negative.
 *
 * The upload path is the one piece stood in: it writes the document and its
 * Fassung as rows, with the bytes' digest, as `uploadDocument` would, without
 * an object store or an ingest.
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

/** What the stand-in upload was handed, in order. */
const uploads = vi.hoisted(() => [] as Array<{ filename: string; folderId: string | null; text: string; batch: string | null }>)
vi.mock('@/lib/documents/service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/documents/service')>()
  return {
    ...actual,
    uploadDocument: vi.fn(async (session: { userId: string; organizationId: string }, input: {
      projectId: string
      folderId: string | null
      file: File
      uploadBatchId?: string | null
    }) => {
      const { getDb } = await import('@/lib/db')
      const { contentDigest } = await import('@/lib/documents/content-digest')
      const bytes = new Uint8Array(await input.file.arrayBuffer())
      const digest = contentDigest(Buffer.from(bytes))
      const text = new TextDecoder().decode(bytes)
      uploads.push({ filename: input.file.name, folderId: input.folderId, text, batch: input.uploadBatchId ?? null })
      const db = getDb()
      const [held] = Array.from(
        await db.execute(sql`SELECT id FROM documents WHERE project_id = ${input.projectId}::uuid AND filename = ${input.file.name} LIMIT 1`),
      ) as Array<{ id: string }>
      let documentId = held?.id
      if (!documentId) {
        const [created] = Array.from(
          await db.execute(sql`
            INSERT INTO documents (organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id, folder_id, content_hash)
            VALUES (${session.organizationId}, ${session.userId}, ${input.file.name}, ${`k/${digest}`}, 'coll_archive', 'completed', 'project',
                    ${input.projectId}::uuid, ${input.folderId}::uuid, ${digest})
            RETURNING id`),
        ) as Array<{ id: string }>
        documentId = created.id
      } else {
        await db.execute(sql`UPDATE documents SET content_hash = ${digest} WHERE id = ${documentId}::uuid`)
      }
      await db.execute(sql`
        INSERT INTO document_versions (organization_id, document_id, project_id, version_number, state, storage_key, created_by, approved_by, approved_at)
        SELECT ${session.organizationId}, ${documentId}::uuid, ${input.projectId}::uuid, coalesce(max(version_number), 0) + 1, 'superseded',
               ${`k/${digest}/v`}, ${session.userId}, ${session.userId}, now()
          FROM document_versions WHERE document_id = ${documentId}::uuid`)
      return { documentId, jobId: null, status: 'uploaded', filename: input.file.name }
    }),
  }
})
const writable = vi.hoisted(() => ({ folders: new Set<string | null>([null]) }))
vi.mock('@/lib/authz/folder-access', () => ({
  canWriteFolder: vi.fn(async (_session: unknown, _project: string, folderId: string | null) => writable.folders.has(folderId)),
}))

const url = process.env.GRID_TEST_DATABASE_URL
const STAMP = Date.now().toString(36)
const ORG = `org_mail_archive_${STAMP}`
const USER = 'user_01J0ARCHIVESPEC0000000000A'

describe.skipIf(!url)('the archive import’s Verläufe against Postgres (D33)', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let withPlatformAccess: typeof import('@/lib/db/tenant-context').withPlatformAccess
  let archive: typeof import('./archive')
  let write: typeof import('./write-repository')
  let inbound: typeof import('@/lib/inbound-mail/repository')
  let imports: typeof import('@/lib/mail-import/repository')
  let projectId: string
  let archiveFolder: string
  let readOnlyFolder: string
  let importId: string

  const inTenant = <T>(run: () => Promise<T>): Promise<T> => withTenant({ organizationId: ORG, userId: USER }, run)
  async function rows<T>(statement: ReturnType<typeof sql>): Promise<T[]> {
    return Array.from(await inTenant(() => db.execute(statement))) as T[]
  }
  const one = async <T>(statement: ReturnType<typeof sql>): Promise<T> => (await rows<T>(statement))[0] as T

  const session = { userId: USER, organizationId: ORG, email: 'anna@buero.at' } as import('@/lib/auth/types').AuthorizedSession

  function filing(holder = crypto.randomUUID()): import('./archive').ArchiveFiling {
    return {
      session,
      mailImport: { id: importId, organizationId: ORG, projectId, userId: USER, userEmail: 'anna@buero.at', createdAt: new Date('2026-10-01T00:00:00Z') },
      archiveFolderId: archiveFolder,
      holder,
      locale: 'de',
      folderTree: new archive.FolderTree(ORG, projectId),
      request: new Request('http://bff-jobs.internal/mail-import'),
    }
  }
  const renderTarget = () => ({ uploadBatchId: async () => null as unknown as string, counted: () => {}, deadline: Date.now() + 60_000 })

  let position = 0
  /** An archived mail of the conversation `subject`, its Message-ID `id`, answering `answers`. */
  function archived(id: string, overrides: Partial<import('@/lib/mail-import/archive-client').ArchiveMail> = {}): import('@/lib/mail-import/archive-client').ArchiveMail {
    position += 1
    return {
      kind: 'mail',
      position,
      message_class: 'IPM.Note',
      folder_path: ['Posteingang'],
      subject: 'Stellplatznachweis',
      sender: { name: 'Mag. Huber', address: 'huber@ma37.wien.gv.at' },
      to: [{ name: 'Anna Berger', address: 'anna@buero.at' }],
      cc: [],
      bcc: [],
      sent_at: new Date(Date.parse('2026-05-12T07:00:00Z') + position * 60_000).toISOString(),
      received_at: new Date(Date.parse('2026-05-12T07:00:30Z') + position * 60_000).toISOString(),
      message_id: `<${id}@ma37.wien.gv.at>`,
      in_reply_to: null,
      references: null,
      conversation_index: null,
      body: { text: `Text der E-Mail ${id}.`, source: 'plain', truncated: false },
      attachments: [],
      ...overrides,
    }
  }

  const append = (mail: import('@/lib/mail-import/archive-client').ArchiveMail, options: {
    filing?: import('./archive').ArchiveFiling
    outcomes?: readonly import('./archive').ArchiveAttachmentOutcome[]
  } = {}) => inTenant(() => archive.appendArchiveEntry(options.filing ?? filing(), mail, { outcomes: options.outcomes ?? [], folder: null }))

  const render = (holder?: string) => inTenant(() => archive.renderPendingThreads(filing(holder), renderTarget()))

  /** A Verlauf of the project's address, with one inbound entry received as `messageId`, its document in `folderId`. */
  async function inboundThread(name: string, messageId: string, folderId: string | null = null): Promise<{ threadId: string; documentId: string }> {
    const { mailThreadEntries, mailThreads, mailThreadMessageIds } = await import('@/lib/db/schema')
    const { renderEntryOf } = await import('./append')
    const { mailThreadEntryHeading } = await import('./render')
    const documentId = (
      await one<{ id: string }>(sql`
        INSERT INTO documents (organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id, folder_id)
        VALUES (${ORG}, ${USER}, ${name}, ${`k/${STAMP}/${name}`}, 'coll_archive', 'completed', 'project', ${projectId}::uuid, ${folderId}::uuid)
        RETURNING id`)
    ).id
    await rows(sql`
      INSERT INTO document_versions (organization_id, document_id, project_id, version_number, state, storage_key, created_by, approved_by, approved_at)
      VALUES (${ORG}, ${documentId}::uuid, ${projectId}::uuid, 1, 'superseded', ${`k/${STAMP}/${name}/v1`}, ${USER}, ${USER}, now())`)
    const threadId = crypto.randomUUID()
    const entry = {
      id: crypto.randomUUID(),
      organizationId: ORG,
      projectId,
      threadId,
      source: 'inbound' as const,
      inboundMailId: crypto.randomUUID(),
      messageId,
      sentAt: new Date('2026-05-12T06:00:00Z'),
      receivedAt: new Date('2026-05-12T06:01:00Z'),
      heading: '',
      senderAddress: 'huber@ma37.wien.gv.at',
      senderName: 'Mag. Huber',
      senderDomain: 'ma37.wien.gv.at',
      signerDomain: 'ma37.wien.gv.at',
      senderTrust: 'external_verified' as const,
      ownText: 'Erste Nachricht.',
      filedBy: USER,
      filedVia: 'app' as const,
      filedAt: new Date('2026-05-12T06:02:00Z'),
    }
    entry.heading = mailThreadEntryHeading(renderEntryOf(entry, []), [], 'de')
    await inTenant(async () => {
      await db.insert(mailThreads).values({ id: threadId, organizationId: ORG, projectId, documentId, baseSubject: 'stellplatznachweis', locale: 'de', createdBy: USER, entryCount: 1, participantDomains: ['ma37.wien.gv.at'] })
      await db.insert(mailThreadEntries).values(entry)
      await db.insert(mailThreadMessageIds).values({ organizationId: ORG, projectId, threadId, entryId: entry.id, messageId, state: 'received' })
    })
    return { threadId, documentId }
  }

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    const context = await import('@/lib/db/tenant-context')
    withTenant = context.withTenant
    withPlatformAccess = context.withPlatformAccess
    db = (await import('@/lib/db')).getDb()
    archive = await import('./archive')
    write = await import('./write-repository')
    inbound = await import('@/lib/inbound-mail/repository')
    imports = await import('@/lib/mail-import/repository')

    projectId = (
      await one<{ id: string }>(sql`
        INSERT INTO projects (organization_id, name, created_by, collection_name)
        VALUES (${ORG}, 'Hubergasse 14', ${USER}, ${`coll_archive_${STAMP}`}) RETURNING id`)
    ).id
    archiveFolder = (
      await one<{ id: string }>(sql`
        INSERT INTO project_folders (organization_id, project_id, name, path)
        VALUES (${ORG}, ${projectId}::uuid, 'E-Mail-Import', 'E-Mail-Import') RETURNING id`)
    ).id
    readOnlyFolder = (
      await one<{ id: string }>(sql`
        INSERT INTO project_folders (organization_id, project_id, name, path)
        VALUES (${ORG}, ${projectId}::uuid, 'Behörde', 'Behörde') RETURNING id`)
    ).id
    writable.folders = new Set([null, archiveFolder])
  })

  beforeEach(() => {
    importId = crypto.randomUUID()
    uploads.length = 0
  })

  afterAll(async () => {
    // The project cascades to every row this spec wrote; the purge path is the platform's.
    await withPlatformAccess('test cleanup', () => db.execute(sql`DELETE FROM projects WHERE organization_id = ${ORG}`))
  })

  it('files a conversation of three mails into one new Verlauf, rendered once, each mail a section (one Fassung per slice)', async () => {
    const first = archived(`a1-${STAMP}`)
    const reply = archived(`a2-${STAMP}`, { subject: 'AW: Stellplatznachweis', in_reply_to: `<a1-${STAMP}@ma37.wien.gv.at>` })
    const third = archived(`a3-${STAMP}`, {
      subject: 'AW: AW: Stellplatznachweis',
      references: `<a1-${STAMP}@ma37.wien.gv.at> <a2-${STAMP}@ma37.wien.gv.at>`,
    })

    const opened = await append(first)
    expect(opened).toMatchObject({ kind: 'filed', threadCreated: true, threadJoined: false })
    if (opened.kind !== 'filed') throw new Error('not filed')
    expect(await append(reply)).toEqual({ kind: 'filed', threadId: opened.threadId, threadCreated: false, threadJoined: false })
    const attachmentDoc = (
      await one<{ id: string }>(sql`
        INSERT INTO documents (organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id, folder_id)
        VALUES (${ORG}, ${USER}, ${`M – Plan ${STAMP}.pdf`}, ${`k/${STAMP}/plan`}, 'coll_archive', 'completed', 'project', ${projectId}::uuid, ${archiveFolder}::uuid)
        RETURNING id`)
    ).id
    const planVersion = (
      await one<{ id: string }>(sql`
        INSERT INTO document_versions (organization_id, document_id, project_id, version_number, state, storage_key, created_by, approved_by, approved_at)
        VALUES (${ORG}, ${attachmentDoc}::uuid, ${projectId}::uuid, 1, 'superseded', ${`k/${STAMP}/plan/v1`}, ${USER}, ${USER}, now()) RETURNING id`)
    ).id
    await append(third, {
      outcomes: [
        { index: 0, filename: 'Plan.pdf', filed: true, documentId: attachmentDoc, documentName: `M – Plan ${STAMP}.pdf`, folderId: archiveFolder },
        { index: 1, filename: 'Vertrag.pdf', filed: false, reason: 'screened' },
      ],
    })

    // Nothing is rendered while the slice files: the Verlauf owes one Fassung.
    expect(uploads).toHaveLength(0)
    const pending = await one<{ document_id: string | null; pending: boolean }>(
      sql`SELECT document_id, render_pending_at IS NOT NULL AS pending FROM mail_threads WHERE id = ${opened.threadId}::uuid`,
    )
    expect(pending).toEqual({ document_id: null, pending: true })

    expect(await render()).toEqual({ rendered: 1, waiting: 0, skipped: [], quotaFull: false })
    expect(uploads).toHaveLength(1)
    expect(uploads[0].filename).toBe('Mag. Huber 2026-05-12.md')
    expect(uploads[0].folderId).toBe(archiveFolder)
    expect(uploads[0].text.match(/^## /gm)).toHaveLength(3)
    expect(uploads[0].text).toContain('aus dem Outlook-Archiv')
    expect(uploads[0].text).toContain(`M – Plan ${STAMP}.pdf`)
    expect(uploads[0].text).not.toContain('Vertrag.pdf')

    const thread = await one<{ entry_count: number; pending: boolean; has_document: boolean }>(sql`
      SELECT entry_count, render_pending_at IS NOT NULL AS pending, document_id IS NOT NULL AS has_document
        FROM mail_threads WHERE id = ${opened.threadId}::uuid`)
    expect(thread).toEqual({ entry_count: 3, pending: false, has_document: true })
    const firstVersions = await rows<{ v: string | null }>(
      sql`SELECT DISTINCT first_version_id::text AS v FROM mail_thread_entries WHERE thread_id = ${opened.threadId}::uuid`,
    )
    expect(firstVersions).toHaveLength(1)
    expect(firstVersions[0].v).not.toBeNull()

    // D36: one row per attachment, whatever became of it.
    const attachments = await rows<{ position: number; disposition: string; reason: string | null; version: string | null; section: string | null }>(sql`
      SELECT a.position, a.disposition, a.not_filed_reason AS reason, a.document_version_id::text AS version, a.section_name AS section
        FROM mail_thread_entry_attachments a JOIN mail_thread_entries e ON e.id = a.entry_id
       WHERE e.message_id = ${`a3-${STAMP}@ma37.wien.gv.at`} ORDER BY a.position`)
    expect(attachments).toEqual([
      { position: 0, disposition: 'filed', reason: null, version: planVersion, section: `M – Plan ${STAMP}.pdf` },
      { position: 1, disposition: 'not_filed', reason: 'screened', version: null, section: null },
    ])

    // The next slice: one more mail, one more Fassung, holding every section of the last byte for byte.
    const fourth = archived(`a4-${STAMP}`, { subject: 'AW: Stellplatznachweis', in_reply_to: `<a3-${STAMP}@ma37.wien.gv.at>` })
    expect(await append(fourth)).toMatchObject({ threadId: opened.threadId, threadCreated: false })
    await render()
    expect(uploads).toHaveLength(2)
    const sections = (markdown: string) => markdown.split(/^(?=## )/m).slice(1)
    for (const section of sections(uploads[0].text)) {
      expect(sections(uploads[1].text).map((s) => s.trimEnd())).toContain(section.trimEnd())
    }
    expect(await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM document_versions WHERE document_id = (SELECT document_id FROM mail_threads WHERE id = ${opened.threadId}::uuid)`)).toEqual({ n: 2 })
    // A slice with nothing new renders nothing.
    await render()
    expect(uploads).toHaveLength(2)
  })

  it('writes a retried mail once', async () => {
    const mail = archived(`r1-${STAMP}`)
    const first = await append(mail)
    const again = await append(mail)
    expect(again).toEqual(first)
    expect(await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM mail_thread_entries WHERE mail_import_id = ${importId}::uuid`)).toEqual({ n: 1 })
  })

  it('skips a text the address already filed (by Message-ID), and the same mail twice in one archive', async () => {
    await inboundThread(`Inbound ${STAMP}.md`, `d1-${STAMP}@ma37.wien.gv.at`)
    expect(await append(archived(`d1-${STAMP}`))).toEqual({ kind: 'already_in_project' })

    const twice = archived(`d2-${STAMP}`)
    expect(await append(twice)).toMatchObject({ kind: 'filed' })
    expect(await append({ ...twice, position: twice.position + 100, folder_path: ['Gesendete Elemente'] })).toEqual({ kind: 'already_in_project' })
    expect(await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM mail_thread_entries WHERE mail_import_id = ${importId}::uuid`)).toEqual({ n: 1 })
  })

  it('makes an archive entry what an inbound mail of the same Message-ID is checked against (the other way)', async () => {
    await append(archived(`d3-${STAMP}`))
    const filed = await inTenant(() => inbound.findFiledMessages(projectId, `d3-${STAMP}@ma37.wien.gv.at`))
    // `messageIdFlags` (receive-job.ts) flags such a mail `already_filed`: an archive entry is the same message.
    expect(filed).toEqual([expect.objectContaining({ source: 'archive' })])
  })

  it('joins a Verlauf of the address the person may write: its next Fassung, under its own name, counted once', async () => {
    const existing = await inboundThread(`Verlauf ${STAMP}.md`, `j1-${STAMP}@ma37.wien.gv.at`)
    const reply = archived(`j2-${STAMP}`, { subject: 'AW: Stellplatznachweis', in_reply_to: `<j1-${STAMP}@ma37.wien.gv.at>` })
    const later = archived(`j3-${STAMP}`, { subject: 'AW: Stellplatznachweis', in_reply_to: `<j2-${STAMP}@ma37.wien.gv.at>` })

    expect(await append(reply)).toEqual({ kind: 'filed', threadId: existing.threadId, threadCreated: false, threadJoined: true })
    expect(await append(later)).toEqual({ kind: 'filed', threadId: existing.threadId, threadCreated: false, threadJoined: false })
    await render()
    expect(uploads.map((upload) => upload.filename)).toEqual([`Verlauf ${STAMP}.md`])
    expect(uploads[0].text.match(/^## /gm)).toHaveLength(3)
    // A Verlauf that was there keeps its parties: who took part in unchecked mail widens no follow.
    expect(await one<{ domains: string[] }>(sql`SELECT participant_domains AS domains FROM mail_threads WHERE id = ${existing.threadId}::uuid`)).toEqual({
      domains: ['ma37.wien.gv.at'],
    })
  })

  it('never appends into a Verlauf the person may not write or read: the mail opens its own', async () => {
    const readOnly = await inboundThread(`ReadOnly ${STAMP}.md`, `w1-${STAMP}@ma37.wien.gv.at`, readOnlyFolder)
    const reply = archived(`w2-${STAMP}`, { subject: 'AW: Stellplatznachweis', in_reply_to: `<w1-${STAMP}@ma37.wien.gv.at>` })

    const outcome = await append(reply)
    expect(outcome).toMatchObject({ kind: 'filed', threadCreated: true })
    if (outcome.kind !== 'filed') throw new Error('not filed')
    expect(outcome.threadId).not.toBe(readOnly.threadId)
    expect(await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM mail_thread_entries WHERE thread_id = ${readOnly.threadId}::uuid`)).toEqual({ n: 1 })

    // Unreadable to the person (a binned document): the same.
    const binned = await inboundThread(`Binned ${STAMP}.md`, `w3-${STAMP}@ma37.wien.gv.at`)
    await rows(sql`UPDATE documents SET lifecycle = 'archived' WHERE id = ${binned.documentId}::uuid`)
    const another = archived(`w4-${STAMP}`, { subject: 'AW: Stellplatznachweis', in_reply_to: `<w3-${STAMP}@ma37.wien.gv.at>` })
    expect(await append(another)).toMatchObject({ threadCreated: true })
    expect(await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM mail_thread_entries WHERE thread_id = ${binned.threadId}::uuid`)).toEqual({ n: 1 })
  })

  it('answers busy while another writer keeps the Verlauf past a mail’s wait, writing nothing', { timeout: 40_000 }, async () => {
    const existing = await inboundThread(`Busy ${STAMP}.md`, `b1-${STAMP}@ma37.wien.gv.at`)
    const other = crypto.randomUUID()
    expect(await inTenant(() => write.acquireRenderLease(existing.threadId, other, new Date(Date.now() + 60_000)))).toBe(true)
    // Real time: the wait is `RENDER_LEASE_RETRY_MS` (15 s) of polls, and the database client needs real timers.
    const started = Date.now()
    expect(await append(archived(`b2-${STAMP}`, { subject: 'AW: Stellplatznachweis', in_reply_to: `<b1-${STAMP}@ma37.wien.gv.at>` }))).toEqual({ kind: 'busy' })
    expect(Date.now() - started).toBeGreaterThanOrEqual(13_000)
    expect(await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM mail_thread_entries WHERE thread_id = ${existing.threadId}::uuid`)).toEqual({ n: 1 })
    expect(await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM mail_thread_entries WHERE mail_import_id = ${importId}::uuid`)).toEqual({ n: 0 })
    await inTenant(() => write.releaseRenderLease(existing.threadId, other))
  })

  it('leaves a Verlauf whose lease another writer holds pending for the next slice', async () => {
    const opened = await append(archived(`l1-${STAMP}`))
    if (opened.kind !== 'filed') throw new Error('not filed')
    const other = crypto.randomUUID()
    await inTenant(() => write.acquireRenderLease(opened.threadId, other, new Date(Date.now() + 60_000)))
    expect(await render()).toMatchObject({ rendered: 0, waiting: 1 })
    await inTenant(() => write.releaseRenderLease(opened.threadId, other))
    expect(await render()).toMatchObject({ rendered: 1, waiting: 0 })
  })

  it('lets an address filing that renders a pending archive entry along record it as that Fassung’s, leaving nothing to render', async () => {
    const existing = await inboundThread(`Along ${STAMP}.md`, `p1-${STAMP}@ma37.wien.gv.at`)
    const reply = archived(`p2-${STAMP}`, { subject: 'AW: Stellplatznachweis', in_reply_to: `<p1-${STAMP}@ma37.wien.gv.at>` })
    expect(await append(reply)).toMatchObject({ threadId: existing.threadId })
    const version = (
      await one<{ id: string }>(sql`
        INSERT INTO document_versions (organization_id, document_id, project_id, version_number, state, storage_key, created_by, approved_by, approved_at)
        VALUES (${ORG}, ${existing.documentId}::uuid, ${projectId}::uuid, 2, 'superseded', ${`k/${STAMP}/along/v2`}, ${USER}, ${USER}, now()) RETURNING id`)
    ).id
    const entryId = crypto.randomUUID()
    await inTenant(() =>
      write.commitAppend({
        newThread: null,
        threadId: existing.threadId,
        threadUpdate: { documentId: existing.documentId, entryCount: 3, renderedBytes: 900, lastEntryAt: new Date(), participantDomains: ['ma37.wien.gv.at'] },
        entry: {
          id: entryId,
          organizationId: ORG,
          projectId,
          threadId: existing.threadId,
          source: 'inbound',
          inboundMailId: crypto.randomUUID(),
          messageId: `p3-${STAMP}@ma37.wien.gv.at`,
          sentAt: new Date(),
          receivedAt: new Date(),
          heading: `Along ${STAMP}`,
          senderTrust: 'external_verified',
          ownText: 'Dritte.',
          firstVersionId: version,
          filedBy: USER,
          filedVia: 'app',
          filedAt: new Date(),
        },
        messageIds: { received: `p3-${STAMP}@ma37.wien.gv.at`, referenced: [] },
        attachments: [],
        part: { id: crypto.randomUUID(), documentId: existing.documentId, versionId: version },
        mailId: crypto.randomUUID(),
        movesOriginal: false,
      }),
    )
    expect(
      await one(sql`SELECT first_version_id::text AS v FROM mail_thread_entries WHERE message_id = ${`p2-${STAMP}@ma37.wien.gv.at`}`),
    ).toEqual({ v: version })
    expect(await render()).toMatchObject({ rendered: 0, waiting: 0 })
    expect(uploads).toHaveLength(0)
  })

  it('adds the Verläufe counts as the cursor moves, and the table refuses a negative one', async () => {
    const row = await inTenant(() =>
      imports.insertMailImport({
        organizationId: ORG,
        projectId,
        userId: USER,
        filename: 'Postfach.pst',
        sizeBytes: 10,
        status: 'importing',
        stagingBucket: 'b',
        stagingKey: `k/${STAMP}/archive`,
      }),
    )
    if (!row) throw new Error('no import')
    const advance = { mailsFiled: 1, filesFiled: 0, itemsSkipped: 0, filesSkipped: 0, skippedSamples: [] }
    expect(await imports.advanceMailImport(ORG, row.id, 0, { ...advance, to: 1, threadsCreated: 1, threadsAppended: 0, alreadyInProject: 0 })).toBe(true)
    expect(await imports.advanceMailImport(ORG, row.id, 1, { ...advance, to: 2, threadsCreated: 0, threadsAppended: 1, alreadyInProject: 1 })).toBe(true)
    expect(await imports.recordSkippedFiles(ORG, row.id, 1, [{ mail: 'X 2026-05-12', file: null, reason: 'screened' }])).toBe(true)
    expect(await one(sql`SELECT threads_created, threads_appended, already_in_project, files_skipped FROM mail_imports WHERE id = ${row.id}::uuid`)).toEqual({
      threads_created: 1,
      threads_appended: 1,
      already_in_project: 1,
      files_skipped: 1,
    })
    const refused = await inTenant(() => db.execute(sql`UPDATE mail_imports SET threads_created = -1 WHERE id = ${row.id}::uuid`)).then(
      () => null,
      (error: Error & { cause?: { constraint_name?: string } }) => error.cause?.constraint_name ?? String(error),
    )
    expect(refused).toBe('mail_imports_thread_counts_non_negative')
  })
})
