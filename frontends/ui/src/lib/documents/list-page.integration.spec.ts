/**
 * @vitest-environment node
 *
 * The document listing's keyset pager, against a REAL Postgres.
 *
 * The unit spec pins the statement; this one proves the claim the statement
 * exists for: following `nextCursor` visits every row exactly once, in the
 * listing's order, when rows share a timestamp and when they differ by less
 * than a millisecond — the case a cursor built from a JS `Date` gets wrong.
 * It runs under `task db:test:rls`, through the restricted runtime role:
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/documents/list-page.integration.spec.ts
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { memberReader, REVIEWER_READER } from '@/lib/documents/document-reader'

vi.mock('server-only', () => ({}))

const url = process.env.GRID_TEST_DATABASE_URL
const ORG = `org_listpage_${Date.now()}`
const USER = 'user_listpage'

/**
 * Timestamps with two exact ties and three rows inside ONE millisecond: a
 * cursor truncated to milliseconds would re-serve or drop some of them.
 */
const CREATED_AT = [
  '2026-03-01 10:00:00.000900+00',
  '2026-03-01 10:00:00.000500+00',
  '2026-03-01 10:00:00.000500+00',
  '2026-03-01 10:00:00.000100+00',
  '2026-02-01 09:00:00+00',
  '2026-02-01 09:00:00+00',
  '2026-01-01 08:00:00.123456+00',
]

describe.skipIf(!url)('document listing pages against Postgres', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let repo: typeof import('./repository')
  let officeShelf: typeof import('@/lib/office-shelf/repository')
  let projectId: string

  const inTenant = <T>(run: () => Promise<T>): Promise<T> =>
    withTenant({ organizationId: ORG, userId: USER }, run)

  async function seed(scope: 'project' | 'archiv', prefix: string): Promise<void> {
    for (const [index, createdAt] of CREATED_AT.entries()) {
      const collection = scope === 'project' ? 'coll_listpage' : `archiv_${ORG}`
      await inTenant(() =>
        db.execute(sql`
          INSERT INTO documents
            (organization_id, created_by, filename, storage_key, collection_name, status,
             scope, project_id, created_at)
          VALUES
            (${ORG}, ${USER}, ${`${prefix}-${index}.pdf`}, ${`k/${prefix}/${index}`}, ${collection},
             'completed', ${scope}, ${scope === 'project' ? projectId : null}::uuid, ${createdAt}::timestamptz)
        `),
      )
    }
  }

  /** The order the listing promises, as Postgres itself computes it. */
  async function expectedIds(scope: 'project' | 'archiv'): Promise<string[]> {
    const rows = await inTenant(async () =>
      Array.from(
        await db.execute<{ id: string }>(sql`
          SELECT id FROM documents WHERE organization_id = ${ORG} AND scope = ${scope}
          ORDER BY created_at DESC, id ASC
        `),
      ),
    )
    return rows.map((row) => String(row.id))
  }

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    const context = await import('@/lib/db/tenant-context')
    withTenant = context.withTenant
    db = (await import('@/lib/db')).getDb()
    repo = await import('./repository')
    officeShelf = await import('@/lib/office-shelf/repository')

    const rows = await inTenant(() =>
      db.execute<{ id: string }>(sql`
        INSERT INTO projects (organization_id, name, created_by, collection_name)
        VALUES (${ORG}, 'Listing', ${USER}, 'coll_listpage')
        RETURNING id
      `),
    )
    projectId = String(Array.from(rows)[0].id)
    await seed('project', 'plan')
    await seed('archiv', 'norm')
  }, 60_000)

  afterAll(async () => {
    if (!db) return
    const { withPlatformAccess } = await import('@/lib/db/tenant-context')
    await withPlatformAccess('test teardown', async () => {
      await db.execute(sql`DELETE FROM documents WHERE organization_id = ${ORG}`)
      await db.execute(sql`DELETE FROM project_folders WHERE organization_id = ${ORG}`)
      await db.execute(sql`DELETE FROM projects WHERE organization_id = ${ORG}`)
    })
    const { closeDb } = await import('@/lib/db')
    await closeDb()
  })

  it('visits every project document once, in order, two rows a page', async () => {
    const seen: string[] = []
    let cursor: import('./list-cursor').DocumentListCursor | undefined
    for (let guard = 0; guard < 10; guard++) {
      const page = await repo.listProjectDocumentPage(projectId, ORG, { limit: 2, cursor, reader: REVIEWER_READER })
      seen.push(...page.rows.map((row) => row.id))
      if (!page.nextCursor) break
      cursor = page.nextCursor
    }
    expect(seen).toEqual(await expectedIds('project'))
    expect(seen).toHaveLength(CREATED_AT.length)
  })

  it('visits every Archiv document once, in order, three rows a page', async () => {
    const seen: string[] = []
    let cursor: import('./list-cursor').DocumentListCursor | undefined
    for (let guard = 0; guard < 10; guard++) {
      const page = await inTenant(() => officeShelf.listOfficeShelfDocuments(ORG, { limit: 3, cursor, reader: REVIEWER_READER }))
      seen.push(...page.rows.map((row) => row.id))
      if (!page.nextCursor) break
      cursor = page.nextCursor
    }
    expect(seen).toEqual(await expectedIds('archiv'))
  })

  it('says a full last page is the last one', async () => {
    const page = await repo.listProjectDocumentPage(projectId, ORG, { limit: CREATED_AT.length, reader: REVIEWER_READER })
    expect(page.rows).toHaveLength(CREATED_AT.length)
    expect(page.nextCursor).toBeNull()
  })

  /**
   * The rescan job's walk over the failed set: oldest first, a keyset instead
   * of an exclusion list, so rows that STAY failed cannot starve the rows behind
   * them and the job's whole position is one cursor it keeps in its payload.
   */
  it('walks the failed documents once each, oldest first, ignoring the ones that were read', async () => {
    const statuses = ['failed', 'failed', 'uploaded', 'failed', 'completed', 'failed', 'failed']
    await inTenant(async () => {
      for (const [index, createdAt] of CREATED_AT.entries()) {
        await db.execute(sql`
          INSERT INTO documents
            (organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id, created_at)
          VALUES
            (${ORG}, ${USER}, ${`failedwalk-${index}.pdf`}, ${`k/failedwalk/${index}`}, 'coll_listpage',
             ${statuses[index]}, 'project', ${projectId}::uuid, ${createdAt}::timestamptz)
        `)
      }
    })
    const expected = await inTenant(async () =>
      Array.from(
        await db.execute<{ id: string }>(sql`
          SELECT id FROM documents
          WHERE organization_id = ${ORG} AND status IN ('failed', 'uploaded')
          ORDER BY created_at ASC, id ASC
        `),
      ).map((row) => String(row.id)),
    )

    const seen: string[] = []
    let cursor: import('./list-cursor').DocumentListCursor | null = null
    for (let guard = 0; guard < 10; guard++) {
      const page: Awaited<ReturnType<typeof repo.listFailedDocumentPageInOrg>> =
        await repo.listFailedDocumentPageInOrg(ORG, { limit: 2, cursor })
      seen.push(...page.ids)
      if (!page.nextCursor) break
      cursor = page.nextCursor
    }

    expect(expected).toHaveLength(6)
    expect(seen).toEqual(expected)
  })

  it('finds an Archiv document by name whatever page it is on', async () => {
    const oldest = `norm-${CREATED_AT.length - 1}.pdf`
    const rows = await inTenant(() => officeShelf.findOfficeShelfDocumentsByFilenames(ORG, [oldest], { reader: REVIEWER_READER }))
    expect(rows.map((row) => row.filename)).toEqual([oldest])
  })

  // The upload planner's probe answers with the rows the upload would version:
  // archived ones too, a name in the other Unicode form, a rename or a case
  // variant as recognition — and never a machine-authored namesake.
  it('probes names the way the upload matches them', async () => {
    const decomposed = 'Übersicht.pdf'.normalize('NFD')
    await inTenant(async () => {
      await db.execute(sql`UPDATE documents SET lifecycle = 'archived'
        WHERE organization_id = ${ORG} AND filename = 'plan-6.pdf'`)
      await db.execute(sql`UPDATE documents SET display_name = 'Grundriss EG.pdf'
        WHERE organization_id = ${ORG} AND filename = 'plan-5.pdf'`)
      await db.execute(sql`
        INSERT INTO documents
          (organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id)
        VALUES
          (${ORG}, ${USER}, ${decomposed}, 'k/nfd', 'coll_listpage', 'completed', 'project', ${projectId}::uuid)
      `)
      // A machine-authored namesake: it coexists with the person's file and
      // must never be offered to the planner as the document to replace.
      await db.execute(sql`
        INSERT INTO documents
          (organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id,
           authored_by, authored_by_ref, authored_by_ref_kind, authored_by_producer)
        VALUES
          (${ORG}, ${USER}, 'plan-0.pdf', 'k/agent', 'coll_listpage', 'stored', 'project', ${projectId}::uuid,
           'agent', 'run-1', 'agent_run', 'report')
      `)
    })

    const rows = await repo.findProjectDocumentsByNames(projectId, ORG, [
      'plan-6.pdf',
      'PLAN-1.PDF',
      'Übersicht.pdf'.normalize('NFC'),
      'grundriss eg.pdf',
      'plan-0.pdf',
    ], { reader: REVIEWER_READER })

    const byName = Object.fromEntries(rows.map((row) => [row.filename, row]))
    expect(Object.keys(byName).sort()).toEqual(
      ['plan-0.pdf', 'plan-1.pdf', 'plan-5.pdf', 'plan-6.pdf', decomposed].sort(),
    )
    expect(byName['plan-6.pdf'].lifecycle).toBe('archived')
    expect(byName['plan-0.pdf'].authoredBy).toBe('user')
  })

  /**
   * A folder LEVEL, page by page (ADR-0102). Each order is walked two rows a
   * page and compared with the order Postgres itself computes for the same
   * expression: every row of the level exactly once, none from another level,
   * and a held row only for the readers the hold lets see it.
   */
  describe('a folder level', () => {
    let folderId: string
    /** Names that tie once case-folded, a rename, sizes that tie and one unknown, timestamps that tie. */
    const LEVEL_ROWS: Array<{ name: string; display: string | null; size: number | null; at: string; status: string }> = [
      { name: 'b.pdf', display: null, size: 300, at: '2026-04-01 10:00:00.000500+00', status: 'completed' },
      { name: 'A.pdf', display: null, size: 300, at: '2026-04-01 10:00:00.000500+00', status: 'completed' },
      { name: 'a.pdf', display: null, size: null, at: '2026-04-01 10:00:00.000100+00', status: 'failed' },
      { name: 'z.pdf', display: 'Aa Umbenannt.pdf', size: 10, at: '2026-03-01 09:00:00+00', status: 'pending' },
      { name: 'c.pdf', display: null, size: 5000, at: '2026-02-01 08:00:00.123456+00', status: 'completed' },
      { name: 'held.pdf', display: null, size: 1, at: '2026-01-15 08:00:00+00', status: 'quarantined' },
    ]
    const ORDER_BY: Record<'added' | 'name' | 'size', string> = {
      added: 'created_at',
      name: 'lower(coalesce(display_name, filename))',
      size: 'coalesce(file_size, -1)',
    }

    beforeAll(async () => {
      const folders = await inTenant(() =>
        db.execute<{ id: string }>(sql`
          INSERT INTO project_folders (organization_id, project_id, name, path)
          VALUES (${ORG}, ${projectId}::uuid, 'Ebene', 'Ebene')
          RETURNING id
        `),
      )
      folderId = String(Array.from(folders)[0].id)
      await inTenant(async () => {
        for (const [index, row] of LEVEL_ROWS.entries()) {
          await db.execute(sql`
            INSERT INTO documents
              (organization_id, created_by, filename, display_name, file_size, storage_key, collection_name, status,
               scope, project_id, folder_id, created_at)
            VALUES
              (${ORG}, ${USER}, ${`level-${row.name}`}, ${row.display}, ${row.size}, ${`k/level/${index}`}, 'coll_listpage',
               ${row.status}, 'project', ${projectId}::uuid, ${folderId}::uuid, ${row.at}::timestamptz)
          `)
        }
        // Archived: it has left the working set, so no level shows it.
        await db.execute(sql`
          INSERT INTO documents
            (organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id, folder_id,
             lifecycle)
          VALUES
            (${ORG}, ${USER}, 'level-archived.pdf', 'k/level/archived', 'coll_listpage', 'completed', 'project',
             ${projectId}::uuid, ${folderId}::uuid, 'archived')
        `)
      })
    })

    async function expectedLevel(sort: 'added' | 'name' | 'size', dir: 'asc' | 'desc'): Promise<string[]> {
      const rows = await inTenant(async () =>
        Array.from(
          await db.execute<{ id: string }>(sql`
            SELECT id FROM documents
            WHERE organization_id = ${ORG} AND scope = 'project' AND project_id = ${projectId}::uuid
              AND folder_id = ${folderId}::uuid AND lifecycle = 'active'
            ORDER BY ${sql.raw(ORDER_BY[sort])} ${sql.raw(dir.toUpperCase())}, id ASC
          `),
        ),
      )
      return rows.map((row) => String(row.id))
    }

    async function walk(
      level: Omit<import('./list-query').DocumentLevelQuery, 'cursor' | 'limit'>,
      reader: import('./document-reader').ShelfReader = REVIEWER_READER,
    ): Promise<string[]> {
      const seen: string[] = []
      let cursor: import('./list-cursor').DocumentLevelCursor | undefined
      for (let guard = 0; guard < 20; guard++) {
        const page = await repo.listDocumentLevelPage({ kind: 'project', projectId }, ORG, {
          reader,
          level: { ...level, limit: 2, cursor },
        })
        seen.push(...page.rows.map((row) => row.id))
        if (!page.nextCursor) break
        cursor = page.nextCursor
      }
      return seen
    }

    it.each([
      ['added', 'desc'],
      ['added', 'asc'],
      ['name', 'asc'],
      ['name', 'desc'],
      ['size', 'desc'],
      ['size', 'asc'],
    ] as const)('visits every row of the level once, in %s %s order', async (sort, dir) => {
      const seen = await walk({ folderId, sort, dir })
      expect(seen).toEqual(await expectedLevel(sort, dir))
      expect(new Set(seen).size).toBe(LEVEL_ROWS.length)
    })

    it('keeps the level to its folder, and the root to the root', async () => {
      const inFolder = new Set(await walk({ folderId, sort: 'added', dir: 'desc' }))
      const root = await walk({ folderId: null, sort: 'added', dir: 'desc' })
      expect(root.length).toBeGreaterThan(0)
      expect(root.filter((id) => inFolder.has(id))).toEqual([])
    })

    it('shows a held row to its uploader and the reviewers only', async () => {
      const everyone = await walk({ folderId, sort: 'name', dir: 'asc' })
      const uploader = await walk({ folderId, sort: 'name', dir: 'asc' }, memberReader(USER))
      const colleague = await walk({ folderId, sort: 'name', dir: 'asc' }, memberReader('user_listpage_other'))
      expect(uploader).toEqual(everyone)
      // Only a settled read passes the hold without a verdict (ADR-0086): the
      // quarantined, the pending and the failed upload are the uploader's alone.
      expect(colleague).toHaveLength(3)
      expect(everyone.filter((id) => colleague.includes(id))).toEqual(colleague)
    })

    it('finds a name anywhere on the shelf, case-insensitively, by the file name or the rename', async () => {
      const byFile = await walk({ sort: 'name', dir: 'asc', q: 'LEVEL-A' })
      expect(byFile).toHaveLength(2)
      const byRename = await walk({ sort: 'name', dir: 'asc', q: 'umbenannt' })
      expect(byRename).toHaveLength(1)
    })

    it('narrows to read-state families', async () => {
      expect(await walk({ folderId, sort: 'added', dir: 'desc', states: ['failed'] })).toHaveLength(1)
      // `pending` is being read; nothing else in the level is.
      expect(await walk({ folderId, sort: 'added', dir: 'desc', states: ['reading'] })).toHaveLength(1)
    })

    it('counts the level in the shelf summary by family, archived and held rows as the listing has them', async () => {
      const rows = await repo.summarizeShelfFolders({ kind: 'project', projectId }, ORG, { reader: REVIEWER_READER })
      expect(rows.find((row) => row.folderId === folderId)).toMatchObject({
        total: 6,
        readable: 3,
        reading: 1,
        failed: 1,
        held: 1,
        unindexed: 0,
        latest: '2026-04-01T10:00:00.000Z',
      })
      const colleague = await repo.summarizeShelfFolders({ kind: 'project', projectId }, ORG, {
        reader: memberReader('user_listpage_other'),
      })
      expect(colleague.find((row) => row.folderId === folderId)).toMatchObject({
        total: 3,
        readable: 3,
        reading: 0,
        failed: 0,
        held: 0,
      })
    })
  })
})
