/**
 * @vitest-environment node
 *
 * Proposed changes (migration 0140) against a REAL Postgres through the
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
 *   - a proposal goes with its project, and with its conversation.
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
  operations: [{ document: 'Grundriss EG.pdf', source: 'projekt', target_folder: 'Einreichung' }],
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

  const propose = (extra: Partial<import('./repository').NewProposedChange> = {}) =>
    inOrg(extra.organizationId ?? ORG, () =>
      repo.insertProposedChange({
        organizationId: ORG,
        projectId: ids.project,
        kind: 'file_operation',
        payload: PAYLOAD,
        proposedByKind: 'piloti',
        onBehalfOf: USER,
        originConversationId: ids.conversation,
        originMessageId: null,
        ...extra,
      })
    )

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
})
