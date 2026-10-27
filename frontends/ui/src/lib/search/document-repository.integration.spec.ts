/**
 * @vitest-environment node
 *
 * The documents SQL of the workspace search (ADR-0136) against a REAL Postgres,
 * through the restricted runtime role, so row-level security applies as in
 * production. The claims are about SQL: the reach is one predicate, every
 * filter means what `search-wire.ts` says, the text ranks content first, every
 * sort pages stably, and the page, the total and every facet count are over the
 * same set. A mocked drizzle handle cannot disagree with the fixture that
 * mocked it; this can.
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/search/document-repository.integration.spec.ts
 *
 * `task db:test:rls` (scripts/rls-test-db.sh) builds that database and runs it.
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DocumentMetadata } from '@/lib/documents/reconcile-status'
import { makeProject } from '@/test-utils/db-fixtures'
import type { DocumentQuery, DocumentSearchRow, FacetKey } from './document-repository'
import type { SearchReach } from './reach'
import type { DocumentFilters, SearchSort } from './search-wire'

vi.mock('server-only', () => ({}))

const url = process.env.GRID_TEST_DATABASE_URL
const STAMP = Date.now()
const ORG = `org_search_${STAMP}`
const ORG_B = `org_search_b_${STAMP}`
const ME = 'user_search_me'
const OTHER = 'user_search_other'
const C1 = `coll_search_p1_${STAMP}`
const C2 = `coll_search_p2_${STAMP}`
const CB = `coll_search_pb_${STAMP}`
const SHELF = `archiv_${ORG}`

type Where = 'p1' | 'p1-hidden' | 'p1-visible' | 'p2' | 'office' | 'pb'

interface Seed {
  key: string
  org?: typeof ORG | typeof ORG_B
  where: Where
  filename: string
  createdBy: string
  createdAt: string
  status?: string
  held?: boolean
  /** The screening verdict on record; default none, which passes once the row settled. */
  outcome?: 'clean'
  archived?: boolean
  contentType?: string
  superseded?: boolean
  /** No reading: the document has no projection row. */
  metadata: DocumentMetadata | null
}

const dossier = (fields: Partial<NonNullable<DocumentMetadata['dossier']>>): NonNullable<DocumentMetadata['dossier']> => ({
  documentType: null,
  title: null,
  summary: null,
  parties: [],
  dates: [],
  place: null,
  facts: [],
  ...fields,
})
const fact = (key: string, value: string) => ({ key, value, unit: null, page: 1, quote: null }) as never
const coverage = (pages: number, notRead: number) => ({
  pages,
  text: pages - notRead,
  transcribed: 0,
  drawings: 0,
  drawingsRead: 0,
  notRead,
  reasons: {},
})

/**
 * The office. A1..A13 in the measured organization, B1 in another one.
 * A7 sits in a hidden folder, A8 and A11 are other people's held uploads, A9
 * is the reader's own held upload, A10 is archived, A12 has no reading.
 */
const SEEDS: Seed[] = [
  {
    key: 'A1',
    where: 'p1-visible',
    filename: 'EP-05_Grundriss_EG_C.pdf',
    createdBy: OTHER,
    createdAt: '2026-03-01T10:00:00Z',
    metadata: {
      summary: 'Grundriss Erdgeschoss mit Fluchtwegen',
      tags: ['oib_2', 'plan'],
      revisionFacts: { documentNumber: 'EP-05', revision: 'C', revisionDate: '2026-03-10', scale: '1:100', title: 'Grundriss EG' },
      dossier: dossier({
        documentType: 'submission_drawing',
        parties: [
          { role: 'architect', name: 'Atelier Nord ZT GmbH' },
          { role: 'client', name: 'Wohnbau Gesellschaft' },
        ],
        dates: [{ kind: 'issued', date: '2026-03-12' }],
        place: { address: 'Hauptstraße 1', municipality: 'Wien', state: 'Wien' },
        facts: [fact('building_class', 'GK 4'), fact('storeys_above_ground', '5'), fact('building_height', '14,5')],
      }),
      docReferences: [
        { kind: 'norm', key: 'önorm b 1600', label: 'ÖNORM B 1600', pages: [1] },
        { kind: 'plan', key: 'ep 06', label: 'EP-06', pages: [1] },
      ],
      pageCount: 3,
      coverage: coverage(3, 0),
    },
  },
  {
    key: 'A2',
    where: 'p1',
    filename: 'EP-05_Grundriss_EG_B.pdf',
    createdBy: OTHER,
    // 00:30 on 1 March in Vienna: an upload of that day, though UTC says February.
    createdAt: '2026-02-28T23:30:00Z',
    superseded: true,
    metadata: {
      summary: 'Grundriss Erdgeschoss, ältere Fassung',
      tags: ['plan'],
      revisionFacts: { documentNumber: 'EP 05', revision: 'B', revisionDate: '2026-01-10', scale: '1 : 100' },
      dossier: dossier({
        documentType: 'submission_drawing',
        parties: [{ role: 'architect', name: 'Atelier Nord ZT GmbH' }],
        facts: [fact('building_class', 'IV')],
      }),
      pageCount: 2,
    },
  },
  {
    key: 'A3',
    where: 'p2',
    filename: 'Brandschutzkonzept.pdf',
    createdBy: ME,
    createdAt: '2026-04-02T08:00:00Z',
    metadata: {
      summary: 'Die Brandschutzpläne zeigen die Fluchtwege der Schule',
      tags: ['oib_2'],
      dossier: dossier({
        documentType: 'fire_safety_concept',
        title: 'Brandschutzkonzept Volksschule',
        parties: [{ role: 'engineer', name: 'Ingenieurbüro Süd' }],
        dates: [{ kind: 'issued', date: '2025-11-05' }],
        place: { municipality: 'Graz', state: 'Steiermark' },
        facts: [fact('building_class', '4'), fact('gross_floor_area', '2400')],
      }),
      docReferences: [
        { kind: 'plan', key: 'ep 05', label: 'siehe EP 05', pages: [4] },
        { kind: 'law', key: 'oib-rl 2', label: 'OIB-RL 2', pages: [2] },
      ],
      pageCount: 40,
      coverage: coverage(40, 2),
    },
  },
  {
    key: 'A4',
    where: 'p2',
    filename: 'Statik_Holzbau.pdf',
    createdBy: ME,
    createdAt: '2026-04-03T08:00:00Z',
    metadata: {
      summary: 'Statische Berechnung',
      dossier: dossier({
        documentType: 'structural_analysis',
        parties: [{ role: 'engineer', name: 'Holz & Statik OG' }],
        place: { municipality: 'Graz', state: 'Steiermark' },
        facts: [fact('storeys_above_ground', '3')],
      }),
      pageCount: 120,
      coverage: coverage(120, 0),
    },
  },
  {
    key: 'A5',
    where: 'office',
    filename: 'Foto_Baustelle.jpg',
    contentType: 'image/jpeg',
    createdBy: ME,
    createdAt: '2026-09-15T08:00:00Z',
    metadata: {
      summary: 'Baustelle, Rohbau',
      capture: { capturedAt: '2026:09:14 10:31:00', camera: 'Pixel 9' },
      dossier: dossier({ documentType: 'photo' }),
      pageCount: 1,
    },
  },
  {
    key: 'A6',
    where: 'office',
    filename: 'Bescheid.pdf',
    createdBy: OTHER,
    createdAt: '2026-05-02T08:00:00Z',
    metadata: {
      summary: 'Baubewilligung',
      dossier: dossier({
        documentType: 'permit',
        parties: [{ role: 'authority', name: 'Magistrat Wien MA 37' }],
        dates: [{ kind: 'issued', date: '2026-05-01' }],
        place: { municipality: 'Wien', state: 'Wien' },
      }),
      docReferences: [{ kind: 'plan', key: 'ep 05', label: 'EP-05', pages: [1] }],
      pageCount: 4,
    },
  },
  {
    key: 'A7',
    where: 'p1-hidden',
    filename: 'Geheim_Brandschutzplan.pdf',
    createdBy: ME,
    createdAt: '2026-04-10T08:00:00Z',
    metadata: {
      summary: 'Brandschutzpläne, vertraulich',
      tags: ['oib_2'],
      revisionFacts: { documentNumber: 'EP-07', revision: 'A', revisionDate: '2026-04-01', scale: '1:100' },
      dossier: dossier({
        documentType: 'fire_safety_concept',
        parties: [{ role: 'engineer', name: 'Geheim GmbH' }],
        place: { municipality: 'Wien', state: 'Wien' },
        facts: [fact('building_class', '4')],
      }),
      docReferences: [{ kind: 'norm', key: 'önorm b 1600', label: 'ÖNORM B 1600', pages: [1] }],
      pageCount: 9,
      coverage: coverage(9, 3),
    },
  },
  {
    key: 'A8',
    where: 'p1',
    filename: 'Upload_Brandschutzplan.pdf',
    createdBy: OTHER,
    createdAt: '2026-04-11T08:00:00Z',
    held: true,
    metadata: {
      summary: 'Brandschutzpläne aus dem Upload',
      dossier: dossier({
        documentType: 'fire_safety_concept',
        place: { municipality: 'Wien', state: 'Wien' },
        facts: [fact('building_class', '4')],
      }),
      docReferences: [{ kind: 'norm', key: 'önorm b 1600', label: 'ÖNORM B 1600', pages: [1] }],
      pageCount: 5,
    },
  },
  {
    key: 'A9',
    where: 'p1',
    filename: 'Mein_Upload.pdf',
    createdBy: ME,
    createdAt: '2026-04-12T08:00:00Z',
    held: true,
    metadata: null,
  },
  {
    key: 'A10',
    where: 'p1',
    filename: 'Archiv_Plan.pdf',
    createdBy: OTHER,
    createdAt: '2025-01-01T08:00:00Z',
    archived: true,
    metadata: { summary: 'Alter Plan', dossier: dossier({ documentType: 'submission_drawing' }) },
  },
  {
    key: 'A11',
    where: 'office',
    filename: 'Ablage_gehalten.pdf',
    createdBy: OTHER,
    createdAt: '2026-04-13T08:00:00Z',
    held: true,
    metadata: { summary: 'Gehalten', dossier: dossier({ documentType: 'correspondence' }) },
  },
  {
    key: 'A12',
    where: 'p1',
    filename: 'Notiz.txt',
    contentType: 'text/plain',
    createdBy: OTHER,
    createdAt: '2026-04-14T08:00:00Z',
    metadata: null,
  },
  {
    key: 'A13',
    where: 'p2',
    filename: 'Kaputt.dwg',
    contentType: 'image/vnd.dwg',
    createdBy: OTHER,
    createdAt: '2026-04-15T08:00:00Z',
    // Screened clean, then indexing failed: readable to all. Without a verdict
    // a failed upload stays held from everyone but its uploader (ADR-0086).
    status: 'failed',
    outcome: 'clean',
    metadata: {
      tags: ['plan'],
      revisionFacts: { documentNumber: 'AP-101', revision: 'a', revisionDate: '2025-12-01', scale: '1:50' },
      dossier: dossier({ documentType: 'construction_drawing' }),
    },
  },
  {
    key: 'B1',
    org: ORG_B,
    where: 'pb',
    filename: 'EP-05_Grundriss_EG_C.pdf',
    createdBy: ME,
    createdAt: '2026-03-01T10:00:00Z',
    metadata: {
      summary: 'Brandschutzpläne einer anderen Kanzlei',
      revisionFacts: { documentNumber: 'EP-05', revision: 'C', revisionDate: '2026-03-10', scale: '1:100' },
      dossier: dossier({
        documentType: 'submission_drawing',
        place: { municipality: 'Wien', state: 'Wien' },
        facts: [fact('building_class', '4')],
      }),
      docReferences: [{ kind: 'norm', key: 'önorm b 1600', label: 'ÖNORM B 1600', pages: [1] }],
    },
  },
]

/** What the reader may see office-wide with no flags: everything but A7, A8, A10, A11 and B1. */
const VISIBLE = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A9', 'A12', 'A13']
const FACET_KEYS: FacetKey[] = ['documentType', 'tag', 'project', 'partyRole', 'municipality', 'cites', 'status', 'fileType']
/** The sorts this spec states the expected order of; scale, folder and status are covered by their own cases. */
type CheckedSort = Exclude<SearchSort, 'relevance' | 'scale' | 'folder' | 'status' | 'author'>
const SORTS: CheckedSort[] = [
  'name',
  'added',
  'plan_number',
  'plan_index',
  'plan_date',
  'document_date',
  'document_type',
  'page_count',
  'project',
]

describe.skipIf(!url)('the search documents SQL against Postgres', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let repo: typeof import('./document-repository')
  const ids: Record<string, string> = {}
  const keyOf: Record<string, string> = {}
  const projectIds: Record<'p1' | 'p2' | 'pb', string> = { p1: '', p2: '', pb: '' }
  const folderIds: Record<'hidden' | 'visible', string> = { hidden: '', visible: '' }

  const inTenant = <T>(org: string, run: () => Promise<T>): Promise<T> => withTenant({ organizationId: org, userId: ME }, run)

  /** The reach the gates would build for ME office-wide, by hand. */
  function officeReach(overrides: { reviewP1?: boolean; reviewShelf?: boolean } = {}): SearchReach {
    return {
      organizationId: ORG,
      userId: ME,
      scope: { kind: 'office' },
      projects: [
        {
          project: makeProject({ id: projectIds.p1, organizationId: ORG, name: 'Wohnhaus Wien', collectionName: C1 }),
          hiddenFolderIds: [folderIds.hidden],
          collections: [C1],
          reviewsQuarantine: overrides.reviewP1 === true,
        },
        {
          project: makeProject({ id: projectIds.p2, organizationId: ORG, name: 'Volksschule Graz', collectionName: C2 }),
          hiddenFolderIds: [],
          collections: [C2],
          reviewsQuarantine: false,
        },
      ],
      officeShelf: { collection: SHELF, reviewsQuarantine: overrides.reviewShelf === true },
      folderIds: null,
    }
  }

  const query = (filters: DocumentFilters = {}, text: DocumentQuery['text'] = null): DocumentQuery => ({
    filters,
    text,
    citedBy: null,
    citing: null,
  })

  const ALL = { sort: 'added' as SearchSort, dir: 'desc' as const, limit: 100, offset: 0 }

  async function found(reach: SearchReach, q: DocumentQuery): Promise<string[]> {
    const { rows, total } = await repo.searchDocumentPage(reach, q, ALL)
    expect(total).toBe(rows.length)
    return rows.map((row) => keyOf[row.id]).sort()
  }

  const keys = (...names: string[]): string[] => [...names].sort()
  const contentKey = (name: string): string => {
    const seed = SEEDS.find((candidate) => candidate.key === name)!
    return repo.contentKey(collectionOf(seed.where), seed.filename)
  }

  function collectionOf(where: Where): string {
    if (where === 'office') return SHELF
    if (where === 'p2') return C2
    if (where === 'pb') return CB
    return C1
  }

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    withTenant = (await import('@/lib/db/tenant-context')).withTenant
    db = (await import('@/lib/db')).getDb()
    repo = await import('./document-repository')
    const { toSearchFacets } = await import('./facets')
    const { upsertSearchFacets } = await import('./facets-repository')

    const project = async (org: string, name: string, collection: string): Promise<string> => {
      const rows = await inTenant(org, () =>
        db.execute<{ id: string }>(sql`
          INSERT INTO projects (organization_id, name, created_by, collection_name)
          VALUES (${org}, ${name}, ${ME}, ${collection}) RETURNING id`)
      )
      return String(Array.from(rows)[0].id)
    }
    projectIds.p1 = await project(ORG, 'Wohnhaus Wien', C1)
    projectIds.p2 = await project(ORG, 'Volksschule Graz', C2)
    projectIds.pb = await project(ORG_B, 'Fremdes Projekt', CB)
    const folder = async (name: string): Promise<string> => {
      const rows = await inTenant(ORG, () =>
        db.execute<{ id: string }>(sql`
          INSERT INTO project_folders (organization_id, project_id, name, path)
          VALUES (${ORG}, ${projectIds.p1}::uuid, ${name}, ${name}) RETURNING id`)
      )
      return String(Array.from(rows)[0].id)
    }
    folderIds.hidden = await folder('Vertraulich')
    folderIds.visible = await folder('Einreichung')

    for (const seed of SEEDS) {
      const org = seed.org ?? ORG
      const scope = seed.where === 'office' ? 'office_shelf' : 'project'
      const projectId = seed.where === 'office' ? null : seed.where === 'p2' ? projectIds.p2 : seed.where === 'pb' ? projectIds.pb : projectIds.p1
      const folderId = seed.where === 'p1-hidden' ? folderIds.hidden : seed.where === 'p1-visible' ? folderIds.visible : null
      const status = seed.held ? 'quarantined' : (seed.status ?? 'completed')
      const rows = await inTenant(org, () =>
        db.execute<{ id: string }>(sql`
          INSERT INTO documents
            (organization_id, created_by, filename, storage_key, collection_name, status, scope, project_id, folder_id,
             content_type, created_at, lifecycle, screening_outcome)
          VALUES
            (${org}, ${seed.createdBy}, ${seed.filename}, ${`k/${seed.key}`}, ${collectionOf(seed.where)}, ${status},
             ${scope}, ${projectId}::uuid, ${folderId}::uuid, ${seed.contentType ?? 'application/pdf'},
             ${seed.createdAt}::timestamptz, ${seed.archived ? 'archived' : 'active'},
             ${seed.held ? 'quarantined' : (seed.outcome ?? null)})
          RETURNING id`)
      )
      const id = String(Array.from(rows)[0].id)
      ids[seed.key] = id
      keyOf[id] = seed.key
      const row = toSearchFacets({ documentId: id, organizationId: org, superseded: seed.superseded === true }, seed.metadata)
      if (row) expect(await upsertSearchFacets(org, [row])).toBe(1)
    }
  }, 120_000)

  afterAll(async () => {
    if (!db) return
    const { withPlatformAccess } = await import('@/lib/db/tenant-context')
    await withPlatformAccess('test teardown', async () => {
      for (const org of [ORG, ORG_B]) {
        await db.execute(sql`DELETE FROM document_search_facets WHERE organization_id = ${org}`)
        await db.execute(sql`DELETE FROM document_search_shelves WHERE organization_id = ${org}`)
        await db.execute(sql`DELETE FROM documents WHERE organization_id = ${org}`)
        await db.execute(sql`DELETE FROM project_folders WHERE organization_id = ${org}`)
        await db.execute(sql`DELETE FROM projects WHERE organization_id = ${org}`)
      }
    })
    const { closeDb } = await import('@/lib/db')
    await closeDb()
  })

  describe('authorization', () => {
    it('finds exactly what the reader may open office-wide', async () => {
      expect(await found(officeReach(), query())).toEqual(keys(...VISIBLE))
    })

    it('never names a hidden folder, a held upload of another person or another organization in a facet count', async () => {
      const facets = await repo.documentFacetCounts(officeReach(), query(), FACET_KEYS)
      const count = (facet: string, value: string): number => facets[facet].find((entry) => entry.value === value)?.count ?? 0
      // A3 only: A7 is hidden, A8 held, nothing of B1.
      expect(count('documentType', 'fire_safety_concept')).toBe(1)
      expect(count('documentType', 'correspondence')).toBe(0)
      // A1 only; A7 (hidden), A8 (held) and B1 (other office) cite it too.
      expect(count('cites', 'norm:önorm b 1600')).toBe(1)
      // A1 and A6; A7, A8 and B1 are in Wien too.
      expect(count('municipality', 'Wien')).toBe(2)
      // A1, A2, A9, A12: never A7, A8, A10.
      expect(count('project', projectIds.p1)).toBe(4)
      expect(count('project', projectIds.pb)).toBe(0)
      expect(count('status', 'quarantined')).toBe(1)
      expect(count('partyRole', 'engineer')).toBe(2)
      for (const entries of Object.values(facets)) {
        for (const entry of entries) expect(entry.value).not.toBe('Geheim GmbH')
      }
    })

    it('matches a hidden or held document by neither name, reading nor content key', async () => {
      const text = { text: 'Brandschutzplan', contentKeys: [contentKey('A7'), contentKey('A8'), contentKey('A11')] }
      expect(await found(officeReach(), query({}, text))).toEqual(keys('A3'))
      const facets = await repo.documentFacetCounts(officeReach(), query({}, text), ['documentType'])
      expect(facets.documentType).toEqual([{ value: 'fire_safety_concept', count: 1 }])
    })

    it('counts the facets of a text search alike in one statement and side by side', async () => {
      const text = { text: 'Grundriss', contentKeys: [contentKey('A4'), contentKey('A3')] }
      const once = await repo.facetCountsOnce(officeReach(), query({}, text), FACET_KEYS)
      const apart = await repo.facetCountsSideBySide(officeReach(), query({}, text), FACET_KEYS)
      expect(once).toEqual(apart)
      expect(Object.values(once).some((entries) => entries.length > 0)).toBe(true)
    })

    it('shows a held upload to its project reviewer, and the office shelf held one to the shelf reviewer', async () => {
      expect(await found(officeReach({ reviewP1: true }), query())).toEqual(keys(...VISIBLE, 'A8'))
      expect(await found(officeReach({ reviewShelf: true }), query())).toEqual(keys(...VISIBLE, 'A11'))
    })

    it('shows archived rows only when asked', async () => {
      expect(await found(officeReach(), query({ includeArchived: true }))).toEqual(keys(...VISIBLE, 'A10'))
    })

    it('narrows to a project, the office shelf and a folder subtree', async () => {
      const reach = officeReach()
      const p1Only: SearchReach = { ...reach, scope: { kind: 'project', projectId: projectIds.p1 }, projects: [reach.projects[0]], officeShelf: null }
      expect(await found(p1Only, query())).toEqual(keys('A1', 'A2', 'A9', 'A12'))
      expect(await found({ ...p1Only, folderIds: [folderIds.visible] }, query())).toEqual(keys('A1'))
      expect(await found({ ...p1Only, folderIds: [] }, query())).toEqual([])
      const shelf: SearchReach = { ...reach, scope: { kind: 'office_shelf' }, projects: [] }
      expect(await found(shelf, query())).toEqual(keys('A5', 'A6'))
      expect(await found({ ...reach, projects: [], officeShelf: null }, query())).toEqual([])
    })

    it('reads the folder path of each row from the shelf root, nested names joined by a slash, the root as empty', async () => {
      const [child] = Array.from(
        await inTenant(ORG, () =>
          db.execute<{ id: string }>(sql`
            INSERT INTO project_folders (organization_id, project_id, parent_id, name, path)
            VALUES (${ORG}, ${projectIds.p1}::uuid, ${folderIds.visible}::uuid, 'Grundrisse', 'Einreichung/Grundrisse')
            RETURNING id`)
        )
      )
      const move = (folderId: string): Promise<unknown> =>
        inTenant(ORG, () => db.execute(sql`UPDATE documents SET folder_id = ${folderId}::uuid WHERE id = ${ids.A1}::uuid`))
      await move(String(child.id))
      try {
        const { rows } = await repo.searchDocumentPage(officeReach(), query(), ALL)
        const pathOf = (key: string): string | undefined => rows.find((row) => row.id === ids[key])?.folderPath
        expect(pathOf('A1')).toBe('Einreichung/Grundrisse')
        expect(rows.find((row) => row.id === ids.A1)?.folderName).toBe('Grundrisse')
        expect(pathOf('A2')).toBe('')
        expect(pathOf('A5')).toBe('')
      } finally {
        await move(folderIds.visible)
        await inTenant(ORG, () => db.execute(sql`DELETE FROM project_folders WHERE id = ${String(child.id)}::uuid`))
      }
    })

    it('never crosses into another organization, even with its project in the reach', async () => {
      const reach = officeReach()
      const smuggled: SearchReach = {
        ...reach,
        projects: [...reach.projects, { ...reach.projects[0], project: makeProject({ id: projectIds.pb, organizationId: ORG_B }) }],
      }
      expect(await found(smuggled, query())).toEqual(keys(...VISIBLE))
    })

    it('reads a reference subject only in reach', async () => {
      const reach = officeReach()
      expect(await repo.readReferenceSubject(reach, ids.A1)).toEqual({
        planNumberKey: 'ep05',
        documentType: 'submission_drawing',
        referenceTokens: ['norm:önorm b 1600', 'plan:ep 06'],
      })
      expect(await repo.readReferenceSubject(reach, ids.A7)).toBeNull()
      expect(await repo.readReferenceSubject(reach, ids.A8)).toBeNull()
      expect(await repo.readReferenceSubject(reach, ids.B1)).toBeNull()
      expect(await repo.readReferenceSubject(officeReach({ reviewP1: true }), ids.A8)).not.toBeNull()
      // Archived is still a document one may cite.
      expect(await repo.readReferenceSubject(reach, ids.A10)).not.toBeNull()
    })
  })

  describe('filters', () => {
    const cases: Array<[string, DocumentFilters, string[]]> = [
      ['documentTypes', { documentTypes: ['fire_safety_concept', 'photo'] }, ['A3', 'A5']],
      ['tags, any of', { tags: ['oib_2'] }, ['A1', 'A3']],
      ['planNumber with spaces and hyphens ignored', { planNumber: 'ep 05' }, ['A1', 'A2']],
      ['planNumber as a prefix', { planNumber: 'EP-0' }, ['A1', 'A2']],
      ['planNumber that is not a prefix', { planNumber: 'P-05' }, []],
      ['planNumber does not take LIKE wildcards', { planNumber: 'E%' }, []],
      ['planIndex, any case', { planIndex: ['c', 'A'] }, ['A1', 'A13']],
      ['planDate from', { planDate: { from: '2026-02-01' } }, ['A1']],
      ['planDate to, inclusive', { planDate: { to: '2026-01-10' } }, ['A2', 'A13']],
      ['scale with spaces ignored', { scale: ['1:100'] }, ['A1', 'A2']],
      ['currentOnly keeps rows without a reading', { currentOnly: true }, ['A1', 'A3', 'A4', 'A5', 'A6', 'A9', 'A12', 'A13']],
      ['party by role', { parties: [{ role: 'engineer' }] }, ['A3', 'A4']],
      ['party by name, any case', { parties: [{ name: 'NORD' }] }, ['A1', 'A2']],
      ['party by role and name together', { parties: [{ role: 'client', name: 'nord' }] }, []],
      ['party name with LIKE characters', { parties: [{ name: 'Holz & Statik' }] }, ['A4']],
      ['two parties, all of', { parties: [{ role: 'architect' }, { role: 'client' }] }, ['A1']],
      ['place', { place: 'graz' }, ['A3', 'A4']],
      ['place by state', { place: 'Steiermark' }, ['A3', 'A4']],
      ['place by address', { place: 'hauptstraße' }, ['A1']],
      ['fact equals "GK 4"', { facts: [{ key: 'building_class', equals: 'GK 4' }] }, ['A1', 'A2', 'A3']],
      ['fact equals "IV"', { facts: [{ key: 'building_class', equals: 'IV' }] }, ['A1', 'A2', 'A3']],
      ['fact equals "4"', { facts: [{ key: 'building_class', equals: '4' }] }, ['A1', 'A2', 'A3']],
      ['fact min', { facts: [{ key: 'storeys_above_ground', min: 4 }] }, ['A1']],
      ['fact max', { facts: [{ key: 'storeys_above_ground', max: 3 }] }, ['A4']],
      ['fact range', { facts: [{ key: 'storeys_above_ground', min: 3, max: 5 }] }, ['A1', 'A4']],
      ['fact with a decimal comma', { facts: [{ key: 'building_height', min: 14.5, max: 14.5 }] }, ['A1']],
      ['two facts, all of', { facts: [{ key: 'building_class', equals: '4' }, { key: 'gross_floor_area', min: 2000 }] }, ['A3']],
      ['cites a token', { cites: ['norm:önorm b 1600'] }, ['A1']],
      ['cites a token in another case', { cites: ['NORM:ÖNORM B 1600'] }, ['A1']],
      ['cites as free text', { cites: ['ÖNORM B 1600'] }, ['A1']],
      ['cites a plan number as written elsewhere', { cites: ['EP-05'] }, ['A3', 'A6']],
      ['cites a law by its label', { cites: ['OIB-RL 2'] }, ['A3']],
      ['cites, all of', { cites: ['EP-05', 'OIB-RL 2'] }, ['A3']],
      ['documentDate', { documentDate: { from: '2026-01-01' } }, ['A1', 'A2', 'A6']],
      ['uploaded is a day in Vienna', { uploaded: { from: '2026-03-01', to: '2026-03-01' } }, ['A1', 'A2']],
      ['photographed', { photographed: { from: '2026-09-14', to: '2026-09-14' } }, ['A5']],
      ['uploadedBy', { uploadedBy: [ME] }, ['A3', 'A4', 'A5', 'A9']],
      ['states failed', { states: ['failed'] }, ['A13']],
      ['states held', { states: ['held'] }, ['A9']],
      ['states readable', { states: ['readable'] }, ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A12']],
      ['incompleteRead', { incompleteRead: true }, ['A3']],
      ['fileTypes', { fileTypes: ['jpg'] }, ['A5']],
      ['fileTypes, any of', { fileTypes: ['dwg', 'txt'] }, ['A12', 'A13']],
      ['pages min', { pages: { min: 100 } }, ['A4']],
      ['pages max', { pages: { max: 3 } }, ['A1', 'A2', 'A5']],
      ['pages range', { pages: { min: 4, max: 40 } }, ['A3', 'A6']],
      ['types and facts and cites together', { documentTypes: ['fire_safety_concept', 'submission_drawing'], facts: [{ key: 'building_class', min: 4 }], cites: ['EP-05'] }, ['A3']],
    ]

    it.each(cases)('%s', async (_label, filters, expected) => {
      expect(await found(officeReach(), query(filters))).toEqual(keys(...expected))
    })

    it('finds the documents a document cites, and those citing it', async () => {
      const citedBy = await repo.searchDocumentPage(officeReach(), { ...query(), citedBy: { planKeys: ['ep05'], documentTypes: [] } }, ALL)
      expect(citedBy.rows.map((row) => keyOf[row.id]).sort()).toEqual(keys('A1', 'A2'))
      const citing = await repo.searchDocumentPage(officeReach(), { ...query(), citing: { planKeys: ['ep05'], documentTypes: [] } }, ALL)
      expect(citing.rows.map((row) => keyOf[row.id]).sort()).toEqual(keys('A3', 'A6'))
    })
  })

  describe('text', () => {
    it('matches the name', async () => {
      expect(await found(officeReach(), query({}, { text: 'notiz', contentKeys: [] }))).toEqual(keys('A12'))
    })

    it('stems the reading: the singular finds the plural', async () => {
      const { rows } = await repo.searchDocumentPage(officeReach(), query({}, { text: 'Brandschutzplan', contentKeys: [] }), ALL)
      expect(rows.map((row) => keyOf[row.id])).toEqual(['A3'])
      expect(rows[0].matchedReading).toBe(true)
      expect(rows[0].matchedName).toBe(false)
      expect(await found(officeReach(), query({}, { text: 'Fluchtweg', contentKeys: [] }))).toEqual(keys('A1', 'A3'))
    })

    it('matches a plan number by its prefix, spaces and hyphens ignored', async () => {
      expect(await found(officeReach(), query({}, { text: 'EP05', contentKeys: [] }))).toEqual(keys('A1', 'A2'))
      expect(await found(officeReach(), query({}, { text: 'ap 1', contentKeys: [] }))).toEqual(keys('A13'))
    })

    it('ranks the content search first under relevance, in its order', async () => {
      const text = { text: 'Grundriss', contentKeys: [contentKey('A4'), contentKey('A3')] }
      const { rows, total } = await repo.searchDocumentPage(officeReach(), query({}, text), { ...ALL, sort: 'relevance' })
      expect(total).toBe(4)
      expect(rows.map((row) => keyOf[row.id]).slice(0, 2)).toEqual(['A4', 'A3'])
      expect(rows.map((row) => keyOf[row.id]).slice(2).sort()).toEqual(keys('A1', 'A2'))
      expect(rows[2].matchedName).toBe(true)
    })
  })

  describe('order, paging and counts', () => {
    const projectName: Record<string, string | null> = {}
    const seedValues = (seed: Seed): Record<CheckedSort, string | number | null> => {
      const revision = seed.metadata?.revisionFacts
      const dates = seed.metadata?.dossier?.dates ?? []
      return {
        name: seed.filename.toLowerCase(),
        added: Date.parse(seed.createdAt),
        plan_number: revision?.documentNumber ? revision.documentNumber.toLowerCase().replace(/[\s\-_]+/g, '') : null,
        plan_index: revision?.revision?.toLowerCase() ?? null,
        plan_date: revision?.revisionDate ?? null,
        document_date:
          dates.find((date) => date.kind === 'issued')?.date ?? dates.find((date) => date.kind === 'plan_date')?.date ?? revision?.revisionDate ?? null,
        document_type: seed.metadata?.dossier?.documentType ?? null,
        page_count: seed.metadata ? (seed.metadata.pageCount ?? seed.metadata.coverage?.pages ?? null) : null,
        project: projectName[seed.where] ?? null,
      }
    }

    function expectedOrder(sort: CheckedSort, dir: 'asc' | 'desc', names: string[]): string[] {
      projectName['p1'] = projectName['p1-visible'] = projectName['p1-hidden'] = 'wohnhaus wien'
      projectName['p2'] = 'volksschule graz'
      const rows = names.map((name) => ({ name, id: ids[name], value: seedValues(SEEDS.find((seed) => seed.key === name)!)[sort] }))
      return rows
        .sort((a, b) => {
          if (a.value === null || b.value === null) {
            if (a.value !== b.value) return a.value === null ? 1 : -1
          } else if (a.value !== b.value) {
            const less = a.value < b.value ? -1 : 1
            return dir === 'asc' ? less : -less
          }
          return a.id < b.id ? -1 : 1
        })
        .map((row) => row.name)
    }

    for (const sort of SORTS) {
      for (const dir of ['asc', 'desc'] as const) {
        it(`sorts by ${sort} ${dir}, nulls last, ties by id, and pages without a gap`, async () => {
          const expected = expectedOrder(sort, dir, VISIBLE)
          const whole = await repo.searchDocumentPage(officeReach(), query(), { sort, dir, limit: 100, offset: 0 })
          expect(whole.rows.map((row) => keyOf[row.id])).toEqual(expected)
          const paged: DocumentSearchRow[] = []
          for (let offset = 0; offset < expected.length + 2; offset += 2) {
            const page = await repo.searchDocumentPage(officeReach(), query(), { sort, dir, limit: 2, offset })
            expect(page.total).toBe(expected.length)
            paged.push(...page.rows)
          }
          expect(paged.map((row) => keyOf[row.id])).toEqual(expected)
        })
      }
    }

    const counted: Array<[string, SearchReach | (() => SearchReach), DocumentQuery | (() => DocumentQuery)]> = [
      ['everything', () => officeReach(), () => query()],
      ['a reviewer with archived rows', () => officeReach({ reviewP1: true, reviewShelf: true }), () => query({ includeArchived: true })],
      ['a filter', () => officeReach(), () => query({ facts: [{ key: 'building_class', equals: '4' }] })],
      ['a text', () => officeReach(), () => query({}, { text: 'Grundriss', contentKeys: [contentKey('A4')] })],
    ]

    it.each(counted)('counts facets over exactly the matched set: %s', async (_label, reachOf, queryOf) => {
      const reach = typeof reachOf === 'function' ? reachOf() : reachOf
      const q = typeof queryOf === 'function' ? queryOf() : queryOf
      const { rows, total } = await repo.searchDocumentPage(reach, q, { ...ALL, limit: 100 })
      expect(total).toBe(rows.length)
      const facets = await repo.documentFacetCounts(reach, q, FACET_KEYS)
      const tally = (values: Array<string | null | undefined>): Array<{ value: string; count: number }> => {
        const counts = new Map<string, number>()
        for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1)
        return [...counts].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : 1))
      }
      const seedOf = (row: DocumentSearchRow): Seed => SEEDS.find((seed) => seed.key === keyOf[row.id])!
      const sorted = (entries: Array<{ value: string; count: number }>) => [...entries].sort((a, b) => (a.value < b.value ? -1 : 1))
      expect(sorted(facets.documentType)).toEqual(sorted(tally(rows.map((row) => row.documentType))))
      expect(sorted(facets.project)).toEqual(sorted(tally(rows.map((row) => row.projectId))))
      expect(sorted(facets.status)).toEqual(sorted(tally(rows.map((row) => row.status.toLowerCase()))))
      expect(sorted(facets.fileType)).toEqual(sorted(tally(rows.map((row) => /\.([A-Za-z0-9]{1,8})$/.exec(row.filename)?.[1].toLowerCase()))))
      expect(sorted(facets.municipality)).toEqual(sorted(tally(rows.map((row) => row.municipality))))
      expect(sorted(facets.tag)).toEqual(sorted(tally(rows.flatMap((row) => [...new Set(seedOf(row).metadata?.tags ?? [])]))))
      expect(sorted(facets.partyRole)).toEqual(
        sorted(tally(rows.flatMap((row) => [...new Set((seedOf(row).metadata?.dossier?.parties ?? []).map((party) => party.role))]))))
      expect(sorted(facets.cites)).toEqual(
        sorted(tally(rows.flatMap((row) => [...new Set((seedOf(row).metadata?.docReferences ?? []).map((ref) => `${ref.kind}:${ref.key}`.toLowerCase()))]))))
    })
  })

  describe("a person's edit reaches the projection", () => {
    it('a Fassung decision flips „current only“ at once, and taking it back flips it again', async () => {
      const { toSearchFacets } = await import('./facets')
      const { upsertSearchFacets } = await import('./facets-repository')
      const seed = SEEDS.find((candidate) => candidate.key === 'A4')!
      const write = (superseded: boolean) =>
        upsertSearchFacets(ORG, [toSearchFacets({ documentId: ids.A4, organizationId: ORG, superseded }, seed.metadata)!])
      const current = () => found(officeReach(), query({ currentOnly: true }))

      expect(await write(true)).toBe(1)
      expect(await current()).not.toContain('A4')
      expect(await write(false)).toBe(1)
      expect(await current()).toContain('A4')
    })

    it('marks a synced shelf stale without unsyncing it, and lets the next search claim its refresh at once', async () => {
      const { claimShelfRefresh, markShelfSynced, markShelvesStale, readShelfSyncStates, STALE_FINGERPRINT } = await import(
        './facets-repository'
      )
      const { isStale } = await import('./shelf-projection')
      const p1 = { kind: 'project' as const, projectId: projectIds.p1 }
      const p2 = { kind: 'project' as const, projectId: projectIds.p2 }
      await markShelfSynced(ORG, p1, '7@x')
      expect(await claimShelfRefresh(ORG, p1, 10 * 60 * 1000)).toBe(true)
      // p2 has a claim and no sync: the CHECK keeps its fingerprint null.
      expect(await claimShelfRefresh(ORG, p2, 10 * 60 * 1000)).toBe(true)

      await markShelvesStale(ORG, [p1, p2])

      const states = new Map((await readShelfSyncStates(ORG, [`project:${projectIds.p1}`, `project:${projectIds.p2}`])).map((s) => [s.shelfKey, s]))
      const synced = states.get(`project:${projectIds.p1}`)!
      expect(synced.syncedAt).not.toBeNull()
      expect(synced.sourceFingerprint).toBe(STALE_FINGERPRINT)
      expect(isStale(synced, '7@x', new Date())).toBe(true)
      expect(states.get(`project:${projectIds.p2}`)!.sourceFingerprint).toBeNull()
      expect(await claimShelfRefresh(ORG, p1, 10 * 60 * 1000)).toBe(true)
      expect(await claimShelfRefresh(ORG, p2, 10 * 60 * 1000)).toBe(true)
    })

    it('finds the documents a settled Fassung names, by file name, in its collection and organization only', async () => {
      const { listCollectionDocumentsForProjection } = await import('./facets-repository')
      const a4 = SEEDS.find((candidate) => candidate.key === 'A4')!

      const listed = await listCollectionDocumentsForProjection(ORG, C2, [a4.filename, 'nicht-da.pdf'])

      expect(listed.map((row) => row.id)).toEqual([ids.A4])
      expect(await listCollectionDocumentsForProjection(ORG_B, C2, [a4.filename])).toEqual([])
      expect(await listCollectionDocumentsForProjection(ORG, C1, [a4.filename])).toEqual([])
    })
  })
})
