/**
 * @vitest-environment node
 *
 * Anmerkungen rows (migration 0138) against a REAL Postgres through the
 * restricted runtime role:
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/annotations/repository.integration.spec.ts
 *
 * What it proves, each a claim about SQL a mocked handle cannot disagree with:
 *   - numbers run per document, and ten writers at once get ten numbers; a
 *     batch of proposals takes consecutive numbers;
 *   - a person's mark is born open and Piloti's proposed, and the database
 *     refuses Piloti's mark as open without a person who took it over; a
 *     mark the asker asked Piloti for is born open with the asker behind it;
 *   - the Fassung a mark was set on comes back by number, and a discarded
 *     version leaves the mark standing;
 *   - a status move is compare-and-swap: the second of two moves from the same
 *     state finds nothing to move; a carry to a replacing document closes the
 *     source only while it is open and not delegated to Piloti;
 *   - the daily reminder reads only marks whose Frist is inside its window;
 *   - a thread comes back in order and goes with its mark;
 *   - one reply is deleted alone, and only while it still says what the caller
 *     read (undo's compare-and-swap); another mark's reply with the same id is
 *     not touched; a reply is reworded the same way, its edit stamped by the
 *     database's clock (migration 0152);
 *   - another organization reads none of them and cannot plant one on this
 *     organization's document;
 *   - a wake of Piloti (migration 0139, ADR-0106) is recorded and queued in
 *     the reply's transaction, and a reply that rolls back leaves neither; the
 *     caps count the recorded wakes; a delegation is both columns or neither,
 *     only on an open mark, and Piloti's reply leaves it alone.
 *
 * `task db:test:rls` (scripts/rls-test-db.sh) runs it with the other suites.
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const url = process.env.GRID_TEST_DATABASE_URL
const STAMP = Date.now()
const ORG = `org_annotations_${STAMP}`
const OTHER_ORG = `${ORG}_other`
const USER = `user_annotations_${STAMP}`

describe('the Anmerkungen suite is not silently skipped in CI', () => {
  it('has a database to run against', () => {
    if (!process.env.GRID_RLS_SUITE_REQUIRED) return
    expect(url, 'GRID_TEST_DATABASE_URL is unset while GRID_RLS_SUITE_REQUIRED is set').toBeTruthy()
  })
})

describe.skipIf(!url)('Anmerkungen against live Postgres', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let withPlatformAccess: typeof import('@/lib/db/tenant-context').withPlatformAccess
  let repo: typeof import('./repository')
  let wake: typeof import('./wake')
  let wakeIds: typeof import('./wake-ids')
  let takeBack: typeof import('./take-back')
  const ids = { project: '', document: '', second: '', v1: '', v2: '' }

  const inOrg = <T>(organizationId: string, run: () => PromiseLike<T>) =>
    withTenant({ organizationId, userId: USER }, run)
  const first = (rows: Iterable<{ id: unknown }>) => String(Array.from(rows)[0]?.id)

  async function project(organizationId: string, name: string): Promise<string> {
    return first(
      await inOrg(organizationId, () =>
        db.execute<{ id: string }>(sql`
          insert into projects (organization_id, name, created_by, collection_name)
          values (${organizationId}, ${name}, ${USER}, ${`proj_ann_${name}_${STAMP}`}) returning id`)
      )
    )
  }

  async function document(projectId: string, filename: string): Promise<string> {
    return first(
      await inOrg(ORG, () =>
        db.execute<{ id: string }>(sql`
          insert into documents (organization_id, project_id, scope, filename, storage_key, collection_name, created_by,
                                 status, screening_outcome)
          values (${ORG}, ${projectId}::uuid, 'project', ${filename}, ${`k/${STAMP}/${filename}`},
                  ${`proj_ann_${projectId}`}, ${USER}, 'completed', 'clean') returning id`)
      )
    )
  }

  async function version(documentId: string, number: number, state: 'published' | 'superseded'): Promise<string> {
    return first(
      await inOrg(ORG, () =>
        db.execute<{ id: string }>(sql`
          insert into document_versions (organization_id, document_id, project_id, version_number, state, storage_key,
                                         content_hash, created_by, approved_by, approved_at)
          values (${ORG}, ${documentId}::uuid, ${ids.project}::uuid, ${number}, ${state}, ${`k/${STAMP}/v${number}`},
                  ${`sha256:${STAMP}${number}`}, ${USER}, ${USER}, now()) returning id`)
      )
    )
  }

  const mark = (extra: Partial<import('./repository').NewAnnotationValues> = {}) => ({
    page: 1,
    shape: 'point' as const,
    x: 0.5,
    y: 0.5,
    w: null,
    h: null,
    kind: 'hint' as const,
    body: 'Stiegenbreite prüfen',
    basis: null,
    assigneeUserId: null,
    dueOn: null,
    ...extra,
  })

  const insert = (
    documentId: string,
    marks = [mark()],
    extra: Partial<import('./repository').NewAnnotationsInput> = {}
  ) =>
    inOrg(extra.organizationId ?? ORG, () =>
      repo.insertDocumentAnnotations({
        organizationId: ORG,
        documentId,
        versionId: null,
        authorKind: 'person',
        createdBy: USER,
        marks,
        ...extra,
      })
    )

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    const context = await import('@/lib/db/tenant-context')
    withTenant = context.withTenant
    withPlatformAccess = context.withPlatformAccess
    db = (await import('@/lib/db')).getDb()
    repo = await import('./repository')
    wake = await import('./wake')
    wakeIds = await import('./wake-ids')
    takeBack = await import('./take-back')
    ids.project = await project(ORG, 'Wohnbau')
    await project(OTHER_ORG, 'Fremd')
    ids.document = await document(ids.project, 'EG_Grundriss.pdf')
    ids.second = await document(ids.project, 'OG_Grundriss.pdf')
    ids.v1 = await version(ids.document, 1, 'superseded')
    ids.v2 = await version(ids.document, 2, 'published')
  })

  afterAll(async () => {
    if (!db) return
    await withPlatformAccess('test teardown', async () => {
      for (const organizationId of [ORG, OTHER_ORG]) {
        await db.execute(sql`delete from bff_job_queue where lane = ${organizationId}`)
        await db.execute(sql`delete from projects where organization_id = ${organizationId}`)
      }
    })
    const { closeDb } = await import('@/lib/db')
    await closeDb()
  })

  it('numbers per document, ten writers at once get ten numbers, and a batch takes consecutive ones', async () => {
    await insert(ids.second)
    const rows = await Promise.all(
      Array.from({ length: 10 }, (_, index) => insert(ids.document, [mark({ body: `Mark ${index}` })]))
    )
    expect(
      rows
        .flat()
        .map((row) => row.number)
        .sort((a, b) => a - b)
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])

    const batch = await insert(ids.document, [mark({ body: 'a' }), mark({ body: 'b' }), mark({ body: 'c' })], {
      authorKind: 'piloti',
    })
    expect(batch.map((row) => [row.number, row.status, row.authorKind])).toEqual([
      [11, 'proposed', 'piloti'],
      [12, 'proposed', 'piloti'],
      [13, 'proposed', 'piloti'],
    ])
    const second = await inOrg(ORG, () => repo.listDocumentAnnotations(ORG, ids.second))
    expect(second.map((row) => [row.number, row.status])).toEqual([[1, 'open']])
  })

  it('stores a region, and refuses one off its page', async () => {
    const [region] = await insert(ids.document, [mark({ shape: 'region', x: 0.1, y: 0.2, w: 0.3, h: 0.4 })])
    expect(region).toMatchObject({ shape: 'region', w: 0.3, h: 0.4 })
    await expect(insert(ids.document, [mark({ shape: 'region', x: 0.8, y: 0.2, w: 0.3, h: 0.4 })])).rejects.toThrow()
  })

  it("refuses Piloti's mark as the office's own until a person took it over", async () => {
    const [proposal] = await insert(ids.document, [mark()], { authorKind: 'piloti' })
    await expect(
      inOrg(ORG, () => db.execute(sql`update document_annotations set status = 'open' where id = ${proposal.id}::uuid`))
    ).rejects.toThrow()

    const taken = await inOrg(ORG, () =>
      repo.updateDocumentAnnotation(ORG, ids.document, proposal.id, 'proposed', {
        transition: { status: 'open', acceptedBy: USER, acceptedAt: new Date(), closedBy: null, closedAt: null },
      })
    )
    expect(taken).toMatchObject({ status: 'open', acceptedBy: USER })
  })

  it('sets a mark the asker asked Piloti for open, with the asker behind it, and closes it in their name', async () => {
    const [row] = await insert(ids.document, [mark()], { authorKind: 'piloti', acceptedBy: USER })
    expect(row).toMatchObject({ status: 'open', authorKind: 'piloti', createdBy: USER, acceptedBy: USER })
    expect(row.acceptedAt).toBeInstanceOf(Date)

    const resolved = await inOrg(ORG, () =>
      repo.updateDocumentAnnotation(ORG, ids.document, row.id, 'open', {
        transition: { status: 'resolved', closedBy: USER, closedAt: new Date() },
      })
    )
    expect(resolved).toMatchObject({ status: 'resolved', closedBy: USER, acceptedBy: USER })

    // The CHECK is untouched: Piloti's open mark with nobody behind it is still refused.
    await expect(
      inOrg(ORG, () =>
        db.execute(sql`
          update document_annotations
          set status = 'open', closed_by = null, closed_at = null, accepted_by = null, accepted_at = null
          where id = ${row.id}::uuid`)
      )
    ).rejects.toThrow()
  })

  it('moves a status by compare and swap: the second move from the same state finds nothing', async () => {
    const [row] = await insert(ids.document)
    const resolve = () =>
      inOrg(ORG, () =>
        repo.updateDocumentAnnotation(ORG, ids.document, row.id, 'open', {
          transition: { status: 'resolved', closedBy: USER, closedAt: new Date() },
        })
      )
    expect(await resolve()).toMatchObject({ status: 'resolved' })
    expect(await resolve()).toBeNull()
    await expect(
      inOrg(ORG, () =>
        db.execute(sql`update document_annotations set closed_by = null, closed_at = null where id = ${row.id}::uuid`)
      )
    ).rejects.toThrow()
  })

  it('reads the Fassung number it was set on, and keeps the mark when that version goes', async () => {
    const [onOld] = await insert(ids.document, [mark()], { versionId: ids.v1 })
    const [onNew] = await insert(ids.document, [mark()], { versionId: ids.v2 })
    expect((await inOrg(ORG, () => repo.findDocumentAnnotation(ORG, ids.document, onOld.id)))?.revisionNumber).toBe(1)
    expect((await inOrg(ORG, () => repo.findDocumentAnnotation(ORG, ids.document, onNew.id)))?.revisionNumber).toBe(2)

    await inOrg(ORG, () => db.execute(sql`delete from document_versions where id = ${ids.v1}::uuid`))
    const after = await inOrg(ORG, () => repo.findDocumentAnnotation(ORG, ids.document, onOld.id))
    expect(after).toMatchObject({ versionId: null, revisionNumber: null })
  })

  it('carries a mark to the current Fassung in place, once: compared against the Fassung it was read on', async () => {
    const [row] = await insert(ids.document, [mark()], { versionId: ids.v2 })
    const restored = await version(ids.document, 7, 'superseded')
    await inOrg(ORG, () => db.execute(sql`update document_annotations set version_id = ${restored}::uuid where id = ${row.id}::uuid`))
    const carry = () =>
      inOrg(ORG, () =>
        repo.updateDocumentAnnotation(ORG, ids.document, row.id, 'open', { revision: { from: restored, to: ids.v2 } })
      )
    expect(await carry()).toMatchObject({ versionId: ids.v2, number: row.number })
    expect(await carry()).toBeNull()
    expect((await inOrg(ORG, () => repo.findDocumentAnnotation(ORG, ids.document, row.id)))?.revisionNumber).toBe(2)
  })

  it('carries a mark of a replaced document as a linked mark, closes the original, and refuses a second copy', async () => {
    const replacing = await document(ids.project, `Index_C_${STAMP}.pdf`)
    const [source] = await insert(ids.document, [mark({ assigneeUserId: USER, dueOn: '2026-10-24', body: 'Brüstung' })])
    const carry = () =>
      inOrg(ORG, () =>
        repo.carryAnnotationToDocument({
          organizationId: ORG,
          source,
          target: { documentId: replacing, versionId: null },
          values: { mentions: [], assigneeUserId: USER },
          closedBy: USER,
        })
      )

    const copy = await carry()
    expect(copy).toMatchObject({
      documentId: replacing,
      number: 1,
      status: 'open',
      body: 'Brüstung',
      assigneeUserId: USER,
      dueOn: '2026-10-24',
      carriedFromId: source.id,
    })
    const original = await inOrg(ORG, () => repo.findDocumentAnnotation(ORG, ids.document, source.id))
    expect(original).toMatchObject({ status: 'resolved', closedBy: USER })
    expect(original?.carriedTo).toEqual({ annotationId: copy?.id, documentId: replacing, number: 1 })
    const linked = await inOrg(ORG, () => repo.listDocumentAnnotations(ORG, replacing))
    expect(linked[0]?.carriedFrom).toEqual({ annotationId: source.id, documentId: ids.document, number: source.number })

    // Closed now: a second carry finds nothing to carry.
    expect(await carry()).toBeNull()
    // Open again, a second copy is refused by the index, whatever the service checked.
    await inOrg(ORG, () =>
      db.execute(sql`update document_annotations set status = 'open', closed_by = null, closed_at = null where id = ${source.id}::uuid`)
    )
    await expect(carry()).rejects.toBeInstanceOf(repo.AlreadyCarriedError)

    // The original goes: the carried mark stands, without its link.
    await inOrg(ORG, () => repo.deleteDocumentAnnotation(ORG, ids.document, source.id))
    const orphan = await inOrg(ORG, () => repo.findDocumentAnnotation(ORG, replacing, String(copy?.id)))
    expect(orphan).toMatchObject({ carriedFromId: null, carriedFrom: null, status: 'open' })
  })

  it('carries no mark delegated to Piloti after the service read it: the close finds nothing, and nothing is set on the target', async () => {
    const replacing = await document(ids.project, `Index_D_${STAMP}.pdf`)
    // Read open and undelegated by the service; delegated a moment later.
    const [source] = await insert(ids.document, [mark({ body: 'Geländer' })])
    await inOrg(ORG, () =>
      repo.updateDocumentAnnotation(ORG, ids.document, source.id, 'open', {
        delegation: { delegatedBy: USER, delegatedAt: new Date() },
      })
    )

    const carried = await inOrg(ORG, () =>
      repo.carryAnnotationToDocument({
        organizationId: ORG,
        source,
        target: { documentId: replacing, versionId: null },
        values: { mentions: [], assigneeUserId: null },
        closedBy: USER,
      })
    )

    expect(carried).toBeNull()
    expect(await inOrg(ORG, () => repo.findDocumentAnnotation(ORG, ids.document, source.id))).toMatchObject({
      status: 'open',
      delegatedBy: USER,
    })
    expect(await inOrg(ORG, () => repo.listDocumentAnnotations(ORG, replacing))).toEqual([])
  })

  it('finds the marks whose Frist is near or recently past for the daily reminder: open, with a Zuständige, by id', async () => {
    const dated = await document(ids.project, `Frist_${STAMP}.pdf`)
    const [soon, past, later, nobody, closed, stale] = await insert(dated, [
      mark({ assigneeUserId: USER, dueOn: '2026-10-18', body: 'morgen' }),
      mark({ assigneeUserId: USER, dueOn: '2026-10-10', body: 'vorbei' }),
      mark({ assigneeUserId: USER, dueOn: '2026-11-30', body: 'später' }),
      mark({ assigneeUserId: null, dueOn: '2026-10-12', body: 'niemand' }),
      mark({ assigneeUserId: USER, dueOn: '2026-10-12', body: 'erledigt' }),
      mark({ assigneeUserId: USER, dueOn: '2026-10-09', body: 'längst vorbei' }),
    ])
    const window = { from: '2026-10-10', through: '2026-10-18' }
    await inOrg(ORG, () =>
      repo.updateDocumentAnnotation(ORG, dated, closed.id, 'open', {
        transition: { status: 'resolved', closedBy: USER, closedAt: new Date() },
      })
    )
    const due = await import('./due-repository')

    const page = await due.listDueMarksPage(ORG, window, null, 100)
    const onDated = page.filter((row) => row.documentId === dated)
    expect(onDated.map((row) => row.body).sort()).toEqual(['morgen', 'vorbei'])
    expect(onDated.find((row) => row.id === soon.id)).toMatchObject({
      assigneeUserId: USER,
      dueOn: '2026-10-18',
      number: soon.number,
      document: { id: dated, scope: 'project', projectId: ids.project },
    })
    expect(page.map((row) => row.id)).toEqual([...page.map((row) => row.id)].sort())
    // Neither a later Frist, nor one before the window: a first run does not remind of everything that ever passed.
    expect(page.some((row) => [later.id, nobody.id, closed.id, stale.id].includes(row.id))).toBe(false)

    const after = await due.listDueMarksPage(ORG, window, [soon.id, past.id].sort()[0], 100)
    expect(after.map((row) => row.id)).not.toContain([soon.id, past.id].sort()[0])

    const organizations = await withPlatformAccess('test: the due sweep finds its organizations', () =>
      due.listOrganizationsWithDueMarks(window, '2026-10-17', 1000)
    )
    expect(organizations).toContain(ORG)
    expect(organizations).not.toContain(OTHER_ORG)
    expect(new Set(organizations).size).toBe(organizations.length)
    // The window bounds discovery from below too: on a day after all of this office's Fristen, it is not found.
    const laterWindow = await withPlatformAccess('test: the due sweep skips stale marks', () =>
      due.listOrganizationsWithDueMarks({ from: '2026-12-01', through: '2026-12-02' }, '2026-12-01', 1000)
    )
    expect(laterWindow).not.toContain(ORG)
  })

  it('keeps a thread in order, touches the mark, and lets the thread go with its mark', async () => {
    const [row] = await insert(ids.document)
    for (const body of ['Erste', 'Zweite', 'Dritte']) {
      await inOrg(ORG, () =>
        repo.insertAnnotationReply({ organizationId: ORG, annotationId: row.id, authorKind: 'person', body, createdBy: USER })
      )
    }
    const found = await inOrg(ORG, () => repo.findDocumentAnnotation(ORG, ids.document, row.id))
    expect(found?.replies.map((reply) => reply.body)).toEqual(['Erste', 'Zweite', 'Dritte'])
    expect(found!.updatedAt.getTime()).toBeGreaterThan(row.updatedAt.getTime())

    await inOrg(ORG, () => repo.deleteDocumentAnnotation(ORG, ids.document, row.id))
    const left = await inOrg(ORG, () =>
      db.execute<{ n: number }>(
        sql`select count(*)::int as n from document_annotation_replies where annotation_id = ${row.id}::uuid`
      )
    )
    expect(Number(Array.from(left)[0]?.n)).toBe(0)
  })

  it('keeps whom a mark and a reply mention, changes them with the body, and refuses more than one message may name', async () => {
    const anna = { targetId: 'user_anna', display: 'Anna Berger' }
    const ben = { targetId: 'user_ben', display: 'Ben Gruber' }
    const [row] = await insert(ids.document, [mark({ body: '@Anna Berger prüfen', mentions: [anna] })])
    expect(row.mentions).toEqual([anna])
    const [plain] = await insert(ids.document)
    expect(plain.mentions).toEqual([])

    await inOrg(ORG, () =>
      repo.insertAnnotationReply({
        organizationId: ORG,
        annotationId: row.id,
        authorKind: 'person',
        body: '@Ben Gruber auch?',
        createdBy: USER,
        mentions: [ben],
      })
    )
    await inOrg(ORG, () =>
      repo.updateDocumentAnnotation(ORG, ids.document, row.id, 'open', { body: '@Ben Gruber prüfen', mentions: [ben] })
    )
    const found = await inOrg(ORG, () => repo.findDocumentAnnotation(ORG, ids.document, row.id))
    expect(found?.mentions).toEqual([ben])
    expect(found?.replies.map((reply) => reply.mentions)).toEqual([[ben]])

    const eleven = Array.from({ length: 11 }, (_, index) => ({ targetId: `user_${index}`, display: `P${index}` }))
    await expect(
      inOrg(ORG, () =>
        repo.updateDocumentAnnotation(ORG, ids.document, row.id, 'open', { body: 'zu viele', mentions: eleven })
      )
    ).rejects.toThrow()
  })

  it('deletes one reply alone, and only while its body is what the caller read', async () => {
    const [row] = await insert(ids.document)
    const [other] = await insert(ids.document)
    const post = (annotationId: string, body: string) =>
      inOrg(ORG, () =>
        repo.insertAnnotationReply({ organizationId: ORG, annotationId, authorKind: 'piloti', body, createdBy: USER })
      )
    const keep = await post(row.id, 'Bleibt')
    const gone = await post(row.id, 'Geht')
    const elsewhere = await post(other.id, 'Anderswo')
    const bodies = async (annotationId: string) =>
      (await inOrg(ORG, () => repo.findDocumentAnnotation(ORG, ids.document, annotationId)))?.replies.map((reply) => reply.body)

    // The body moved since the caller read it: nothing goes.
    expect(await inOrg(ORG, () => repo.deleteAnnotationReply(ORG, row.id, gone.id, 'Anders'))).toBe(false)
    // The reply of another mark is not this mark's.
    expect(await inOrg(ORG, () => repo.deleteAnnotationReply(ORG, row.id, elsewhere.id))).toBe(false)
    // Another organization finds nothing.
    expect(await inOrg(OTHER_ORG, () => repo.deleteAnnotationReply(OTHER_ORG, row.id, gone.id))).toBe(false)
    expect(await bodies(row.id)).toEqual(['Bleibt', 'Geht'])

    expect(await inOrg(ORG, () => repo.deleteAnnotationReply(ORG, row.id, gone.id, 'Geht'))).toBe(true)
    expect(await inOrg(ORG, () => repo.deleteAnnotationReply(ORG, row.id, gone.id))).toBe(false)
    expect(await bodies(row.id)).toEqual(['Bleibt'])
    expect(await bodies(other.id)).toEqual(['Anderswo'])
    expect(keep.id).not.toBe(gone.id)
  })

  it('rewords one reply only while it says what the caller read, stamping the edit by the database clock', async () => {
    const [row] = await insert(ids.document)
    const reply = await inOrg(ORG, () =>
      repo.insertAnnotationReply({ organizationId: ORG, annotationId: row.id, authorKind: 'person', body: 'Vorher', createdBy: USER })
    )
    expect(reply.editedAt).toBeNull()
    const mentions = [{ targetId: 'user_anna', display: 'Anna Berger' }]

    // The words moved since the caller read them: nothing changes.
    expect(
      await inOrg(ORG, () => repo.updateAnnotationReply(ORG, row.id, reply.id, 'Anders', { body: 'Nachher', mentions }))
    ).toBeNull()
    // Another organization finds nothing.
    expect(
      await inOrg(OTHER_ORG, () => repo.updateAnnotationReply(OTHER_ORG, row.id, reply.id, 'Vorher', { body: 'Nachher', mentions }))
    ).toBeNull()

    const edited = await inOrg(ORG, () =>
      repo.updateAnnotationReply(ORG, row.id, reply.id, 'Vorher', { body: 'Nachher', mentions })
    )
    expect(edited).toMatchObject({ body: 'Nachher', mentions })
    expect(edited?.editedAt).toBeInstanceOf(Date)
    expect(edited!.editedAt!.getTime()).toBeGreaterThanOrEqual(reply.createdAt.getTime())
    // A second edit from the same reading finds nothing: the first one won.
    expect(
      await inOrg(ORG, () => repo.updateAnnotationReply(ORG, row.id, reply.id, 'Vorher', { body: 'Zweite', mentions: [] }))
    ).toBeNull()
    const [stored] = (await inOrg(ORG, () => repo.findDocumentAnnotation(ORG, ids.document, row.id)))?.replies ?? []
    expect(stored).toMatchObject({ body: 'Nachher', mentions })
    expect(stored?.editedAt).toBeInstanceOf(Date)
  })

  it('shows another organization none of them, and refuses one planted on this document', async () => {
    expect(await inOrg(OTHER_ORG, () => repo.listDocumentAnnotations(OTHER_ORG, ids.document))).toEqual([])
    const leaked = await inOrg(OTHER_ORG, () =>
      db.execute<{ n: number }>(
        sql`select (select count(*) from document_annotations) + (select count(*) from document_annotation_replies) as n`
      )
    )
    expect(Number(Array.from(leaked)[0]?.n)).toBe(0)

    await expect(insert(ids.document, [mark()], { organizationId: OTHER_ORG })).rejects.toThrow()
  })

  it('tallies the live marks of a listing page in one query, what is the reader’s, and nothing of a held upload', async () => {
    const { memberReader, REVIEWER_READER } = await import('@/lib/documents/visibility')
    const UPLOADER = `${USER}_uploader`
    const clean = await document(ids.project, 'Tally_Schnitt.pdf')
    const held = first(
      await inOrg(ORG, () =>
        db.execute<{ id: string }>(sql`
          insert into documents (organization_id, project_id, scope, filename, storage_key, collection_name, created_by,
                                 status, screening_outcome)
          values (${ORG}, ${ids.project}::uuid, 'project', 'Tally_gehalten.pdf', ${`k/${STAMP}/held`},
                  ${`proj_ann_${ids.project}`}, ${UPLOADER}, 'quarantined', 'quarantined') returning id`)
      )
    )
    await insert(clean, [mark(), mark({ assigneeUserId: USER })])
    await insert(clean, [mark({ assigneeUserId: USER })], { authorKind: 'piloti' })
    const closed = await insert(clean, [mark({ assigneeUserId: USER }), mark()])
    for (const [row, status] of [
      [closed[0], 'resolved'],
      [closed[1], 'dismissed'],
    ] as const) {
      await inOrg(ORG, () =>
        repo.updateDocumentAnnotation(ORG, clean, row.id, 'open', {
          transition: { status, closedBy: USER, closedAt: new Date() },
        })
      )
    }
    await insert(held, [mark({ assigneeUserId: USER })], { createdBy: UPLOADER })

    const tally = (reader: Parameters<typeof repo.tallyLiveMarks>[2], organizationId = ORG) =>
      inOrg(organizationId, () => repo.tallyLiveMarks(organizationId, [clean, held, ids.second], reader, USER))

    // Two open and one proposal are live, counted apart; only the open one assigned to USER is theirs (the proposal naming them is not yet).
    const member = await tally(memberReader(USER))
    expect(member.get(clean)).toEqual({ open: 2, proposed: 1, forYou: 1 })
    expect(member.has(held)).toBe(false)
    const second = member.get(ids.second)
    expect((second?.open ?? 0) + (second?.proposed ?? 0)).toBeGreaterThan(0)
    // The uploader and the reviewers see the held upload's marks, as they see the upload.
    expect((await tally(memberReader(UPLOADER))).get(held)).toEqual({ open: 1, proposed: 0, forYou: 1 })
    expect((await tally(REVIEWER_READER)).get(held)).toEqual({ open: 1, proposed: 0, forYou: 1 })
    expect(await inOrg(OTHER_ORG, () => repo.tallyLiveMarks(OTHER_ORG, [clean, held], memberReader(USER), USER))).toEqual(
      new Map()
    )
  })

  it('counts „für Sie“ as the review’s predicate says, case for case', async () => {
    const { memberReader } = await import('@/lib/documents/visibility')
    const { isForReader, isLive } = await import('./types')
    const { FOR_READER_CASES } = await import('@/test-utils/marks-for-reader')
    const COLLEAGUE = `${USER}_colleague`
    const person = (who: 'reader' | 'colleague') => (who === 'reader' ? USER : COLLEAGUE)
    // One document per case, so the tally speaks for each on its own.
    const placed: Array<{ given: (typeof FOR_READER_CASES)[number]; documentId: string }> = []
    for (const [index, given] of FOR_READER_CASES.entries()) {
      const documentId = await document(ids.project, `FuerSie_${index}.pdf`)
      const [row] = await insert(documentId, [mark({ assigneeUserId: given.assignee ? person(given.assignee) : null })], {
        authorKind: given.authorKind,
        createdBy: person(given.setBy),
        // Piloti's mark is the office's only once somebody took it over.
        ...(given.authorKind === 'piloti' && given.status !== 'proposed' ? { acceptedBy: COLLEAGUE } : {}),
      })
      if (given.status === 'resolved' || given.status === 'dismissed') {
        await inOrg(ORG, () =>
          repo.updateDocumentAnnotation(ORG, documentId, row.id, 'open', {
            transition: { status: given.status, closedBy: USER, closedAt: new Date() },
          })
        )
      }
      placed.push({ given, documentId })
    }

    const tally = await inOrg(ORG, () =>
      repo.tallyLiveMarks(ORG, placed.map((entry) => entry.documentId), memberReader(USER), USER)
    )
    for (const { given, documentId } of placed) {
      const [stored] = await inOrg(ORG, () => repo.listDocumentAnnotations(ORG, documentId))
      if (!stored) throw new Error(`no mark stored for „${given.name}“`)
      expect(stored.status, given.name).toBe(given.status)
      expect(isForReader(stored, USER), given.name).toBe(given.forReader)
      expect(isLive(stored) && isForReader(stored, USER), given.name).toBe(given.counted)
      expect(tally.get(documentId)?.forYou ?? 0, given.name).toBe(given.counted ? 1 : 0)
    }
  })

  describe('waking Piloti (migration 0139)', () => {
    const count = async (query: ReturnType<typeof sql>) =>
      Number(Array.from(await inOrg(ORG, () => db.execute<{ n: number }>(query)))[0]?.n)
    const event = (annotationId: string, eventId: string) => ({
      organizationId: ORG,
      documentId: ids.document,
      annotationId,
      trigger: 'thread_mention' as const,
      eventId,
      actor: { userId: USER, email: null },
    })

    it('records the wake and queues its job in the reply’s transaction, under one id', async () => {
      const [row] = await insert(ids.document)
      const reply = await inOrg(ORG, () =>
        repo.insertAnnotationReply(
          { organizationId: ORG, annotationId: row.id, authorKind: 'person', body: '@Piloti?', createdBy: USER, addressesAgent: true },
          async (tx, inserted) => {
            await wake.enqueueWake(tx, event(row.id, inserted.id))
          }
        )
      )
      expect(reply.addressesAgent).toBe(true)
      const id = wakeIds.wakeTurnId(reply.id)
      expect(await count(sql`select count(*)::int as n from piloti_wakes where id = ${id}::uuid and status = 'queued'`)).toBe(1)
      expect(
        await count(sql`select count(*)::int as n from bff_job_queue where job_id = ${id}::uuid and kind = 'piloti_wake'`)
      ).toBe(1)
    })

    it('leaves no wake and no job when the reply rolls back', async () => {
      const [row] = await insert(ids.document)
      let wakeId = ''
      await expect(
        inOrg(ORG, () =>
          repo.insertAnnotationReply(
            { organizationId: ORG, annotationId: row.id, authorKind: 'person', body: '@Piloti?', createdBy: USER, addressesAgent: true },
            async (tx, inserted) => {
              wakeId = wakeIds.wakeTurnId(inserted.id)
              await wake.enqueueWake(tx, event(row.id, inserted.id))
              throw new Error('the write failed after the wake was enqueued')
            }
          )
        )
      ).rejects.toThrow(/after the wake/)
      expect(wakeId).not.toBe('')
      expect(await count(sql`select count(*)::int as n from piloti_wakes where id = ${wakeId}::uuid`)).toBe(0)
      expect(await count(sql`select count(*)::int as n from bff_job_queue where job_id = ${wakeId}::uuid`)).toBe(0)
      expect(await count(sql`select count(*)::int as n from document_annotation_replies where annotation_id = ${row.id}::uuid`)).toBe(0)
    })

    it('counts the wakes it let through against the cap, and records the one it held', async () => {
      const [row] = await insert(ids.document)
      const limits = { perMarkHour: 2, perPersonDay: 50 }
      const outcomes = []
      for (const n of [1, 2, 3]) {
        outcomes.push(
          await inOrg(ORG, () => db.transaction((tx) => wake.enqueueWake(tx, event(row.id, `cap-${STAMP}-${n}`), { limits })))
        )
      }
      expect(outcomes.map((outcome) => outcome.outcome)).toEqual(['queued', 'queued', 'suppressed'])
      expect(
        await count(sql`select count(*)::int as n from piloti_wakes where annotation_id = ${row.id}::uuid and status = 'suppressed' and reason = 'cap:mark-hour' and settled_at is not null`)
      ).toBe(1)
      // The same event a second time is not a second wake.
      const again = await inOrg(ORG, () => db.transaction((tx) => wake.enqueueWake(tx, event(row.id, `cap-${STAMP}-1`), { limits: { perMarkHour: 9, perPersonDay: 50 } })))
      expect(again.outcome).toBe('queued')
      expect(await count(sql`select count(*)::int as n from piloti_wakes where annotation_id = ${row.id}::uuid`)).toBe(3)
    })

    it('refuses a wake record that says it did not start without saying why', async () => {
      const [row] = await insert(ids.document)
      await expect(
        inOrg(ORG, () =>
          db.execute(sql`
            insert into piloti_wakes (id, organization_id, document_id, annotation_id, trigger_kind, event_id, actor_user_id, status, settled_at)
            values (gen_random_uuid(), ${ORG}, ${ids.document}::uuid, ${row.id}::uuid, 'thread_mention', 'e', ${USER}, 'refused', now())`)
        )
      ).rejects.toThrow()
    })

    it('keeps a delegation whole, on an open mark only, and a reply of Piloti’s does not hand it back', async () => {
      const [row] = await insert(ids.document)
      const delegated = await inOrg(ORG, () =>
        repo.updateDocumentAnnotation(ORG, ids.document, row.id, 'open', {
          delegation: { delegatedBy: USER, delegatedAt: new Date() },
        })
      )
      expect(delegated).toMatchObject({ delegatedBy: USER })
      await expect(
        inOrg(ORG, () => db.execute(sql`update document_annotations set delegated_at = null where id = ${row.id}::uuid`))
      ).rejects.toThrow()
      await expect(
        inOrg(ORG, () =>
          db.execute(sql`update document_annotations set status = 'resolved', closed_by = ${USER}, closed_at = now() where id = ${row.id}::uuid`)
        )
      ).rejects.toThrow()

      await inOrg(ORG, () =>
        repo.insertAnnotationReply({
          organizationId: ORG,
          annotationId: row.id,
          authorKind: 'piloti',
          body: 'Erledigt.',
          createdBy: USER,
        })
      )
      const after = await inOrg(ORG, () => repo.findDocumentAnnotation(ORG, ids.document, row.id))
      expect(after).toMatchObject({ delegatedBy: USER, delegatedAt: expect.any(Date) })
    })

    it('queues the stop of a started delegation wake in the delete’s transaction, before the wake goes with its mark', async () => {
      const [row] = await insert(ids.document)
      const delegatedAt = new Date()
      await inOrg(ORG, () =>
        repo.updateDocumentAnnotation(
          ORG,
          ids.document,
          row.id,
          'open',
          { delegation: { delegatedBy: USER, delegatedAt } },
          async (tx) => {
            await wake.enqueueWake(tx, {
              ...event(row.id, wakeIds.delegationEventId(row.id, delegatedAt)),
              trigger: 'assigned',
            })
          }
        )
      )
      await inOrg(ORG, () =>
        db.execute(sql`update piloti_wakes set status = 'started', settled_at = now() where annotation_id = ${row.id}::uuid`)
      )

      await inOrg(ORG, () =>
        repo.deleteDocumentAnnotation(ORG, ids.document, row.id, async (tx) => {
          await takeBack.readTakeBack(
            tx,
            { organizationId: ORG, documentId: ids.document, annotationId: row.id, delegatedAt },
            { stopTurn: true }
          )
        })
      )

      expect(await count(sql`select count(*)::int as n from piloti_wakes where annotation_id = ${row.id}::uuid`)).toBe(0)
      expect(
        await count(
          sql`select count(*)::int as n from bff_job_queue where kind = 'piloti_wake_stop' and payload->>'annotationId' = ${row.id}`
        )
      ).toBe(1)
    })

    it('shows another organization none of the wakes', async () => {
      const leaked = await inOrg(OTHER_ORG, () =>
        db.execute<{ n: number }>(sql`select count(*)::int as n from piloti_wakes`)
      )
      expect(Number(Array.from(leaked)[0]?.n)).toBe(0)
    })
  })
})
