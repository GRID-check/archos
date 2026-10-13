/**
 * @vitest-environment node
 *
 * The reads behind „Was Piloti tut" against a REAL Postgres through the
 * restricted runtime role:
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/piloti-activity/reads.integration.spec.ts
 *
 * One project with every kind of record the view reads, and beside it what
 * must never reach a row: a held upload, a document in a folder closed to the
 * reader, a document of another project, a Büroablage document, another
 * organization's; a private conversation of somebody else, a deleted one and
 * one of another project. Each new query of the five repositories is asked,
 * and each claim is about SQL a mocked handle cannot disagree with:
 *
 *   - the wakes, live and ended, and the proposed marks, are the project's
 *     documents' that the reader may see, newest first, with their marks, a
 *     suppressed or too-old wake left out, and the LIMIT kept;
 *   - the held upload is its uploader's, the closed folder opens when no
 *     folder is hidden: the gate is the reader's, not a blanket filter;
 *   - the proposals, open and decided, follow `requireReadableProposal`: no
 *     conversation is the project's, a conversation must be open to the
 *     reader (public in the project, theirs, or granted), not deleted, and in
 *     this project;
 *   - a turn's changes count only the reader's documents, in a conversation
 *     they may open, since `since`;
 *   - the runs are the project's, active or finished since `since`;
 *   - the link gate and the batched document names keep the same rules.
 *
 * `task db:test:rls` (scripts/rls-test-db.sh) runs it with the other suites.
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ProjectDocumentGate } from '@/lib/documents/repository'

vi.mock('server-only', () => ({}))

const url = process.env.GRID_TEST_DATABASE_URL
const STAMP = Date.now()
const ORG = `org_activity_${STAMP}`
const OTHER_ORG = `${ORG}_other`
/** The reader. */
const ME = `user_activity_${STAMP}`
/** A colleague: uploads the held file, owns the private thread. */
const ANNA = `${ME}_anna`

const minutesAgo = (minutes: number) => new Date(STAMP - minutes * 60_000)
const SINCE = minutesAgo(60)

describe('the Piloti activity reads suite is not silently skipped in CI', () => {
  it('has a database to run against', () => {
    if (!process.env.GRID_RLS_SUITE_REQUIRED) return
    expect(url, 'GRID_TEST_DATABASE_URL is unset while GRID_RLS_SUITE_REQUIRED is set').toBeTruthy()
  })
})

describe.skipIf(!url)('the Piloti activity reads against live Postgres', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let withPlatformAccess: typeof import('@/lib/db/tenant-context').withPlatformAccess
  let annotations: typeof import('@/lib/annotations/repository')
  let wakes: typeof import('@/lib/annotations/wake-repository')
  let proposals: typeof import('@/lib/proposals/repository')
  let changes: typeof import('@/lib/changes/repository')
  let tasks: typeof import('@/lib/tasks/repository')
  let conversations: typeof import('@/lib/conversations/repository')
  let documents: typeof import('@/lib/documents/repository')
  let memberReader: typeof import('@/lib/documents/visibility').memberReader

  const ids: Record<string, string> = {}
  const inOrg = <T>(organizationId: string, run: () => PromiseLike<T>) => withTenant({ organizationId, userId: ME }, run)
  const first = (rows: Iterable<{ id: unknown }>) => String(Array.from(rows)[0]?.id)
  const exec = (organizationId: string, statement: ReturnType<typeof sql>) =>
    inOrg(organizationId, () => db.execute<{ id: string }>(statement))

  /** The reader's gate in the project: as the overview reads it, with the folder hidden unless a test opens it. */
  const gate = (extra: Partial<ProjectDocumentGate> = {}): ProjectDocumentGate => ({
    organizationId: ORG,
    projectId: ids.project,
    reader: memberReader(ME),
    hiddenFolderIds: [ids.closedFolder],
    ...extra,
  })

  async function project(organizationId: string, name: string): Promise<string> {
    return first(
      await exec(
        organizationId,
        sql`insert into projects (organization_id, name, created_by, collection_name)
            values (${organizationId}, ${name}, ${ME}, ${`proj_act_${name}_${STAMP}`}) returning id`
      )
    )
  }

  async function document(
    organizationId: string,
    projectId: string | null,
    filename: string,
    extra: { status?: string; createdBy?: string; folderId?: string; displayName?: string } = {}
  ): Promise<string> {
    const scope = projectId ? 'project' : 'archiv'
    const held = extra.status === 'quarantined'
    return first(
      await exec(
        organizationId,
        sql`insert into documents (organization_id, project_id, scope, filename, display_name, storage_key, collection_name,
                                   created_by, status, screening_outcome, folder_id)
            values (${organizationId}, ${projectId}::uuid, ${scope}, ${filename}, ${extra.displayName ?? null},
                    ${`k/${STAMP}/${organizationId}/${filename}`}, ${projectId ? `proj_act_${projectId}` : `archiv_${organizationId}`},
                    ${extra.createdBy ?? ME}, ${extra.status ?? 'completed'}, ${held ? 'quarantined' : 'clean'},
                    ${extra.folderId ?? null}::uuid)
            returning id`
      )
    )
  }

  /** Marks on a document: a person's are open, Piloti's are proposals. */
  async function marks(documentId: string, bodies: string[], authorKind: 'person' | 'piloti' = 'person') {
    const rows = await inOrg(ORG, () =>
      annotations.insertDocumentAnnotations({
        organizationId: ORG,
        documentId,
        versionId: null,
        authorKind,
        createdBy: ME,
        marks: bodies.map((body) => ({
          page: 2,
          shape: 'point' as const,
          x: 0.5,
          y: 0.5,
          w: null,
          h: null,
          kind: 'defect' as const,
          body,
          basis: null,
          assigneeUserId: null,
          dueOn: null,
        })),
      })
    )
    return rows.map((row) => row.id)
  }

  async function wake(
    documentId: string,
    annotationId: string,
    status: string,
    at: { created: number; ended?: number },
    reason: string | null = null
  ): Promise<string> {
    const settled = status === 'queued' ? null : minutesAgo(at.ended ?? at.created).toISOString()
    const ended = at.ended === undefined ? null : minutesAgo(at.ended).toISOString()
    return first(
      await exec(
        ORG,
        sql`insert into piloti_wakes (id, organization_id, document_id, annotation_id, trigger_kind, event_id, actor_user_id,
                                      status, reason, created_at, settled_at, ended_at)
            values (gen_random_uuid(), ${ORG}, ${documentId}::uuid, ${annotationId}::uuid, 'assigned', ${`e-${Math.random()}`},
                    ${ME}, ${status}, ${reason}, ${minutesAgo(at.created).toISOString()}::timestamptz,
                    ${settled}::timestamptz, ${ended}::timestamptz)
            returning id`
      )
    )
  }

  async function conversation(
    projectId: string,
    name: string,
    extra: { visibility: string; createdBy: string; deleted?: boolean }
  ): Promise<string> {
    const id = `conv_act_${name}_${STAMP}`
    await exec(
      ORG,
      sql`insert into conversations (id, organization_id, created_by, project_id, visibility, deleted_at)
          values (${id}, ${ORG}, ${extra.createdBy}, ${projectId}::uuid, ${extra.visibility},
                  ${extra.deleted ? new Date().toISOString() : null}::timestamptz)`
    )
    return id
  }

  const MEMORY = '{"scope":"project","kind":"decision","content":"Flachdach","confidence":"high"}'

  async function proposal(
    projectId: string,
    conversationId: string | null,
    at: number,
    decided?: { status: 'applied' | 'dismissed'; at: number }
  ): Promise<string> {
    return first(
      await exec(
        ORG,
        sql`insert into proposed_changes (organization_id, project_id, kind, payload, status, proposed_by_kind, on_behalf_of,
                                          origin_conversation_id, origin_message_id, created_at, decided_by, decided_at, results)
            values (${ORG}, ${projectId}::uuid, 'memory', ${MEMORY}::jsonb, ${decided?.status ?? 'proposed'}, 'piloti', ${ME},
                    ${conversationId}, ${conversationId ? '9a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d' : null}::uuid,
                    ${minutesAgo(at).toISOString()}::timestamptz, ${decided ? ANNA : null},
                    ${decided ? minutesAgo(decided.at).toISOString() : null}::timestamptz,
                    ${decided?.status === 'applied' ? '[]' : null}::jsonb)
            returning id`
      )
    )
  }

  async function change(conversationId: string, messageId: string, documentId: string, at: number, undone = false) {
    const [row] = await inOrg(ORG, () =>
      changes.insertPilotiChanges(ORG, [
        {
          organizationId: ORG,
          documentId,
          annotationId: '3f0f6c1a-2b3c-4d39-9d2c-0b7c8f5e1d1e',
          objectKind: 'annotation',
          objectId: '3f0f6c1a-2b3c-4d39-9d2c-0b7c8f5e1d1e',
          op: 'update',
          before: { status: 'open' },
          after: { status: 'resolved' },
          originConversationId: conversationId,
          originMessageId: messageId,
          onBehalfOf: ME,
        },
      ])
    )
    await exec(
      ORG,
      sql`update piloti_changes set created_at = ${minutesAgo(at).toISOString()}::timestamptz,
                 undone_at = ${undone ? new Date().toISOString() : null}::timestamptz, undone_by = ${undone ? ME : null}
          where id = ${row.id}::uuid`
    )
  }

  async function run(
    projectId: string,
    status: string,
    at: { created: number; finished?: number; updated?: number }
  ): Promise<string> {
    return first(
      await exec(
        ORG,
        sql`insert into task_runs (organization_id, project_id, kind, title, plan, requester_user_id, trigger, status,
                                   skill_snapshot, created_at, finished_at, updated_at)
            values (${ORG}, ${projectId}::uuid, 'deep-research', ${`Recherche ${status}`},
                    '{"prompt":"Recherchiere","skill":{},"dataSources":null}'::jsonb, ${ME}, 'manual', ${status}, '{}'::jsonb,
                    ${minutesAgo(at.created).toISOString()}::timestamptz,
                    ${at.finished === undefined ? null : minutesAgo(at.finished).toISOString()}::timestamptz,
                    ${minutesAgo(at.updated ?? at.finished ?? at.created).toISOString()}::timestamptz)
            returning id`
      )
    )
  }

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    const context = await import('@/lib/db/tenant-context')
    withTenant = context.withTenant
    withPlatformAccess = context.withPlatformAccess
    db = (await import('@/lib/db')).getDb()
    annotations = await import('@/lib/annotations/repository')
    wakes = await import('@/lib/annotations/wake-repository')
    proposals = await import('@/lib/proposals/repository')
    changes = await import('@/lib/changes/repository')
    tasks = await import('@/lib/tasks/repository')
    conversations = await import('@/lib/conversations/repository')
    documents = await import('@/lib/documents/repository')
    memberReader = (await import('@/lib/documents/visibility')).memberReader

    ids.project = await project(ORG, 'Wohnbau')
    ids.neighbour = await project(ORG, 'Nachbar')
    ids.foreignProject = await project(OTHER_ORG, 'Fremd')
    ids.closedFolder = first(
      await exec(
        ORG,
        sql`insert into project_folders (organization_id, project_id, name, path)
            values (${ORG}, ${ids.project}::uuid, 'Honorare', 'Honorare') returning id`
      )
    )
    ids.plan = await document(ORG, ids.project, 'Grundriss EG.pdf', { displayName: 'Grundriss Erdgeschoss' })
    ids.section = await document(ORG, ids.project, 'Schnitt AA.pdf')
    ids.held = await document(ORG, ids.project, 'Upload.pdf', { status: 'quarantined', createdBy: ANNA })
    ids.closed = await document(ORG, ids.project, 'Honorar.pdf', { folderId: ids.closedFolder })
    ids.elsewhere = await document(ORG, ids.neighbour, 'Nachbar.pdf')
    ids.ablage = await document(ORG, null, 'Ablage.pdf')
    ids.foreign = await document(OTHER_ORG, ids.foreignProject, 'Fremd.pdf')

    // A person's mark on each document Piloti wakes on, and Piloti's proposals.
    const gated = ['held', 'closed', 'elsewhere', 'ablage'] as const
    ;[ids.planMark] = await marks(ids.plan, ['Tür fehlt'])
    ;[ids.sectionMark] = await marks(ids.section, ['Höhe prüfen'])
    for (const name of gated) [ids[`${name}Mark`]] = await marks(ids[name], [`Mark ${name}`])
    const planProposals = await marks(ids.plan, ['P1', 'P2', 'P3', 'P4'], 'piloti')
    ;[ids.sectionProposal] = await marks(ids.section, ['S1'], 'piloti')
    for (const name of gated) await marks(ids[name], [`Vorschlag ${name}`], 'piloti')
    await exec(ORG, sql`update document_annotations set created_at = ${minutesAgo(30).toISOString()}::timestamptz
                        where id in (${sql.join(planProposals.map((id) => sql`${id}::uuid`), sql`, `)})`)
    await exec(ORG, sql`update document_annotations set created_at = ${minutesAgo(10).toISOString()}::timestamptz
                        where id = ${ids.sectionProposal}::uuid`)
    ids.firstPlanProposal = planProposals[0]

    // Wakes: live, ended, held at enqueue, too old, and on every gated document.
    ids.wakeQueued = await wake(ids.plan, ids.planMark, 'queued', { created: 2 })
    ids.wakeStarted = await wake(ids.section, ids.sectionMark, 'started', { created: 4 })
    ids.wakeAnswered = await wake(ids.plan, ids.planMark, 'answered', { created: 30, ended: 20 })
    ids.wakeRefused = await wake(ids.plan, ids.planMark, 'refused', { created: 16, ended: 15 }, 'budget: spent')
    await wake(ids.plan, ids.planMark, 'suppressed', { created: 3, ended: 3 }, 'cap:mark-hour')
    await wake(ids.plan, ids.planMark, 'answered', { created: 200, ended: 120 })
    for (const name of gated) {
      ids[`${name}Live`] = await wake(ids[name], ids[`${name}Mark`], 'queued', { created: 1 })
      ids[`${name}Ended`] = await wake(ids[name], ids[`${name}Mark`], 'answered', { created: 6, ended: 5 })
    }

    // Conversations of the project and of its neighbour.
    ids.open = await conversation(ids.project, 'open', { visibility: 'project', createdBy: ANNA })
    ids.annas = await conversation(ids.project, 'annas', { visibility: 'private', createdBy: ANNA })
    ids.mine = await conversation(ids.project, 'mine', { visibility: 'private', createdBy: ME })
    ids.shared = await conversation(ids.project, 'shared', { visibility: 'private', createdBy: ANNA })
    ids.gone = await conversation(ids.project, 'gone', { visibility: 'project', createdBy: ANNA, deleted: true })
    ids.next = await conversation(ids.neighbour, 'next', { visibility: 'project', createdBy: ME })
    await exec(
      ORG,
      sql`insert into resource_shares (organization_id, resource_type, resource_id, subject_user_id, role, granted_by)
          values (${ORG}, 'conversation', ${ids.shared}, ${ME}, 'viewer', ${ANNA})`
    )

    // Proposals: open in each conversation and in none, decided lately and long ago.
    ids.pNone = await proposal(ids.project, null, 10)
    ids.pOpen = await proposal(ids.project, ids.open, 9)
    ids.pAnnas = await proposal(ids.project, ids.annas, 8)
    ids.pMine = await proposal(ids.project, ids.mine, 7)
    ids.pShared = await proposal(ids.project, ids.shared, 6)
    ids.pGone = await proposal(ids.project, ids.gone, 5)
    ids.pNext = await proposal(ids.neighbour, ids.next, 4)
    ids.dApplied = await proposal(ids.project, ids.open, 50, { status: 'applied', at: 3 })
    ids.dDismissed = await proposal(ids.project, null, 50, { status: 'dismissed', at: 1 })
    ids.dAnnas = await proposal(ids.project, ids.annas, 50, { status: 'dismissed', at: 2 })
    ids.dOld = await proposal(ids.project, ids.open, 300, { status: 'applied', at: 120 })

    // Changes: one turn over three documents (one held), one in Anna's thread, one too old, one in a deleted thread.
    ids.turn = 'aaaaaaaa-1111-4000-8000-000000000001'
    ids.annasTurn = 'aaaaaaaa-1111-4000-8000-000000000002'
    ids.oldTurn = 'aaaaaaaa-1111-4000-8000-000000000003'
    ids.goneTurn = 'aaaaaaaa-1111-4000-8000-000000000004'
    await change(ids.open, ids.turn, ids.plan, 12, true)
    await change(ids.open, ids.turn, ids.plan, 11)
    await change(ids.open, ids.turn, ids.section, 13)
    await change(ids.open, ids.turn, ids.held, 14)
    await change(ids.annas, ids.annasTurn, ids.plan, 8)
    await change(ids.open, ids.oldTurn, ids.plan, 200)
    await change(ids.gone, ids.goneTurn, ids.plan, 7)

    // Runs: active, finished lately (one skip that never started), finished long ago, and the neighbour's.
    ids.runQueued = await run(ids.project, 'queued', { created: 3 })
    ids.runRunning = await run(ids.project, 'running', { created: 4 })
    ids.runDone = await run(ids.project, 'succeeded', { created: 20, finished: 5 })
    ids.runSkipped = await run(ids.project, 'skipped', { created: 9, updated: 6 })
    await run(ids.project, 'failed', { created: 300, finished: 120 })
    await run(ids.neighbour, 'queued', { created: 1 })
    await run(ids.neighbour, 'succeeded', { created: 3, finished: 2 })
  })

  afterAll(async () => {
    if (!db) return
    await withPlatformAccess('test teardown', async () => {
      for (const organizationId of [ORG, OTHER_ORG]) {
        await db.execute(sql`delete from resource_shares where organization_id = ${organizationId}`)
        await db.execute(sql`delete from task_runs where organization_id = ${organizationId}`)
        await db.execute(sql`delete from conversations where organization_id = ${organizationId}`)
        await db.execute(sql`delete from documents where organization_id = ${organizationId}`)
        await db.execute(sql`delete from project_folders where organization_id = ${organizationId}`)
        await db.execute(sql`delete from projects where organization_id = ${organizationId}`)
      }
    })
    const { closeDb } = await import('@/lib/db')
    await closeDb()
  })

  describe('wakes', () => {
    it('lists the live wakes of the documents the reader may see in the project, newest first', async () => {
      const rows = await wakes.listLiveProjectWakes(gate(), 10)
      expect(rows.map((row) => row.id)).toEqual([ids.wakeQueued, ids.wakeStarted])
      expect(rows[0]).toMatchObject({
        status: 'queued',
        triggerKind: 'assigned',
        actorUserId: ME,
        documentId: ids.plan,
        documentFilename: 'Grundriss EG.pdf',
        documentDisplayName: 'Grundriss Erdgeschoss',
        annotationId: ids.planMark,
        markNumber: 1,
        markKind: 'defect',
        markBody: 'Tür fehlt',
        markDelegatedAt: null,
        settledAt: null,
        endedAt: null,
      })
      expect(rows[0].createdAt).toBeInstanceOf(Date)
      expect(rows[1].settledAt).toBeInstanceOf(Date)
      expect(await wakes.listLiveProjectWakes(gate(), 1)).toHaveLength(1)
    })

    it('lists the ended wakes since `since`, newest first, without a suppressed or an older one', async () => {
      const rows = await wakes.listEndedProjectWakes(gate(), SINCE, 10)
      expect(rows.map((row) => [row.id, row.status, row.reason])).toEqual([
        [ids.wakeRefused, 'refused', 'budget: spent'],
        [ids.wakeAnswered, 'answered', null],
      ])
      expect(rows[0].endedAt).toBeInstanceOf(Date)
    })

    it("shows a held upload to its uploader, and a closed folder's document when no folder is hidden", async () => {
      const annas = await wakes.listLiveProjectWakes(gate({ reader: memberReader(ANNA) }), 10)
      expect(annas.map((row) => row.id)).toContain(ids.heldLive)
      expect(annas.map((row) => row.id)).not.toContain(ids.closedLive)
      const open = await wakes.listEndedProjectWakes(gate({ hiddenFolderIds: [] }), SINCE, 10)
      expect(open.map((row) => row.id)).toContain(ids.closedEnded)
      expect(open.map((row) => row.id)).not.toContain(ids.heldEnded)
      for (const id of [ids.elsewhereLive, ids.ablageLive]) {
        expect([...annas, ...(await wakes.listLiveProjectWakes(gate({ hiddenFolderIds: [] }), 10))].map((row) => row.id)).not.toContain(id)
      }
    })

    it("reads nothing of the project from another organization's scope", async () => {
      expect(await wakes.listLiveProjectWakes(gate({ organizationId: OTHER_ORG }), 10)).toEqual([])
    })
  })

  describe('proposed marks', () => {
    it('lists the documents with proposals, newest first, counting only the proposals', async () => {
      const rows = await annotations.listProposedMarkDocuments(gate(), 10)
      expect(rows.map((row) => [row.documentId, row.count, row.displayName])).toEqual([
        [ids.section, 1, null],
        [ids.plan, 4, 'Grundriss Erdgeschoss'],
      ])
      expect(rows[0].newestAt).toBeInstanceOf(Date)
      expect(await annotations.listProposedMarkDocuments(gate(), 1)).toHaveLength(1)
    })

    it('samples the first marks of each document by number, under the same gate', async () => {
      const rows = await annotations.listProposedMarkSamples(gate(), [ids.plan, ids.section, ids.held, ids.closed], 3)
      expect(rows.map((row) => [row.documentId, row.body, row.number])).toEqual(
        expect.arrayContaining([
          [ids.plan, 'P1', 2],
          [ids.plan, 'P2', 3],
          [ids.plan, 'P3', 4],
          [ids.section, 'S1', 2],
        ])
      )
      expect(rows).toHaveLength(4)
      expect(rows[0].createdAt).toBeInstanceOf(Date)
      expect(rows.find((row) => row.id === ids.firstPlanProposal)).toMatchObject({ page: 2, kind: 'defect', createdBy: ME })
    })
  })

  describe('proposals', () => {
    const reader = (userId = ME) => ({ organizationId: ORG, projectId: ids.project, userId })

    it("lists the open ones the reader may read: none's, the project's, theirs and shared; never another's private, a deleted or the neighbour's", async () => {
      const rows = await proposals.listOpenProposalsInProject(reader(), 10)
      expect(rows.map((row) => row.id)).toEqual([ids.pShared, ids.pMine, ids.pOpen, ids.pNone])
      expect(rows[0].createdAt).toBeInstanceOf(Date)
      const annas = await proposals.listOpenProposalsInProject(reader(ANNA), 10)
      expect(annas.map((row) => row.id)).toEqual([ids.pShared, ids.pAnnas, ids.pOpen, ids.pNone])
      expect(await proposals.listOpenProposalsInProject(reader(), 2)).toHaveLength(2)
    })

    it('lists the decided ones since `since`, newest decision first, under the same rule', async () => {
      const rows = await proposals.listDecidedProposalsInProject(reader(), SINCE, 10)
      expect(rows.map((row) => [row.id, row.status, row.decidedBy])).toEqual([
        [ids.dDismissed, 'dismissed', ANNA],
        [ids.dApplied, 'applied', ANNA],
      ])
      expect(rows[0].decidedAt).toBeInstanceOf(Date)
      const annas = await proposals.listDecidedProposalsInProject(reader(ANNA), SINCE, 10)
      expect(annas.map((row) => row.id)).toEqual([ids.dDismissed, ids.dAnnas, ids.dApplied])
    })
  })

  describe('changes', () => {
    it("counts a turn's changes on the reader's documents, in a thread they may open, since `since`", async () => {
      const rows = await changes.listRecentTurnChanges(gate(), ME, SINCE, 10, 3)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        conversationId: ids.open,
        messageId: ids.turn,
        count: 3,
        undoneCount: 1,
        onBehalfOf: ME,
        documentCount: 2,
      })
      expect([...rows[0].documentIds].sort()).toEqual([ids.plan, ids.section].sort())
      expect(rows[0].newestAt.toISOString()).toBe(minutesAgo(11).toISOString())
    })

    it("counts the held upload for its uploader, and the owner's private thread for its owner", async () => {
      const rows = await changes.listRecentTurnChanges(gate({ reader: memberReader(ANNA) }), ANNA, SINCE, 10, 2)
      expect(rows.map((row) => [row.messageId, row.count, row.documentCount, row.documentIds.length])).toEqual([
        [ids.annasTurn, 1, 1, 1],
        [ids.turn, 4, 3, 2],
      ])
    })
  })

  describe('runs', () => {
    it("lists the project's active runs newest first", async () => {
      const rows = await inOrg(ORG, () => tasks.listActiveRunsInProject(ids.project, ORG, 10))
      expect(rows.map((row) => row.id)).toEqual([ids.runQueued, ids.runRunning])
      expect(await inOrg(ORG, () => tasks.listActiveRunsInProject(ids.project, ORG, 1))).toHaveLength(1)
    })

    it("lists the project's runs finished since `since`, a skip by when it was written", async () => {
      const rows = await inOrg(ORG, () => tasks.listFinishedRunsInProject(ids.project, ORG, SINCE, 10))
      expect(rows.map((row) => [row.id, row.status])).toEqual([
        [ids.runDone, 'succeeded'],
        [ids.runSkipped, 'skipped'],
      ])
    })
  })

  describe('links and names', () => {
    it('lets a link through only to a thread the reader may open in the project', async () => {
      const visible = await inOrg(ORG, () =>
        conversations.listVisibleConversationIds(ORG, ME, ids.project, [
          ids.open,
          ids.annas,
          ids.mine,
          ids.shared,
          ids.gone,
          ids.next,
          'conv_nobody',
        ])
      )
      expect([...visible].sort()).toEqual([ids.open, ids.mine, ids.shared].sort())
      expect(await inOrg(ORG, () => conversations.listVisibleConversationIds(ORG, ME, ids.project, []))).toEqual(new Set())
    })

    it('agrees with the conversation list, which is built from the same predicate', async () => {
      const listed = await inOrg(ORG, () => conversations.listVisibleConversations(ORG, ME, { projectId: ids.project }))
      expect(listed.map((row) => row.id)).toEqual(expect.arrayContaining([ids.open, ids.mine, ids.shared]))
      expect(listed.map((row) => row.id)).not.toContain(ids.annas)
      expect(listed.map((row) => row.id)).not.toContain(ids.next)
    })

    it('names only the documents the gate lets through', async () => {
      const rows = await documents.listVisibleProjectDocumentNames(gate(), [
        ids.plan,
        ids.held,
        ids.closed,
        ids.elsewhere,
        ids.ablage,
        ids.foreign,
      ])
      expect(rows).toEqual([{ id: ids.plan, filename: 'Grundriss EG.pdf', displayName: 'Grundriss Erdgeschoss' }])
    })
  })
})
