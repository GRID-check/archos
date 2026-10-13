/**
 * @vitest-environment node
 *
 * The change record (migration 0139, ADR-0109) against a REAL Postgres
 * through the restricted runtime role:
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/changes/repository.integration.spec.ts
 *
 * What it proves, each a claim about SQL a mocked handle cannot disagree with:
 *   - a create, an update, a delete and a reply each record and read back
 *     with their states, their turn and no undo;
 *   - the database refuses a create with a before, an update without one, a
 *     delete with an after, a reply that is not a create, a mark's change
 *     naming another object, a state that is not an object, and an undo
 *     without its person or its time;
 *   - a turn's read is its own: oldest first, never another answer's or
 *     another conversation's;
 *   - undo is a compare-and-swap: of two claims at once exactly one wins, a
 *     claim given back by its own stamp can be claimed again, and a stale
 *     release clears nobody's undo;
 *   - another organization reads none of them, and cannot plant one on this
 *     organization's document or conversation;
 *   - a record goes with its document, and with its conversation.
 *
 * `task db:test:rls` (scripts/rls-test-db.sh) runs it with the other suites.
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { NewPilotiChange } from './repository'

vi.mock('server-only', () => ({}))

const url = process.env.GRID_TEST_DATABASE_URL
const STAMP = Date.now()
const ORG = `org_changes_${STAMP}`
const OTHER_ORG = `${ORG}_other`
const USER = `user_changes_${STAMP}`
const OTHER_USER = `${USER}_2`
const ANSWER = '9a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d'
const OTHER_ANSWER = '9a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2e'
const MARK = '3f0f6c1a-2b3c-4d39-9d2c-0b7c8f5e1d1e'
const REPLY = '3f0f6c1a-2b3c-4d39-9d2c-0b7c8f5e1d1f'

describe('the change-record suite is not silently skipped in CI', () => {
  it('has a database to run against', () => {
    if (!process.env.GRID_RLS_SUITE_REQUIRED) return
    expect(url, 'GRID_TEST_DATABASE_URL is unset while GRID_RLS_SUITE_REQUIRED is set').toBeTruthy()
  })
})

describe.skipIf(!url)('the change record against live Postgres', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let withPlatformAccess: typeof import('@/lib/db/tenant-context').withPlatformAccess
  let repo: typeof import('./repository')
  const ids = {
    project: '',
    otherProject: '',
    document: '',
    otherDocument: '',
    conversation: `conv_changes_${STAMP}`,
    otherConversation: `conv_changes_${STAMP}_other`,
  }

  const inOrg = <T>(organizationId: string, run: () => PromiseLike<T>) =>
    withTenant({ organizationId, userId: USER }, run)
  const first = (rows: Iterable<{ id: unknown }>) => String(Array.from(rows)[0]?.id)

  async function project(organizationId: string, name: string): Promise<string> {
    return first(
      await inOrg(organizationId, () =>
        db.execute<{ id: string }>(sql`
          insert into projects (organization_id, name, created_by, collection_name)
          values (${organizationId}, ${name}, ${USER}, ${`proj_chg_${name}_${STAMP}`}) returning id`)
      )
    )
  }

  async function document(organizationId: string, projectId: string, filename: string): Promise<string> {
    return first(
      await inOrg(organizationId, () =>
        db.execute<{ id: string }>(sql`
          insert into documents (organization_id, project_id, scope, filename, storage_key, collection_name, created_by,
                                 status, screening_outcome)
          values (${organizationId}, ${projectId}::uuid, 'project', ${filename}, ${`k/${STAMP}/${organizationId}/${filename}`},
                  ${`proj_chg_${projectId}`}, ${USER}, 'completed', 'clean') returning id`)
      )
    )
  }

  async function conversation(organizationId: string, id: string, projectId: string): Promise<string> {
    await inOrg(organizationId, () =>
      db.execute(sql`
        insert into conversations (id, organization_id, created_by, project_id)
        values (${id}, ${organizationId}, ${USER}, ${projectId}::uuid)`)
    )
    return id
  }

  const change = (extra: Partial<NewPilotiChange> = {}): NewPilotiChange => ({
    organizationId: ORG,
    documentId: ids.document,
    annotationId: MARK,
    objectKind: 'annotation',
    objectId: MARK,
    op: 'update',
    before: { status: 'open' },
    after: { status: 'resolved' },
    originConversationId: ids.conversation,
    originMessageId: ANSWER,
    onBehalfOf: USER,
    ...extra,
  })

  const record = async (extra: Partial<NewPilotiChange> = {}) => {
    const organizationId = extra.organizationId ?? ORG
    const [row] = await inOrg(organizationId, () => repo.insertPilotiChanges(organizationId, [change(extra)]))
    return row
  }

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    const context = await import('@/lib/db/tenant-context')
    withTenant = context.withTenant
    withPlatformAccess = context.withPlatformAccess
    db = (await import('@/lib/db')).getDb()
    repo = await import('./repository')
    ids.project = await project(ORG, 'Wohnbau')
    ids.otherProject = await project(OTHER_ORG, 'Fremd')
    ids.document = await document(ORG, ids.project, 'Grundriss EG.pdf')
    ids.otherDocument = await document(OTHER_ORG, ids.otherProject, 'Fremd.pdf')
    await conversation(ORG, ids.conversation, ids.project)
    await conversation(OTHER_ORG, ids.otherConversation, ids.otherProject)
  })

  afterAll(async () => {
    if (!db) return
    await withPlatformAccess('test teardown', async () => {
      for (const organizationId of [ORG, OTHER_ORG]) {
        await db.execute(sql`delete from conversations where organization_id = ${organizationId}`)
        await db.execute(sql`delete from documents where organization_id = ${organizationId}`)
        await db.execute(sql`delete from projects where organization_id = ${organizationId}`)
      }
    })
    const { closeDb } = await import('@/lib/db')
    await closeDb()
  })

  it('records each op with its states and its turn, undone by nobody, and reads it back by id', async () => {
    const state = { status: 'open', kind: 'defect', body: 'Tür', page: 1, shape: 'point', x: 0.25, y: 0.75, w: null, h: null }
    const rows = await inOrg(ORG, () =>
      repo.insertPilotiChanges(ORG, [
        change({ op: 'create', before: null, after: state }),
        change(),
        change({ op: 'delete', before: state, after: null }),
        change({ objectKind: 'annotation_reply', objectId: REPLY, op: 'create', before: null, after: { body: 'Ja.' } }),
      ])
    )
    expect(rows.map((row) => [row.objectKind, row.op])).toEqual([
      ['annotation', 'create'],
      ['annotation', 'update'],
      ['annotation', 'delete'],
      ['annotation_reply', 'create'],
    ])
    expect(rows[0]).toMatchObject({
      before: null,
      after: state,
      originConversationId: ids.conversation,
      originMessageId: ANSWER,
      onBehalfOf: USER,
      undoneAt: null,
      undoneBy: null,
    })
    expect(rows[0].createdAt).toBeInstanceOf(Date)
    expect(await inOrg(ORG, () => repo.findPilotiChange(ORG, rows[2].id))).toMatchObject({ op: 'delete', after: null, before: state })
  })

  it('refuses a state that does not fit its op, a reply that is not created, and an undo by nobody or at no time', async () => {
    const refused = (extra: Partial<NewPilotiChange>) => expect(record(extra)).rejects.toThrow()
    await refused({ op: 'create', before: { status: 'open' }, after: { status: 'open' } })
    await refused({ op: 'update', before: null })
    await refused({ op: 'delete', before: { status: 'open' }, after: { status: 'open' } })
    await refused({ objectKind: 'annotation_reply', objectId: REPLY, op: 'update' })
    await refused({ objectId: REPLY })
    await refused({ op: 'move' as never })
    await refused({ objectKind: 'document' as never })

    const row = await record()
    const update = (set: ReturnType<typeof sql>) =>
      inOrg(ORG, () => db.execute(sql`update piloti_changes set ${set} where id = ${row.id}::uuid`))
    await expect(update(sql`after = '[]'::jsonb`)).rejects.toThrow()
    await expect(update(sql`undone_at = now()`)).rejects.toThrow()
    await expect(update(sql`undone_by = ${USER}`)).rejects.toThrow()
  })

  it("reads a turn's changes oldest first, and never another answer's or another conversation's", async () => {
    const conversationId = await conversation(ORG, `${ids.conversation}_turns`, ids.project)
    const older = await record({ originConversationId: conversationId, after: { status: 'resolved', body: 'eins' } })
    const newer = await record({ originConversationId: conversationId, after: { status: 'resolved', body: 'zwei' } })
    await record({ originConversationId: conversationId, originMessageId: OTHER_ANSWER })
    await record({ originMessageId: ANSWER })

    const read = await inOrg(ORG, () => repo.listTurnChangeRows(ORG, conversationId, ANSWER))
    expect(read.map((row) => row.id)).toEqual([older.id, newer.id])
  })

  it('lets exactly one of two undo claims at once win, and gives a claim back only by its own stamp', async () => {
    const row = await record()
    const claims = await Promise.all([
      inOrg(ORG, () => repo.claimUndo(ORG, row.id, USER)),
      inOrg(ORG, () => repo.claimUndo(ORG, row.id, OTHER_USER)),
    ])
    expect(claims.filter(Boolean)).toHaveLength(1)
    const claim = claims.find(Boolean)!
    expect(claim.undoneAt).toBeInstanceOf(Date)
    expect(await inOrg(ORG, () => repo.claimUndo(ORG, row.id, USER))).toBeNull()

    // A release naming another stamp clears nothing.
    await inOrg(ORG, () => repo.releaseUndo(ORG, { ...claim, undoneAt: new Date(claim.undoneAt!.getTime() - 1000) }))
    expect(await inOrg(ORG, () => repo.findPilotiChange(ORG, row.id))).toMatchObject({ undoneBy: claim.undoneBy })

    await inOrg(ORG, () => repo.releaseUndo(ORG, claim))
    expect(await inOrg(ORG, () => repo.findPilotiChange(ORG, row.id))).toMatchObject({ undoneAt: null, undoneBy: null })
    expect(await inOrg(ORG, () => repo.claimUndo(ORG, row.id, OTHER_USER))).toMatchObject({ undoneBy: OTHER_USER })
  })

  it('is invisible to another organization, which cannot plant one on this document or conversation', async () => {
    const row = await record()
    expect(await inOrg(OTHER_ORG, () => repo.findPilotiChange(OTHER_ORG, row.id))).toBeNull()
    expect(await inOrg(OTHER_ORG, () => repo.claimUndo(OTHER_ORG, row.id, USER))).toBeNull()
    expect(await inOrg(OTHER_ORG, () => repo.listTurnChangeRows(OTHER_ORG, ids.conversation, ANSWER))).toEqual([])
    // Row-level security, not only the WHERE: the other tenant's scope sees no row at all.
    const seen = await inOrg(OTHER_ORG, () => db.execute(sql`select id from piloti_changes where id = ${row.id}::uuid`))
    expect(Array.from(seen)).toHaveLength(0)

    await expect(
      record({ organizationId: OTHER_ORG, documentId: ids.document, originConversationId: ids.otherConversation })
    ).rejects.toThrow()
    await expect(
      record({ organizationId: OTHER_ORG, documentId: ids.otherDocument, originConversationId: ids.conversation })
    ).rejects.toThrow()
    const own = await record({ organizationId: OTHER_ORG, documentId: ids.otherDocument, originConversationId: ids.otherConversation })
    expect(own.organizationId).toBe(OTHER_ORG)
  })

  it('goes with its conversation, and with its document, and outlives its mark', async () => {
    const conversationId = await conversation(ORG, `${ids.conversation}_gone`, ids.project)
    const withThread = await record({ originConversationId: conversationId })
    await inOrg(ORG, () => db.execute(sql`delete from conversations where id = ${conversationId}`))
    expect(await inOrg(ORG, () => repo.findPilotiChange(ORG, withThread.id))).toBeNull()

    const doomed = await document(ORG, ids.project, 'Abbruch.pdf')
    const onDoomed = await record({ documentId: doomed })
    await inOrg(ORG, () => db.execute(sql`delete from documents where id = ${doomed}::uuid`))
    expect(await inOrg(ORG, () => repo.findPilotiChange(ORG, onDoomed.id))).toBeNull()

    // No mark with MARK's id was ever stored: the record never needed one.
    const markless = await record()
    expect(await inOrg(ORG, () => repo.findPilotiChange(ORG, markless.id))).not.toBeNull()
  })
})
