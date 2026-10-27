/**
 * @vitest-environment node
 *
 * How long the documents SQL of the workspace search takes over a realistic
 * office (ADR-0136). A measurement, not a gate: it runs only when asked, and it
 * calls the repository functions themselves, through the runtime role under
 * row-level security, so every per-statement `SET LOCAL` batch and the pool are
 * in the number as in production. A script beside it would have to restate the
 * SQL the builders make, and a restated query measures the copy.
 *
 *   task fe:search:latency
 *
 * which is `SEARCH_LATENCY=1 bash scripts/rls-test-db.sh --only <this file>`.
 * Optional: SEARCH_LATENCY_RUNS (default 40), SEARCH_LATENCY_SCALE
 * (1 = 20,000 documents in the measured office), SEARCH_LATENCY_KEEP=1 to
 * leave the seed for EXPLAIN, TEST_OWNER_DATABASE_URL to ANALYZE after the
 * seed (the runtime role may not; without it the planner waits for autovacuum).
 *
 * The office: three organizations; the measured one has 120 projects, 20,000
 * documents (drawings, reports, minutes, photos), 5% held uploads of a
 * colleague, 3% archived, 10% superseded, 2% in a folder hidden from the
 * reader, a projection row each; 40,000 more across the other two.
 */

import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DossierDocumentType } from '@/lib/documents/dossier'
import type { DocumentMetadata } from '@/lib/documents/reconcile-status'
import { makeProject } from '@/test-utils/db-fixtures'
import type { DocumentQuery, FacetKey } from './document-repository'
import type { ReachedProject, SearchReach } from './reach'

vi.mock('server-only', () => ({}))

const url = process.env.TEST_DATABASE_URL
const enabled = Boolean(url) && process.env.SEARCH_LATENCY === '1'
const RUNS = Number(process.env.SEARCH_LATENCY_RUNS ?? 40)
const SCALE = Number(process.env.SEARCH_LATENCY_SCALE ?? 1)
const STAMP = Date.now()
const ORGS = [
  { id: `org_latency_${STAMP}`, projects: 120, documents: Math.round(20_000 * SCALE) },
  { id: `org_latency_b_${STAMP}`, projects: 80, documents: Math.round(25_000 * SCALE) },
  { id: `org_latency_c_${STAMP}`, projects: 40, documents: Math.round(15_000 * SCALE) },
]
const READER = 'user_latency_reader'
const COLLEAGUES = Array.from({ length: 15 }, (_, index) => `user_latency_${index}`)
const FACET_KEYS: FacetKey[] = ['documentType', 'tag', 'project', 'partyRole', 'municipality', 'cites', 'status', 'fileType']

/** A seeded PRNG (mulberry32), so two runs measure the same office. */
function random(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const TYPES: Array<[DossierDocumentType, number, string]> = [
  ['submission_drawing', 0.22, 'EP'],
  ['construction_drawing', 0.22, 'AP'],
  ['site_plan', 0.03, 'LP'],
  ['fire_safety_concept', 0.05, 'BS'],
  ['structural_analysis', 0.05, 'ST'],
  ['building_description', 0.04, 'BB'],
  ['energy_certificate', 0.02, 'EA'],
  ['permit', 0.03, 'BE'],
  ['meeting_minutes', 0.08, 'PR'],
  ['correspondence', 0.1, 'KO'],
  ['photo', 0.08, 'FO'],
  ['offer', 0.03, 'AN'],
  ['invoice', 0.03, 'RE'],
  ['other', 0.02, 'XX'],
]
const TOWNS: Array<[string, string]> = [
  ['Wien', 'Wien'],
  ['Graz', 'Steiermark'],
  ['Linz', 'Oberösterreich'],
  ['Salzburg', 'Salzburg'],
  ['Innsbruck', 'Tirol'],
  ['Klagenfurt', 'Kärnten'],
  ['St. Pölten', 'Niederösterreich'],
]
const NORMS: Array<[string, string, string]> = [
  ['norm', 'önorm b 1600', 'ÖNORM B 1600'],
  ['norm', 'önorm b 1800', 'ÖNORM B 1800'],
  ['norm', 'önorm b 8110-3', 'ÖNORM B 8110-3'],
  ['norm', 'önorm en 1991-1-1', 'ÖNORM EN 1991-1-1'],
  ['law', 'oib-rl 2', 'OIB-RL 2'],
  ['law', 'oib-rl 4', 'OIB-RL 4'],
  ['law', 'bo für wien § 81', '§ 81 BO für Wien'],
]
const CLASS_SPELLINGS = (n: number): string[] => [`GK ${n}`, ['I', 'II', 'III', 'IV', 'V'][n - 1], String(n), `Gebäudeklasse ${n}`]
const SUMMARIES: Partial<Record<DossierDocumentType, string[]>> = {
  submission_drawing: ['Einreichplan Grundriss mit Fluchtwegen', 'Schnitt und Ansicht zur Einreichung', 'Grundriss Obergeschoss, Brandabschnitte eingetragen'],
  construction_drawing: ['Polierplan Decke über Erdgeschoss', 'Ausführungsplan Fassade', 'Detail Attika und Dachrand'],
  fire_safety_concept: ['Brandschutz nach OIB-RL 2, Fluchtweglängen und Brandabschnitte', 'Brandschutzkonzept mit Rauchableitung', 'Brandschutz: Nachweis der Fluchtwege'],
  structural_analysis: ['Statische Berechnung Holzbau', 'Statik Stahlbetondecken', 'Tragwerksplanung Fundamente'],
  meeting_minutes: ['Protokoll Jour fixe, offene Punkte Brandschutz', 'Baubesprechung Rohbau', 'Protokoll Planungsbesprechung'],
  correspondence: ['Schreiben an die Baubehörde', 'Rückfrage zum Energieausweis', 'Mitteilung zur Planfreigabe'],
  permit: ['Baubewilligung mit Auflagen zum Brandschutz', 'Bescheid über die Benützungsbewilligung'],
}

interface SeededDocument {
  id?: string
  org: string
  projectIndex: number | null
  folder: 'none' | 'open' | 'hidden'
  filename: string
  collection: string
  createdBy: string
  createdAt: Date
  status: 'completed' | 'failed' | 'quarantined'
  lifecycle: 'active' | 'archived'
  outcome: 'clean' | 'quarantined'
  superseded: boolean
  metadata: DocumentMetadata
}

function pickType(roll: number): [DossierDocumentType, string] {
  let sum = 0
  for (const [type, share, prefix] of TYPES) {
    sum += share
    if (roll < sum) return [type, prefix]
  }
  return ['other', 'XX']
}

/** One organization's documents, deterministic in `seed`. */
function officeDocuments(org: (typeof ORGS)[number], seed: number, collections: string[], shelf: string): SeededDocument[] {
  const next = random(seed)
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]
  const out: SeededDocument[] = []
  for (let index = 0; index < org.documents; index++) {
    const onShelf = next() < 0.1
    const projectIndex = onShelf ? null : Math.floor(next() * org.projects)
    const [type, prefix] = pickType(next())
    const town = TOWNS[(projectIndex ?? index) % TOWNS.length]
    const buildingClass = 1 + ((projectIndex ?? 0) % 5)
    const drawing = type.endsWith('drawing') || type === 'site_plan'
    const planNumber = `${prefix}-${String(1 + Math.floor(next() * 60)).padStart(2, '0')}`
    const held = next() < 0.05
    const hidden = !onShelf && !held && next() < 0.02
    const references = Array.from({ length: Math.floor(next() * 4) }, () => pick(NORMS)).map(([kind, key, label]) => ({
      kind: kind as 'norm' | 'law',
      key,
      label,
      pages: [1],
    }))
    if (next() < 0.3) {
      const cited = `${pick(['EP', 'AP'])}-${String(1 + Math.floor(next() * 60)).padStart(2, '0')}`
      references.push({ kind: 'plan' as never, key: cited.toLowerCase().replace('-', ' '), label: cited, pages: [2] })
    }
    const pages = type === 'photo' ? 1 : drawing ? 1 + Math.floor(next() * 3) : 2 + Math.floor(next() * 80)
    const summary = pick(SUMMARIES[type] ?? ['Unterlage zum Projekt'])
    const year = 2024 + Math.floor(next() * 3)
    const day = `${year}-${String(1 + Math.floor(next() * 12)).padStart(2, '0')}-${String(1 + Math.floor(next() * 28)).padStart(2, '0')}`
    out.push({
      org: org.id,
      projectIndex,
      folder: hidden ? 'hidden' : !onShelf && next() < 0.6 ? 'open' : 'none',
      filename: `${drawing ? planNumber : type}_${summary.split(' ')[0]}_${index}.${type === 'photo' ? 'jpg' : next() < 0.05 ? 'dwg' : 'pdf'}`,
      collection: projectIndex === null ? shelf : collections[projectIndex],
      createdBy: held ? pick(COLLEAGUES) : next() < 0.2 ? READER : pick(COLLEAGUES),
      createdAt: new Date(Date.parse(`${day}T09:00:00Z`) + Math.floor(next() * 86_400_000)),
      status: held ? 'quarantined' : next() < 0.02 ? 'failed' : 'completed',
      lifecycle: next() < 0.03 ? 'archived' : 'active',
      outcome: held ? 'quarantined' : 'clean',
      superseded: next() < 0.1,
      metadata: {
        summary,
        pageCount: pages,
        tags: next() < 0.5 ? [pick(['plan', 'oib_2', 'oib_4', 'oib_6', 'gutachten'])] : [],
        topics: [pick(['Brandschutz', 'Statik', 'Fassade', 'Erschließung', 'Energie'])],
        ...(drawing
          ? {
              revisionFacts: {
                documentNumber: planNumber,
                revision: pick(['A', 'B', 'C', 'D', 'E', 'F']),
                revisionDate: day,
                scale: pick(['1:50', '1:100', '1:200', '1 : 100']),
                title: summary,
              },
            }
          : {}),
        ...(type === 'photo' ? { capture: { capturedAt: `${day.replace(/-/g, ':')} 10:31:00`, camera: 'Pixel 9' } } : {}),
        dossier: {
          documentType: type,
          title: `${summary} ${index}`,
          summary,
          parties: [
            { role: 'architect', name: `Atelier ${pick(['Nord', 'Süd', 'Ost', 'West'])} ZT GmbH` },
            ...(next() < 0.6 ? [{ role: pick(['client', 'engineer', 'authority', 'contractor'] as const), name: pick(['Wohnbau GmbH', 'Holz & Statik OG', 'Magistrat MA 37', 'Bau AG']) }] : []),
          ],
          dates: [{ kind: 'issued', date: day }],
          place: { address: `${pick(['Hauptstraße', 'Ringstraße', 'Bahnhofplatz'])} ${1 + Math.floor(next() * 90)}`, municipality: town[0], state: town[1] },
          facts:
            type === 'photo' || type === 'invoice'
              ? []
              : [
                  { key: 'building_class', value: pick(CLASS_SPELLINGS(buildingClass)), unit: null, page: 1, quote: null },
                  { key: 'storeys_above_ground', value: String(1 + Math.floor(next() * 8)), unit: null, page: 1, quote: null },
                  { key: 'gross_floor_area', value: String(200 + Math.floor(next() * 8000)), unit: 'm²', page: 1, quote: null },
                ],
        },
        docReferences: references,
        coverage: { pages, text: pages, transcribed: 0, drawings: 0, drawingsRead: 0, notRead: next() < 0.05 ? 1 : 0, reasons: {} },
      },
    })
  }
  return out
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}

describe.skipIf(!enabled)('search latency over a seeded office', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let repo: typeof import('./document-repository')
  let reach: SearchReach
  const contentKeys: string[] = []
  const results: Array<{ name: string; p50: number; p95: number; max: number; rows: number }> = []

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    withTenant = (await import('@/lib/db/tenant-context')).withTenant
    db = (await import('@/lib/db')).getDb()
    repo = await import('./document-repository')
    const schema = await import('@/lib/db/schema')
    const { toSearchFacets } = await import('./facets')
    const { upsertSearchFacets } = await import('./facets-repository')
    const started = performance.now()

    for (const [orgIndex, org] of ORGS.entries()) {
      const inTenant = <T>(run: () => Promise<T>): Promise<T> => withTenant({ organizationId: org.id, userId: READER }, run)
      const collections = Array.from({ length: org.projects }, (_, index) => `coll_latency_${orgIndex}_${index}_${STAMP}`)
      const shelf = `archiv_${org.id}`
      const projects = await inTenant(() =>
        db
          .insert(schema.projects)
          .values(collections.map((collectionName, index) => ({ organizationId: org.id, name: `Projekt ${index} ${TOWNS[index % TOWNS.length][0]}`, createdBy: READER, collectionName })))
          .returning()
      )
      const folders = await inTenant(() =>
        db
          .insert(schema.projectFolders)
          .values(projects.flatMap((project) => ['Einreichung', 'Vertraulich'].map((name) => ({ organizationId: org.id, projectId: project.id, name, path: name }))))
          .returning({ id: schema.projectFolders.id, projectId: schema.projectFolders.projectId, name: schema.projectFolders.name })
      )
      const folderOf = (projectId: string, name: string): string => folders.find((folder) => folder.projectId === projectId && folder.name === name)!.id
      const seeded = officeDocuments(org, 1000 + orgIndex, collections, shelf)
      for (let start = 0; start < seeded.length; start += 1000) {
        const batch = seeded.slice(start, start + 1000)
        const inserted = await inTenant(() =>
          db
            .insert(schema.documents)
            .values(
              batch.map((row) => {
                const project = row.projectIndex === null ? null : projects[row.projectIndex]
                return {
                  organizationId: org.id,
                  createdBy: row.createdBy,
                  filename: row.filename,
                  storageKey: `k/${org.id}/${row.filename}`,
                  collectionName: row.collection,
                  status: row.status,
                  scope: project ? ('project' as const) : ('office_shelf' as const),
                  projectId: project?.id ?? null,
                  folderId: project && row.folder !== 'none' ? folderOf(project.id, row.folder === 'hidden' ? 'Vertraulich' : 'Einreichung') : null,
                  contentType: row.filename.endsWith('.jpg') ? 'image/jpeg' : 'application/pdf',
                  createdAt: row.createdAt,
                  updatedAt: row.createdAt,
                  lifecycle: row.lifecycle,
                  screeningOutcome: row.outcome,
                }
              })
            )
            .returning({ id: schema.documents.id })
        )
        const facets = batch.flatMap((row, index) => {
          row.id = inserted[index].id
          const facet = toSearchFacets({ documentId: row.id, organizationId: org.id, superseded: row.superseded }, row.metadata)
          return facet ? [facet] : []
        })
        for (let at = 0; at < facets.length; at += 500) await upsertSearchFacets(org.id, facets.slice(at, at + 500))
      }
      if (orgIndex === 0) {
        reach = {
          organizationId: org.id,
          userId: READER,
          scope: { kind: 'office' },
          projects: projects.map(
            (project): ReachedProject => ({
              project: makeProject(project),
              hiddenFolderIds: [folderOf(project.id, 'Vertraulich')],
              collections: [project.collectionName],
              reviewsQuarantine: false,
            })
          ),
          officeShelf: { collection: shelf, reviewsQuarantine: false },
          folderIds: null,
        }
        const next = random(7)
        const readable = seeded.filter((row) => row.folder !== 'hidden' && row.status !== 'quarantined' && row.lifecycle === 'active')
        while (contentKeys.length < 50) {
          const row = readable[Math.floor(next() * readable.length)]
          contentKeys.push(repo.contentKey(row.collection, row.filename))
        }
      }
    }
    const owner = process.env.TEST_OWNER_DATABASE_URL
    if (owner) {
      const client = postgres(owner, { max: 1, onnotice: () => {} })
      await client`ANALYZE documents, document_search_facets, projects, project_folders`
      await client.end()
    }
    process.stdout.write(`seeded ${ORGS.map((org) => org.documents).join(' + ')} documents in ${Math.round(performance.now() - started)} ms${owner ? ', analyzed' : ', NOT analyzed'}\n`)
  }, 900_000)

  afterAll(async () => {
    if (!db) return
    if (process.env.SEARCH_LATENCY_KEEP !== '1') {
      const { withPlatformAccess } = await import('@/lib/db/tenant-context')
      await withPlatformAccess('test teardown', async () => {
        for (const org of ORGS) {
          await db.execute(sql`DELETE FROM document_search_facets WHERE organization_id = ${org.id}`)
          await db.execute(sql`DELETE FROM documents WHERE organization_id = ${org.id}`)
          await db.execute(sql`DELETE FROM project_folders WHERE organization_id = ${org.id}`)
          await db.execute(sql`DELETE FROM projects WHERE organization_id = ${org.id}`)
        }
      })
    }
    process.stdout.write(
      [
        `search latency, ${RUNS} runs each after 3 warm-up runs (ms)`,
        `${'query'.padEnd(58)} ${'p50'.padStart(7)} ${'p95'.padStart(7)} ${'max'.padStart(7)}  rows`,
        ...results.map(
          (result) =>
            `${result.name.padEnd(58)} ${result.p50.toFixed(1).padStart(7)} ${result.p95.toFixed(1).padStart(7)} ${result.max.toFixed(1).padStart(7)}  ${result.rows}`
        ),
      ].join('\n') + '\n'
    )
    const { closeDb } = await import('@/lib/db')
    await closeDb()
  })

  const query = (filters: DocumentQuery['filters'], text: DocumentQuery['text'] = null): DocumentQuery => ({ filters, text, citedBy: null, citing: null })

  async function measure(name: string, run: () => Promise<number>): Promise<void> {
    for (let warm = 0; warm < 3; warm++) await run()
    const timings: number[] = []
    let rows = 0
    for (let index = 0; index < RUNS; index++) {
      const started = performance.now()
      rows = await run()
      timings.push(performance.now() - started)
    }
    timings.sort((a, b) => a - b)
    results.push({ name, p50: percentile(timings, 50), p95: percentile(timings, 95), max: timings.at(-1)!, rows })
  }

  const page = { limit: 25, offset: 0, dir: 'asc' as const }

  it('office-wide, no text, first page by plan number', async () => {
    await measure('office, no text, plan_number asc, page 1 + total', async () => {
      const { rows, total } = await repo.searchDocumentPage(reach, query({}), { ...page, sort: 'plan_number' })
      expect(rows).toHaveLength(25)
      return total
    })
  })

  it('office-wide text "Brandschutz" with 50 content hits, by relevance', async () => {
    await measure('office, text "Brandschutz" + 50 content keys, relevance', async () => {
      const { total } = await repo.searchDocumentPage(reach, query({}, { text: 'Brandschutz', contentKeys }), { ...page, sort: 'relevance', dir: 'desc' })
      expect(total).toBeGreaterThan(50)
      return total
    })
  })

  it('office-wide type + fact range + cites', async () => {
    await measure('office, types + building_class 3..5 + cites "ÖNORM B 1600"', async () => {
      const { total } = await repo.searchDocumentPage(
        reach,
        query({ documentTypes: ['submission_drawing', 'fire_safety_concept'], facts: [{ key: 'building_class', min: 3, max: 5 }], cites: ['ÖNORM B 1600'] }),
        { ...page, sort: 'plan_number' }
      )
      expect(total).toBeGreaterThan(0)
      return total
    })
    await measure('office, same with cites as token "norm:önorm b 1600"', async () => {
      const { total } = await repo.searchDocumentPage(
        reach,
        query({ documentTypes: ['submission_drawing', 'fire_safety_concept'], facts: [{ key: 'building_class', min: 3, max: 5 }], cites: ['norm:önorm b 1600'] }),
        { ...page, sort: 'plan_number' }
      )
      return total
    })
  })

  it('one project, the register: current drawings by plan number', async () => {
    const one: SearchReach = { ...reach, scope: { kind: 'project', projectId: reach.projects[7].project.id }, projects: [reach.projects[7]], officeShelf: null }
    await measure('project, currentOnly register, plan_number asc, limit 100', async () => {
      const { total } = await repo.searchDocumentPage(one, query({ currentOnly: true }), { limit: 100, offset: 0, dir: 'asc', sort: 'plan_number' })
      expect(total).toBeGreaterThan(0)
      return total
    })
  })

  it('office-wide facet counts, all eight dimensions', async () => {
    await measure('office, documentFacetCounts x8, no filter', async () => {
      const facets = await repo.documentFacetCounts(reach, query({}), FACET_KEYS)
      return facets.documentType.reduce((sum, entry) => sum + entry.count, 0)
    })
    await measure('office, documentFacetCounts x8, text "Brandschutz"', async () => {
      const facets = await repo.documentFacetCounts(reach, query({}, { text: 'Brandschutz', contentKeys }), FACET_KEYS)
      return facets.documentType.reduce((sum, entry) => sum + entry.count, 0)
    })
  })

  it('office-wide completions, one keystroke each', async () => {
    const { suggestValues } = await import('./suggest-repository')
    // SUGGEST_EXPLAIN=1 prints the plan of a party completion: how the `raw` fence was found (suggest-repository.ts).
    if (process.env.SUGGEST_EXPLAIN === '1') {
      const { suggestStatement } = await import('./suggest-repository')
      const { getDb } = await import('@/lib/db')
      const { withTenant } = await import('@/lib/db/tenant-context')
      const { executeRows } = await import('@/lib/db/execute-rows')
      const plan = executeRows<Record<string, string>>(
        await withTenant({ organizationId: reach.organizationId }, async () =>
          getDb().execute(sql`EXPLAIN (ANALYZE, BUFFERS) ${suggestStatement(reach, query({}), { dimension: 'party', prefix: 'atel', limit: 10 })}`)
        )
      )
      process.stdout.write(plan.map((row) => Object.values(row)[0]).join('\n') + '\n')
    }
    await measure('office, suggest party "atel"', async () => {
      const values = await suggestValues(reach, query({}), { dimension: 'party', prefix: 'atel', limit: 10 })
      expect(values.length).toBeGreaterThan(0)
      return values.length
    })
    await measure('office, suggest cites "önorm"', async () => {
      const values = await suggestValues(reach, query({}), { dimension: 'cites', prefix: 'önorm', limit: 10 })
      return values.length
    })
    await measure('office, suggest planNumber "ep" under currentOnly', async () => {
      const values = await suggestValues(reach, query({ currentOnly: true }), { dimension: 'planNumber', prefix: 'ep', limit: 10 })
      return values.length
    })
  })
})
