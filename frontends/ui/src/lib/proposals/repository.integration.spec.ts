/**
 * @vitest-environment node
 *
 * Proposed changes (migrations 0140, 0143) against a REAL Postgres through the
 * restricted runtime role:
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/proposals/repository.integration.spec.ts
 *
 * What it proves, each a claim about SQL a mocked handle cannot disagree with:
 *   - a proposal is born `proposed`, undecided, with no results and no claim;
 *   - the database refuses a decision without a person and a time, results on
 *     a proposal nobody applied, an applied one without results, a claim on a
 *     decided one, and a kind or status it does not know;
 *   - applying is compare-and-swap: of two claims at once exactly one wins, a
 *     live claim blocks a second claim and a dismissal, a stale one does not,
 *     and the settle clears the claim and records who decided;
 *   - a settle whose claim was taken over finds nothing;
 *   - another organization reads none of them, and cannot plant one on this
 *     organization's project or conversation;
 *   - a proposal goes with its project, and with its conversation;
 *   - the same card of the same answer is one proposal: a second insert
 *     returns the first, unchanged, while another card, another answer or
 *     another organization is its own; a card index needs its answer and is
 *     never negative; the two newer kinds are stored, an unknown one is not;
 *   - a Büroablage proposal (0146) has no project and moves only Büroablage
 *     documents; its organization lists it on its shelf, another organization
 *     sees none of it, and Piloti's withdrawal deletes an open one and never a
 *     decided one;
 *   - an organization-scoped proposal (0174) has no project, is an `operation`
 *     and nothing else, and is listed on its own shelf; one open operation
 *     call is one proposal per conversation, however it is spelled and however
 *     many run at once, and a decided one frees the call.
 *
 * `task db:test:rls` (scripts/rls-test-db.sh) runs it with the other suites.
 */

import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FileOperationPayload } from './types'

vi.mock('server-only', () => ({}))

const url = process.env.GRID_TEST_DATABASE_URL
const STAMP = Date.now()
const ORG = `org_proposals_${STAMP}`
const OTHER_ORG = `${ORG}_other`
const USER = `user_proposals_${STAMP}`
const OTHER_USER = `${USER}_2`

const PAYLOAD: FileOperationPayload = {
  operation: 'move',
  operations: [{ document: 'Grundriss EG.pdf', source: 'project', target_folder: 'Einreichung' }],
}

describe('the proposed-changes suite is not silently skipped in CI', () => {
  it('has a database to run against', () => {
    if (!process.env.GRID_RLS_SUITE_REQUIRED) return
    expect(url, 'GRID_TEST_DATABASE_URL is unset while GRID_RLS_SUITE_REQUIRED is set').toBeTruthy()
  })
})

describe.skipIf(!url)('proposed changes against live Postgres', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let withPlatformAccess: typeof import('@/lib/db/tenant-context').withPlatformAccess
  let repo: typeof import('./repository')
  const ids = { project: '', otherProject: '', conversation: `conv_proposals_${STAMP}`, otherConversation: '' }

  const inOrg = <T>(organizationId: string, run: () => PromiseLike<T>) =>
    withTenant({ organizationId, userId: USER }, run)
  const first = (rows: Iterable<{ id: unknown }>) => String(Array.from(rows)[0]?.id)

  async function project(organizationId: string, name: string): Promise<string> {
    return first(
      await inOrg(organizationId, () =>
        db.execute<{ id: string }>(sql`
          insert into projects (organization_id, name, created_by, collection_name)
          values (${organizationId}, ${name}, ${USER}, ${`proj_prop_${name}_${STAMP}`}) returning id`)
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

  const insert = (extra: Partial<import('./repository').NewProposedChange> = {}) =>
    inOrg(extra.organizationId ?? ORG, () =>
      repo.insertProposedChange({
        organizationId: ORG,
        projectId: ids.project,
        scope: 'project',
        kind: 'file_operation',
        payload: PAYLOAD,
        proposedByKind: 'piloti',
        onBehalfOf: USER,
        originConversationId: ids.conversation,
        originMessageId: null,
        ...extra,
      })
    )
  const propose = async (extra: Partial<import('./repository').NewProposedChange> = {}) => (await insert(extra)).row

  /** The service's stale line: a claim older than five minutes no longer counts. */
  const stale = () => new Date(Date.now() - 5 * 60 * 1000)

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    const context = await import('@/lib/db/tenant-context')
    withTenant = context.withTenant
    withPlatformAccess = context.withPlatformAccess
    db = (await import('@/lib/db')).getDb()
    repo = await import('./repository')
    ids.project = await project(ORG, 'Wohnbau')
    ids.otherProject = await project(OTHER_ORG, 'Fremd')
    await conversation(ORG, ids.conversation, ids.project)
    ids.otherConversation = await conversation(OTHER_ORG, `${ids.conversation}_other`, ids.otherProject)
  })

  afterAll(async () => {
    if (!db) return
    await withPlatformAccess('test teardown', async () => {
      for (const organizationId of [ORG, OTHER_ORG]) {
        await db.execute(sql`delete from proposed_changes where organization_id = ${organizationId}`)
        await db.execute(sql`delete from conversations where organization_id = ${organizationId}`)
        await db.execute(sql`delete from projects where organization_id = ${organizationId}`)
      }
    })
    const { closeDb } = await import('@/lib/db')
    await closeDb()
  })

  it('is born proposed, undecided, with no results and no claim, and reads back by id', async () => {
    const row = await propose({ originMessageId: '9a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d' })
    expect(row).toMatchObject({
      status: 'proposed',
      decidedBy: null,
      decidedAt: null,
      results: null,
      applyingBy: null,
      applyingSince: null,
      payload: PAYLOAD,
    })
    expect(row.createdAt).toBeInstanceOf(Date)
    expect(await inOrg(ORG, () => repo.findProposedChange(ORG, row.id))).toMatchObject({ id: row.id })
  })

  it('refuses a decision without its person and time, and results nobody applied for', async () => {
    const row = await propose()
    const update = (set: ReturnType<typeof sql>) =>
      inOrg(ORG, () => db.execute(sql`update proposed_changes set ${set} where id = ${row.id}::uuid`))

    await expect(update(sql`status = 'dismissed'`)).rejects.toThrow()
    await expect(update(sql`status = 'dismissed', decided_by = ${USER}`)).rejects.toThrow()
    await expect(update(sql`decided_by = ${USER}, decided_at = now()`)).rejects.toThrow()
    await expect(update(sql`results = '[]'::jsonb`)).rejects.toThrow()
    await expect(update(sql`status = 'applied', decided_by = ${USER}, decided_at = now()`)).rejects.toThrow()
    await expect(
      update(sql`status = 'dismissed', decided_by = ${USER}, decided_at = now(), results = '[]'::jsonb`)
    ).rejects.toThrow()
    await expect(
      update(sql`status = 'applied', decided_by = ${USER}, decided_at = now(), results = '{}'::jsonb`)
    ).rejects.toThrow()
    await expect(update(sql`applying_by = ${USER}`)).rejects.toThrow()
    await expect(update(sql`status = 'withdrawn'`)).rejects.toThrow()
    await expect(update(sql`kind = 'delete_everything'`)).rejects.toThrow()
    await expect(update(sql`payload = '[]'::jsonb`)).rejects.toThrow()
  })

  it('lets exactly one of two claims at once win, and a live claim blocks a second claim and a dismissal', async () => {
    const row = await propose()
    const claims = await Promise.all([
      inOrg(ORG, () => repo.claimProposedChange(ORG, row.id, USER, stale())),
      inOrg(ORG, () => repo.claimProposedChange(ORG, row.id, OTHER_USER, stale())),
    ])
    expect(claims.filter(Boolean)).toHaveLength(1)
    expect(await inOrg(ORG, () => repo.claimProposedChange(ORG, row.id, USER, stale()))).toBeNull()
    expect(await inOrg(ORG, () => repo.dismissProposedChange(ORG, row.id, USER, stale()))).toBeNull()

    const claim = claims.find(Boolean)!
    const settled = await inOrg(ORG, () =>
      repo.settleProposedChange(ORG, claim, {
        status: 'partially_applied',
        results: [
          { label: 'a.pdf', ok: true },
          { label: 'b.pdf', ok: false, reason: 'weg' },
        ],
      })
    )
    expect(settled).toMatchObject({
      status: 'partially_applied',
      decidedBy: claim.applyingBy,
      applyingBy: null,
      applyingSince: null,
      results: [
        { label: 'a.pdf', ok: true },
        { label: 'b.pdf', ok: false, reason: 'weg' },
      ],
    })
    expect(settled?.decidedAt).toBeInstanceOf(Date)

    // Decided: nothing moves it again.
    expect(await inOrg(ORG, () => repo.claimProposedChange(ORG, row.id, USER, stale()))).toBeNull()
    expect(await inOrg(ORG, () => repo.dismissProposedChange(ORG, row.id, USER, stale()))).toBeNull()
    expect(
      await inOrg(ORG, () => repo.settleProposedChange(ORG, claim, { status: 'applied', results: [] }))
    ).toBeNull()
  })

  it('takes over a stale claim, and the settle of the old one then finds nothing', async () => {
    const row = await propose()
    const old = await inOrg(ORG, () => repo.claimProposedChange(ORG, row.id, OTHER_USER, stale()))
    expect(old).not.toBeNull()
    // Everything claimed before "now + 1s" counts as stale for this caller.
    const fresh = await inOrg(ORG, () => repo.claimProposedChange(ORG, row.id, USER, new Date(Date.now() + 1000)))
    expect(fresh).toMatchObject({ applyingBy: USER })

    expect(await inOrg(ORG, () => repo.settleProposedChange(ORG, old!, { status: 'applied', results: [] }))).toBeNull()
    expect(
      await inOrg(ORG, () => repo.settleProposedChange(ORG, fresh!, { status: 'failed', results: [{ label: 'x', ok: false }] }))
    ).toMatchObject({ status: 'failed', decidedBy: USER })
  })

  it('gives a claim back without deciding, and then dismisses', async () => {
    const row = await propose()
    const claim = await inOrg(ORG, () => repo.claimProposedChange(ORG, row.id, USER, stale()))
    await inOrg(ORG, () => repo.releaseProposedChange(ORG, claim!))
    expect(await inOrg(ORG, () => repo.findProposedChange(ORG, row.id))).toMatchObject({
      status: 'proposed',
      applyingBy: null,
    })

    const dismissed = await inOrg(ORG, () => repo.dismissProposedChange(ORG, row.id, OTHER_USER, stale()))
    expect(dismissed).toMatchObject({ status: 'dismissed', decidedBy: OTHER_USER, results: null })
    expect(await inOrg(ORG, () => repo.dismissProposedChange(ORG, row.id, USER, stale()))).toBeNull()
  })

  it('is invisible to another organization, which cannot plant one on this project or conversation', async () => {
    const row = await propose()
    expect(await inOrg(OTHER_ORG, () => repo.findProposedChange(OTHER_ORG, row.id))).toBeNull()
    expect(await inOrg(OTHER_ORG, () => repo.claimProposedChange(OTHER_ORG, row.id, USER, stale()))).toBeNull()
    expect(await inOrg(OTHER_ORG, () => repo.dismissProposedChange(OTHER_ORG, row.id, USER, stale()))).toBeNull()
    // Row-level security, not only the WHERE: the other tenant's scope sees no row at all.
    const seen = await inOrg(OTHER_ORG, () => db.execute(sql`select id from proposed_changes where id = ${row.id}::uuid`))
    expect(Array.from(seen)).toHaveLength(0)

    // Another tenant's row naming this project, or this conversation, is refused.
    await expect(
      propose({ organizationId: OTHER_ORG, projectId: ids.project, originConversationId: null })
    ).rejects.toThrow()
    await expect(
      propose({ organizationId: OTHER_ORG, projectId: ids.otherProject, originConversationId: ids.conversation })
    ).rejects.toThrow()
    // Its own project and conversation are fine.
    const own = await propose({
      organizationId: OTHER_ORG,
      projectId: ids.otherProject,
      originConversationId: ids.otherConversation,
    })
    expect(own.organizationId).toBe(OTHER_ORG)
  })

  it('goes with its conversation, and with its project', async () => {
    const conversationId = await conversation(ORG, `${ids.conversation}_gone`, ids.project)
    const withThread = await propose({ originConversationId: conversationId })
    await inOrg(ORG, () => db.execute(sql`delete from conversations where id = ${conversationId}`))
    expect(await inOrg(ORG, () => repo.findProposedChange(ORG, withThread.id))).toBeNull()

    const doomed = await project(ORG, 'Abbruch')
    const inDoomed = await propose({ projectId: doomed, originConversationId: null })
    await inOrg(ORG, () => db.execute(sql`delete from projects where id = ${doomed}::uuid`))
    expect(await inOrg(ORG, () => repo.findProposedChange(ORG, inDoomed.id))).toBeNull()
  })

  describe('one card, one proposal (0143)', () => {
    const ANSWER = '7d6e5f4a-3b2c-4d1e-8f0a-1b2c3d4e5f60'
    const MEMORY = { scope: 'project', kind: 'decision', content: 'Flachdach, extensiv begrünt', confidence: 'high' }
    const PROFILE = { title: 'Geschoße', patch: [{ op: 'replace', path: '/facts/geschosse', value: 4 }] }

    it('returns the first proposal for the same card, unchanged, and tells the caller it made nothing', async () => {
      const first = await insert({ originMessageId: ANSWER, originCardIndex: 0 })
      expect(first.created).toBe(true)
      expect(first.row.originCardIndex).toBe(0)
      const dismissed = await inOrg(ORG, () => repo.dismissProposedChange(ORG, first.row.id, USER, stale()))
      expect(dismissed?.status).toBe('dismissed')

      const again = await insert({ originMessageId: ANSWER, originCardIndex: 0, kind: 'memory', payload: MEMORY })
      expect(again.created).toBe(false)
      expect(again.row).toMatchObject({ id: first.row.id, kind: 'file_operation', status: 'dismissed', payload: PAYLOAD })
    })

    it('keeps another card, another answer and a proposal without a card apart', async () => {
      const a = await insert({ originMessageId: ANSWER, originCardIndex: 1 })
      const b = await insert({ originMessageId: ANSWER, originCardIndex: 2 })
      const c = await insert({ originMessageId: '7d6e5f4a-3b2c-4d1e-8f0a-1b2c3d4e5f61', originCardIndex: 1 })
      const d = await insert({ originMessageId: ANSWER })
      const e = await insert({ originMessageId: ANSWER })
      expect(new Set([a, b, c, d, e].map((made) => made.row.id)).size).toBe(5)
      expect([a, b, c, d, e].every((made) => made.created)).toBe(true)
    })

    it('lets another organization use the same answer and card', async () => {
      const ours = await insert({ originMessageId: ANSWER, originCardIndex: 3 })
      const theirs = await insert({
        organizationId: OTHER_ORG,
        projectId: ids.otherProject,
        originConversationId: ids.otherConversation,
        originMessageId: ANSWER,
        originCardIndex: 3,
      })
      expect(theirs.created).toBe(true)
      expect(theirs.row.id).not.toBe(ours.row.id)
    })

    it('refuses a negative card index and one without its answer, in SQL', async () => {
      const row = await propose({ originMessageId: ANSWER, originCardIndex: 4 })
      const update = (set: ReturnType<typeof sql>) =>
        inOrg(ORG, () => db.execute(sql`update proposed_changes set ${set} where id = ${row.id}::uuid`))
      await expect(update(sql`origin_card_index = -1`)).rejects.toThrow()
      await expect(update(sql`origin_message_id = null`)).rejects.toThrow()
      const other = await propose({ originMessageId: ANSWER, originCardIndex: 5 })
      await expect(
        inOrg(ORG, () => db.execute(sql`update proposed_changes set origin_card_index = 4 where id = ${other.id}::uuid`))
      ).rejects.toThrow()
    })

    it('stores a memory note and a profile change, and still refuses an unknown kind', async () => {
      expect(await propose({ kind: 'memory', payload: MEMORY })).toMatchObject({ kind: 'memory', payload: MEMORY })
      expect(await propose({ kind: 'project_profile', payload: PROFILE })).toMatchObject({
        kind: 'project_profile',
        payload: PROFILE,
      })
      await expect(propose({ kind: 'steckbrief' as never })).rejects.toThrow()
    })
  })

  describe('the Büroablage (0146)', () => {
    const OFFICE_SHELF_MOVE: FileOperationPayload = {
      operation: 'move',
      operations: [{ document: 'ÖNORM B 1800.pdf', source: 'office', target_folder: 'Normen', reason: 'Eine Norm.' }],
      basis: 'name',
    }
    const shelved = (organizationId: string, payload: FileOperationPayload = OFFICE_SHELF_MOVE) =>
      inOrg(organizationId, () =>
        repo.insertProposedChange({
          organizationId,
          projectId: null,
          scope: 'office_shelf',
          kind: 'file_operation',
          payload,
          proposedByKind: 'piloti',
          onBehalfOf: USER,
          originConversationId: null,
          originMessageId: null,
          originTraceId: 'abcdef0123456789abcdef0123456789',
        })
      )

    it('stores a move of Büroablage documents without a project, and lists it on its shelf only', async () => {
      const { row } = await shelved(ORG)
      expect(row).toMatchObject({ projectId: null, scope: 'office_shelf', originTraceId: 'abcdef0123456789abcdef0123456789' })
      const officeShelf = await repo.listShelfProposals(ORG, { scope: 'office_shelf' }, { statuses: ['proposed'], limit: 50 })
      expect(officeShelf.map((entry) => entry.id)).toContain(row.id)
      const project = await repo.listShelfProposals(
        ORG,
        { scope: 'project', projectId: ids.project },
        { statuses: ['proposed'], limit: 50 }
      )
      expect(project.map((entry) => entry.id)).not.toContain(row.id)
    })

    it('refuses a Büroablage proposal that would reach into a project', async () => {
      await expect(
        shelved(ORG, { operation: 'move', operations: [{ document: 'a.pdf', source: 'project', target_folder: 'X' }] })
      ).rejects.toThrow()
      await expect(
        shelved(ORG, { operation: 'create_folder', operations: [{ folder_name: 'X' }] })
      ).rejects.toThrow()
    })

    it('shows another organization none of it', async () => {
      const { row } = await shelved(ORG)
      expect(await repo.findProposedChange(OTHER_ORG, row.id)).toBeNull()
      const seen = await inOrg(OTHER_ORG, () =>
        db.execute<{ id: string }>(sql`select id from proposed_changes where id = ${row.id}::uuid`)
      )
      expect(Array.from(seen)).toHaveLength(0)
      const theirs = await repo.listShelfProposals(OTHER_ORG, { scope: 'office_shelf' }, { statuses: ['proposed'], limit: 50 })
      expect(theirs.map((entry) => entry.id)).not.toContain(row.id)
    })

    it('withdraws an open proposal and never a decided one', async () => {
      const open = (await shelved(ORG)).row
      expect(await repo.deleteUndecidedProposedChange(ORG, open.id, stale())).toBe(true)
      expect(await repo.findProposedChange(ORG, open.id)).toBeNull()
      const decided = (await shelved(ORG)).row
      await repo.dismissProposedChange(ORG, decided.id, USER, stale())
      expect(await repo.deleteUndecidedProposedChange(ORG, decided.id, stale())).toBe(false)
      expect(await repo.findProposedChange(ORG, decided.id)).toMatchObject({ status: 'dismissed' })
    })
  })

  describe('the organization and one open call (0174)', () => {
    const call = (input: unknown, operation = 'organization-memory-create') => ({
      operation,
      input,
      summary: 'Add a note to the office’s memory',
    })
    const operationProposal = (
      payload: ReturnType<typeof call>,
      extra: Partial<import('./repository').NewProposedChange> = {}
    ) =>
      inOrg(extra.organizationId ?? ORG, () =>
        repo.insertProposedChange({
          organizationId: ORG,
          projectId: null,
          scope: 'organization',
          kind: 'operation',
          payload,
          proposedByKind: 'piloti',
          onBehalfOf: USER,
          originConversationId: ids.conversation,
          originMessageId: null,
          ...extra,
        })
      )

    it('stores an operation with no project, lists it on its own shelf, and shows another organization none of it', async () => {
      const { row } = await operationProposal(call({ body: { content: 'Wir bauen in Holz.' } }))
      expect(row).toMatchObject({ projectId: null, scope: 'organization', kind: 'operation' })
      const shelf = await repo.listShelfProposals(ORG, { scope: 'organization' }, { statuses: ['proposed'], limit: 50 })
      expect(shelf.map((entry) => entry.id)).toContain(row.id)
      const office = await repo.listShelfProposals(ORG, { scope: 'office_shelf' }, { statuses: ['proposed'], limit: 50 })
      expect(office.map((entry) => entry.id)).not.toContain(row.id)
      expect(await repo.findProposedChange(OTHER_ORG, row.id)).toBeNull()
    })

    it('refuses an organization-scoped proposal of any other kind, and one that names a project', async () => {
      const note = { scope: 'project', kind: 'decision', content: 'x', confidence: 'high' }
      await expect(propose({ projectId: null, scope: 'organization', kind: 'memory', payload: note })).rejects.toThrow()
      await expect(
        propose({ projectId: null, scope: 'organization', kind: 'file_operation', payload: PAYLOAD })
      ).rejects.toThrow()
      await expect(
        operationProposal(call({ body: { content: 'x1' } }), { projectId: ids.project })
      ).rejects.toThrow()
    })

    it('returns the open proposal for the same call, however the input is spelled', async () => {
      const first = await operationProposal(call({ params: { id: 'a' }, body: { name: 'Pläne', note: 'x' } }))
      expect(first.created).toBe(true)
      // The same call with its keys in another order: jsonb has one spelling per value.
      const again = await operationProposal(call({ body: { note: 'x', name: 'Pläne' }, params: { id: 'a' } }))
      expect(again).toMatchObject({ created: false, row: { id: first.row.id } })
      expect(await inOrg(ORG, () => repo.findOpenOperationProposal(ORG, ids.conversation, call({
        body: { name: 'Pläne', note: 'x' },
        params: { id: 'a' },
      })))).toMatchObject({ id: first.row.id })
    })

    it('makes one of two identical calls running at once', async () => {
      const results = await Promise.all(
        [1, 2, 3].map(() => operationProposal(call({ body: { content: 'gleichzeitig' } })))
      )
      expect(new Set(results.map((result) => result.row.id)).size).toBe(1)
      expect(results.filter((result) => result.created)).toHaveLength(1)
    })

    it('keeps another input, another operation and another conversation apart', async () => {
      const base = await operationProposal(call({ body: { content: 'eins' } }))
      const otherInput = await operationProposal(call({ body: { content: 'zwei' } }))
      const otherOperation = await operationProposal(call({ body: { content: 'eins' } }, 'skill-create'))
      const otherConversation = await operationProposal(call({ body: { content: 'eins' } }), {
        projectId: ids.project,
        scope: 'project',
        originConversationId: await conversation(ORG, `${ids.conversation}_second`, ids.project),
      })
      expect(
        new Set([base, otherInput, otherOperation, otherConversation].map((result) => result.row.id)).size
      ).toBe(4)
    })

    it('frees the call once the proposal is decided', async () => {
      const first = await operationProposal(call({ body: { content: 'später' } }))
      await inOrg(ORG, () => repo.dismissProposedChange(ORG, first.row.id, USER, stale()))
      const second = await operationProposal(call({ body: { content: 'später' } }))
      expect(second).toMatchObject({ created: true })
      expect(second.row.id).not.toBe(first.row.id)
    })

    it('does not dedupe a proposal made in no conversation', async () => {
      const a = await operationProposal(call({ body: { content: 'ohne Chat' } }), { originConversationId: null })
      const b = await operationProposal(call({ body: { content: 'ohne Chat' } }), { originConversationId: null })
      expect([a.created, b.created]).toEqual([true, true])
    })
  })
})
