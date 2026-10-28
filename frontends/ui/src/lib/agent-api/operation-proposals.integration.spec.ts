/**
 * @vitest-environment node
 *
 * Piloti's writes through the MCP surface, filed as proposals against a REAL
 * Postgres through the restricted runtime role (ADR-0122, ADR-0105):
 *
 *   TEST_DATABASE_URL=postgres://app_rw@host:port/app \
 *     npx vitest run src/lib/agent-api/operation-proposals.integration.spec.ts
 *
 * `task db:test:rls` (scripts/rls-test-db.sh) builds that database and runs it.
 *
 * `proposeOperation` is called the way the MCP route calls it: outside any
 * tenant scope, with the real catalog, the real proposal service, the real
 * repository and the real target lookups. Only WorkOS is faked (who holds a
 * grant on which project), and the side effects that leave the process. What
 * it proves, each a bug a mocked repository agreed with:
 *   - a write in a conversation is filed: the conversation, the open-call
 *     look-up and the insert run in the asker's tenant scope (the live QA run
 *     found every one failing with `MissingTenantContextError`);
 *   - the turn's answer is the proposal's origin message;
 *   - the same call again in the conversation is the same proposal;
 *   - a member's Piloti cannot file a change to a project the member cannot
 *     see (the confused deputy), and nothing is stored;
 *   - the card names the target for a reader who may read it, by name;
 *   - a reader who may decide the proposal's project but not read its target
 *     sees no decision on the card, and an apply of theirs is refused and
 *     leaves the card open for somebody who can (it used to end it `failed`);
 *   - in a shared conversation, a change naming a project outside the
 *     audience's reach (ADR-0094) is refused and stores nothing, while one of
 *     the conversation's own project is filed;
 *   - a press on the proposal card inside another assistant (an MCP App's
 *     app-only tool, ADR-0142) goes through the same route and gate as the
 *     UI's button: the member who may not decide is refused with the route's
 *     403 and the card stays open; the admin's press decides it.
 */

import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AuthorizedSession } from '@/lib/auth/types'

vi.mock('server-only', () => ({}))

const STAMP = Date.now()
const ORG = `org_opprop_${STAMP}`
const ADMIN = `user_opprop_admin_${STAMP}`
const MEMBER = `user_opprop_member_${STAMP}`
const ids = { visible: '', hidden: '' }

// WorkOS: the member holds a grant on the visible project and none on the hidden one.
vi.mock('@/lib/authz/resource-check', async () => {
  const { PROJECT_PERMISSION_SPECS } = await import('@/lib/authz/catalog')
  return {
    checkResourcePermission: vi.fn(async (input: { resourceExternalId: string }) => input.resourceExternalId === ids.visible),
    effectiveResourcePermissions: vi.fn(
      async (input: { resourceExternalId: string }) =>
        new Set(input.resourceExternalId === ids.visible ? PROJECT_PERMISSION_SPECS.map(({ slug }) => slug) : [])
    ),
  }
})
// WorkOS: who besides the asker may open which project; the member opens the visible one only.
vi.mock('@/lib/authz/project-membership', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/authz/project-membership')>()),
  userHoldsProjectPermission: vi.fn(async (_session: unknown, projectId: string) => projectId === ids.visible),
}))
vi.mock('@/lib/sharing/directory', () => ({ loadOrganizationDirectory: vi.fn(async () => new Map()) }))
vi.mock('@/lib/audit/after-commit', () => ({ recordAuditEventAfterCommit: vi.fn() }))
vi.mock('@/lib/proposals/attention', () => ({
  onProposalCreated: vi.fn(async () => undefined),
  onProposalDecided: vi.fn(async () => undefined),
}))

const url = process.env.TEST_DATABASE_URL

describe('the operation-proposal suite is not silently skipped in CI', () => {
  it('has a database to run against', () => {
    if (!process.env.RLS_SUITE_REQUIRED) return
    expect(url, 'TEST_DATABASE_URL is unset while RLS_SUITE_REQUIRED is set').toBeTruthy()
  })
})

describe.skipIf(!url)('Piloti’s proposed operations against Postgres', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let proposeOperation: typeof import('./operation-proposals').proposeOperation
  let getProposal: typeof import('@/lib/proposals/service').getProposal
  let applyProposal: typeof import('@/lib/proposals/service').applyProposal
  let dismissProposal: typeof import('@/lib/proposals/service').dismissProposal
  let rename: import('./operation').AgentOperation
  const conversation = `conv_opprop_${STAMP}`

  const session = (userId: string, permissions: string[]): AuthorizedSession => ({
    userId,
    email: `${userId}@grid.test`,
    name: null,
    accessToken: '',
    organizationId: ORG,
    organizationMembershipId: `om_${userId}`,
    role: 'member',
    roles: ['member'],
    permissions,
    featureFlags: null,
  })
  const admin = session(ADMIN, ['org:projects:administer'])
  const member = session(MEMBER, [])
  const inOrg = <T>(run: () => PromiseLike<T>) => withTenant({ organizationId: ORG, userId: ADMIN }, run)
  const rowsFor = async (projectId: string) =>
    Array.from(
      await inOrg(() =>
        db.execute<{ id: string; origin_message_id: string | null; on_behalf_of: string }>(sql`
          select id, origin_message_id, on_behalf_of from proposed_changes
          where organization_id = ${ORG} and kind = 'operation' and payload->'input'->'params'->>'id' = ${projectId}`)
      )
    )

  beforeAll(async () => {
    process.env.APP_DATABASE_URL = url
    withTenant = (await import('@/lib/db/tenant-context')).withTenant
    db = (await import('@/lib/db')).getDb()
    proposeOperation = (await import('./operation-proposals')).proposeOperation
    getProposal = (await import('@/lib/proposals/service')).getProposal
    applyProposal = (await import('@/lib/proposals/service')).applyProposal
    dismissProposal = (await import('@/lib/proposals/service')).dismissProposal
    const found = (await import('./catalog')).findOperation('project-rename')
    if (!found) throw new Error('project-rename left the catalog: pick another write for this suite')
    rename = found
    const project = async (name: string) => {
      const [row] = Array.from(
        await inOrg(() =>
          db.execute<{ id: string }>(sql`
            insert into projects (organization_id, name, created_by, collection_name)
            values (${ORG}, ${name}, ${ADMIN}, ${`proj_opprop_${name}_${STAMP}`}) returning id`)
        )
      )
      return String(row.id)
    }
    ids.visible = await project('Sichtbar')
    ids.hidden = await project('Verborgen')
    await inOrg(() =>
      db.execute(sql`
        insert into conversations (id, organization_id, created_by, project_id, visibility)
        values (${conversation}, ${ORG}, ${ADMIN}, ${ids.visible}::uuid, 'private')`)
    )
  })

  afterAll(async () => {
    if (!db) return
    await inOrg(() => db.execute(sql`delete from proposed_changes where organization_id = ${ORG}`))
    await inOrg(() => db.execute(sql`delete from conversations where organization_id = ${ORG}`))
    await inOrg(() => db.execute(sql`delete from projects where organization_id = ${ORG}`))
  })

  it('files a write made in a conversation, outside any tenant scope, as the MCP route calls it', async () => {
    const answerMessageId = randomUUID()
    const input = { params: { id: ids.visible }, body: { name: 'Sichtbar, umbenannt' } }
    const first = await proposeOperation({
      principal: { session: admin, conversationId: conversation, projectId: ids.visible, answerMessageId },
      op: rename,
      input,
    })
    const stored = await rowsFor(ids.visible)
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ id: first.proposalId, origin_message_id: answerMessageId, on_behalf_of: ADMIN })

    // The same call again while the first is open is the first: the look-up ran in the tenant scope too.
    const again = await proposeOperation({
      principal: { session: admin, conversationId: conversation, projectId: ids.visible, answerMessageId: randomUUID() },
      op: rename,
      input,
    })
    expect(again.proposalId).toBe(first.proposalId)
    expect(await rowsFor(ids.visible)).toHaveLength(1)
  })

  it('refuses a member’s Piloti a change to a project the member cannot see, and stores nothing', async () => {
    await expect(
      proposeOperation({
        principal: { session: member, conversationId: conversation, projectId: ids.visible },
        op: rename,
        input: { params: { id: ids.hidden }, body: { name: 'Gekapert' } },
      })
    ).rejects.toMatchObject({ status: 404 })
    expect(await rowsFor(ids.hidden)).toHaveLength(0)
  })

  it('names the target on the card for a reader who may read it', async () => {
    const { proposalId } = await proposeOperation({
      principal: { session: admin, conversationId: conversation, projectId: ids.visible },
      op: rename,
      input: { params: { id: ids.hidden }, body: { name: 'Verborgen, umbenannt' } },
    })
    const view = await inOrg(() => getProposal(admin, proposalId))
    expect(view.kind === 'operation' && view.targets).toEqual([{ type: 'project', id: ids.hidden, name: 'Verborgen' }])
  })

  it('gives no decision to a reader who cannot read the target, and keeps the card open when they try', async () => {
    const { proposalId } = await proposeOperation({
      principal: { session: admin, conversationId: conversation, projectId: ids.visible },
      op: rename,
      input: { params: { id: ids.hidden }, body: { name: 'Verborgen, nochmals' } },
    })
    // The member reads the conversation (and so the card), and may decide in its project, not see the target.
    await inOrg(() =>
      db.execute(sql`
        insert into resource_shares (organization_id, resource_type, resource_id, subject_user_id, role, granted_by)
        values (${ORG}, 'conversation', ${conversation}, ${MEMBER}, 'viewer', ${ADMIN})
        on conflict do nothing`)
    )
    const asMember = <T>(run: () => PromiseLike<T>) => withTenant({ organizationId: ORG, userId: MEMBER }, run)
    expect((await inOrg(() => getProposal(admin, proposalId))).canDecide).toBe(true)
    expect((await asMember(() => getProposal(member, proposalId))).canDecide).toBe(false)
    await expect(
      asMember(() => applyProposal(member, proposalId, new Request('http://localhost/api/proposals/apply', { method: 'POST' })))
    ).rejects.toMatchObject({ status: 403 })
    // Nor may they dismiss it: no button means no decision, either way (it used to let the dismiss through).
    await expect(asMember(() => dismissProposal(member, proposalId))).rejects.toMatchObject({ status: 403 })
    expect((await inOrg(() => getProposal(admin, proposalId))).status).toBe('proposed')
  })

  it('holds a press on the MCP Apps card to the route the UI calls: refused for the member, decided for the admin', async () => {
    const { runAppTool } = await import('./mcp-apps')
    const { APP_TOOLS } = await import('./catalog/app-views')
    const tool = (name: string) => {
      const found = APP_TOOLS.find((entry) => entry.name === name)
      if (!found) throw new Error(`${name} left APP_TOOLS`)
      return found
    }
    const outside = (who: AuthorizedSession) => ({
      principal: { actor: 'external_agent' as const, clientId: 'client_claude', scopes: [], session: who },
      mode: 'tools' as const,
      appHost: 'declared' as const,
    })
    // Filed in a conversation of the admin's own, then shared with the member, who reads the card and may not
    // decide it: its target is hidden from them.
    const own = `${conversation}_card`
    await inOrg(() =>
      db.execute(sql`
        insert into conversations (id, organization_id, created_by, project_id, visibility)
        values (${own}, ${ORG}, ${ADMIN}, ${ids.visible}::uuid, 'private')`)
    )
    const { proposalId } = await proposeOperation({
      principal: { session: admin, conversationId: own, projectId: ids.visible },
      op: rename,
      input: { params: { id: ids.hidden }, body: { name: 'Verborgen, aus Claude' } },
    })
    await inOrg(() =>
      db.execute(sql`
        insert into resource_shares (organization_id, resource_type, resource_id, subject_user_id, role, granted_by)
        values (${ORG}, 'conversation', ${own}, ${MEMBER}, 'viewer', ${ADMIN})`)
    )

    const refused = await runAppTool(outside(member), tool('proposal-card-apply'), { id: proposalId })
    expect(refused.isError).toBe(true)
    expect(refused.structuredContent).toMatchObject({ status: 403 })
    const dismissRefused = await runAppTool(outside(member), tool('proposal-card-dismiss'), { id: proposalId })
    expect(dismissRefused.structuredContent).toMatchObject({ status: 403 })
    expect((await inOrg(() => getProposal(admin, proposalId))).status).toBe('proposed')

    const decided = await runAppTool(outside(admin), tool('proposal-card-dismiss'), { id: proposalId })
    expect(decided.isError).toBeFalsy()
    expect(decided.structuredContent).toMatchObject({ proposal: { id: proposalId, status: 'dismissed', decidedBy: ADMIN } })
    // A second press is the route's 409, which the card shows as the earlier decision.
    const again = await runAppTool(outside(admin), tool('proposal-card-dismiss'), { id: proposalId })
    expect(again.structuredContent).toMatchObject({ status: 409 })
  })

  it('refuses, in a shared conversation, a change to a project not every reader may open, and stores nothing', async () => {
    const shared = `${conversation}_shared`
    await inOrg(() =>
      db.execute(sql`
        insert into conversations (id, organization_id, created_by, project_id, visibility)
        values (${shared}, ${ORG}, ${ADMIN}, ${ids.visible}::uuid, 'private')`)
    )
    await inOrg(() =>
      db.execute(sql`
        insert into resource_shares (organization_id, resource_type, resource_id, subject_user_id, role, granted_by)
        values (${ORG}, 'conversation', ${shared}, ${MEMBER}, 'viewer', ${ADMIN})`)
    )
    const before = (await rowsFor(ids.hidden)).length
    await expect(
      proposeOperation({
        principal: { session: admin, conversationId: shared, projectId: ids.visible },
        op: rename,
        input: { params: { id: ids.hidden }, body: { name: 'Vor allen' } },
      })
    ).rejects.toMatchObject({ status: 403 })
    expect(await rowsFor(ids.hidden)).toHaveLength(before)
    // The conversation's own project is every reader's: filed.
    const own = await proposeOperation({
      principal: { session: admin, conversationId: shared, projectId: ids.visible },
      op: rename,
      input: { params: { id: ids.visible }, body: { name: 'Sichtbar, im Team' } },
    })
    expect(own.proposalId).toBeTruthy()
  })
})
