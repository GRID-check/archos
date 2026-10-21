/**
 * @vitest-environment node
 *
 * Piloti's workspace reads in a conversation that is the requester's alone,
 * against a REAL Postgres through the restricted runtime role (ADR-0093,
 * ADR-0094, ADR-0121):
 *
 *   GRID_TEST_DATABASE_URL=postgres://grid_app_rw@host:port/grid_app \
 *     npx vitest run src/lib/agent-api/read-gate.integration.spec.ts
 *
 * `task db:test:rls` (scripts/rls-test-db.sh) builds that database and runs it.
 *
 * The gate, the target lookups and the record are the real ones over the real
 * catalog; WorkOS's answer about the requester's roles is faked (none, so the
 * session's own permissions decide). What it proves, each a leak the security
 * review found with every unit spec green:
 *   - a read naming another project, by its id or through one of its
 *     documents, is refused before it runs, and records nothing;
 *   - a read naming any project in a turn that has none is refused;
 *   - a read whose answer spans the office's projects (similar passages, the
 *     project list, an unnarrowed conversation list) is refused in a
 *     project's conversation, and so is one naming what the lookup cannot find;
 *   - a read of the turn's own project runs, after every restricted folder of
 *     the project the requester may read is recorded for the conversation and
 *     the turn's answer is marked;
 *   - the record is written under the audience lock with the audience read
 *     again: a conversation shared in the meantime records nothing, and the
 *     read is refused.
 */

import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AuthorizedSession } from '@/lib/auth/types'

vi.mock('server-only', () => ({}))
// No roles from WorkOS: the session's own permissions decide (`seesEveryFolder`).
vi.mock('@/lib/auth/membership-roles', () => ({ resolveMembershipRoles: vi.fn(async () => null) }))

const STAMP = Date.now()
const ORG = `org_readgate_${STAMP}`
const OWNER = `user_readgate_${STAMP}`
const COLLEAGUE = `${OWNER}_2`
const ids = { own: '', other: '', folder: '', otherDocument: '' }

const url = process.env.GRID_TEST_DATABASE_URL

describe('the read-gate suite is not silently skipped in CI', () => {
  it('has a database to run against', () => {
    if (!process.env.GRID_RLS_SUITE_REQUIRED) return
    expect(url, 'GRID_TEST_DATABASE_URL is unset while GRID_RLS_SUITE_REQUIRED is set').toBeTruthy()
  })
})

describe.skipIf(!url)('Piloti’s reads in a solo conversation against Postgres', () => {
  let db: ReturnType<typeof import('@/lib/db').getDb>
  let withTenant: typeof import('@/lib/db/tenant-context').withTenant
  let gate: typeof import('./read-gate')
  let audience: typeof import('./conversation-audience')
  let findOperation: typeof import('./catalog').findOperation
  let seq = 0

  const session: AuthorizedSession = {
    userId: OWNER,
    email: `${OWNER}@grid.test`,
    name: null,
    accessToken: '',
    organizationId: ORG,
    organizationMembershipId: `om_${OWNER}`,
    role: 'admin',
    roles: ['admin'],
    permissions: ['org:projects:administer'],
    featureFlags: null,
  }
  const inOrg = <T>(run: () => PromiseLike<T>) => withTenant({ organizationId: ORG, userId: OWNER }, run)
  const first = (rows: Iterable<{ id: unknown }>) => String(Array.from(rows)[0]?.id)

  async function conversation(projectId: string | null): Promise<string> {
    seq += 1
    const id = `conv_readgate_${STAMP}_${seq}`
    await inOrg(() =>
      db.execute(sql`
        insert into conversations (id, organization_id, created_by, project_id, visibility)
        values (${id}, ${ORG}, ${OWNER}, ${projectId}::uuid, 'private')`)
    )
    return id
  }
  const principal = (conversationId: string, projectId: string | null, answerMessageId: string | null = null) => ({
    actor: 'piloti' as const,
    session,
    clientId: null,
    scopes: [],
    conversationId,
    projectId,
    answerMessageId,
  })
  const op = (name: string) => {
    const found = findOperation(name)
    if (!found) throw new Error(`${name} left the catalog: pick another read for this suite`)
    return found
  }
  const recordedFolders = async (conversationId: string) =>
    Array.from(
      await inOrg(() =>
        db.execute<{ folder_id: string }>(sql`
          select folder_id from conversation_restricted_folders where conversation_id = ${conversationId}`)
      )
    ).map((row) => String(row.folder_id))
  const marked = async (messageId: string) =>
    Number(
      Array.from(
        await inOrg(() =>
          db.execute<{ n: number }>(sql`select count(*)::int as n from message_restricted_use where message_id = ${messageId}`)
        )
      )[0]?.n
    )

  beforeAll(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    withTenant = (await import('@/lib/db/tenant-context')).withTenant
    db = (await import('@/lib/db')).getDb()
    gate = await import('./read-gate')
    audience = await import('./conversation-audience')
    findOperation = (await import('./catalog')).findOperation
    const project = async (name: string) =>
      first(
        await inOrg(() =>
          db.execute<{ id: string }>(sql`
            insert into projects (organization_id, name, created_by, collection_name)
            values (${ORG}, ${name}, ${OWNER}, ${`proj_readgate_${name}_${STAMP}`}) returning id`)
        )
      )
    ids.own = await project('own')
    ids.other = await project('other')
    ids.folder = first(
      await inOrg(() =>
        db.execute<{ id: string }>(sql`
          insert into project_folders (organization_id, project_id, name, path, access_mode, access_changed_by, access_changed_at)
          values (${ORG}, ${ids.own}::uuid, 'Verträge', 'Verträge', 'custom', ${OWNER}, now())
          returning id`)
      )
    )
    ids.otherDocument = first(
      await inOrg(() =>
        db.execute<{ id: string }>(sql`
          insert into documents (organization_id, project_id, scope, filename, storage_key, collection_name, created_by,
                                 status, screening_outcome)
          values (${ORG}, ${ids.other}::uuid, 'project', 'fremd.pdf', ${`k/readgate/${STAMP}`},
                  ${`proj_readgate_other_${STAMP}`}, ${OWNER}, 'completed', 'clean') returning id`)
      )
    )
  })

  afterAll(async () => {
    if (!db) return
    await inOrg(() => db.execute(sql`delete from conversations where organization_id = ${ORG}`))
    await inOrg(() => db.execute(sql`delete from documents where organization_id = ${ORG}`))
    await inOrg(() => db.execute(sql`delete from projects where organization_id = ${ORG}`))
  })

  it('refuses a read naming another project, by its id or through its document, and records nothing', async () => {
    const chat = await conversation(ids.own)
    const reads = gate.readGateFor(principal(chat, ids.own))
    expect(await reads.beforeRead(op('project-get'), { params: { id: ids.other } })).toBe(
      audience.SOLO_READ_REFUSALS.otherProject
    )
    expect(await reads.beforeRead(op('document-get'), { params: { id: ids.otherDocument } })).toBe(
      audience.SOLO_READ_REFUSALS.otherProject
    )
    expect(await reads.beforeRead(op('project-document-list'), { query: { projectId: ids.other } })).toBe(
      audience.SOLO_READ_REFUSALS.otherProject
    )
    expect(await recordedFolders(chat)).toEqual([])
  })

  it('refuses a read naming any project in a turn that has none', async () => {
    const chat = await conversation(null)
    const reads = gate.readGateFor(principal(chat, null))
    expect(await reads.beforeRead(op('project-get'), { params: { id: ids.own } })).toBe(audience.SOLO_READ_REFUSALS.noProject)
    expect(await reads.beforeRead(op('document-get'), { params: { id: ids.otherDocument } })).toBe(
      audience.SOLO_READ_REFUSALS.noProject
    )
  })

  it('runs a read of the turn’s own project after recording its restricted folders and marking the answer', async () => {
    const chat = await conversation(ids.own)
    const answer = randomUUID()
    const reads = gate.readGateFor(principal(chat, ids.own, answer))
    expect(await reads.beforeRead(op('project-get'), { params: { id: ids.own } })).toBeNull()
    expect(await recordedFolders(chat)).toEqual([ids.folder])
    expect(await marked(answer)).toBe(1)
    // A list narrowed to the turn's project runs on the same record.
    expect(await reads.beforeRead(op('conversation-list'), { query: { projectId: ids.own } })).toBeNull()
  })

  it('refuses a read whose answer spans the office’s projects in a project’s conversation', async () => {
    const chat = await conversation(ids.own)
    const reads = gate.readGateFor(principal(chat, ids.own))
    const passage = { document: { kind: 'stored', documentId: ids.own }, passage: { text: 'Stellplatz je Wohnung', cited: false } }
    // Naming the turn's own project does not narrow the similar-passage search: it reads every project.
    expect(await reads.beforeRead(op('passage-similar-search'), { body: { ...passage, projectId: ids.own } })).toBe(
      audience.SOLO_READ_REFUSALS.spansProjects
    )
    expect(await reads.beforeRead(op('project-list'), {})).toBe(audience.SOLO_READ_REFUSALS.spansProjects)
    expect(await reads.beforeRead(op('conversation-list'), {})).toBe(audience.SOLO_READ_REFUSALS.spansProjects)
    expect(await recordedFolders(chat)).toEqual([])
  })

  it('refuses a read naming something the lookup does not find, and passes the conversation’s own first turn', async () => {
    const chat = `conv_readgate_${STAMP}_unborn`
    const reads = gate.readGateFor(principal(chat, ids.own))
    expect(await reads.beforeRead(op('document-get'), { params: { id: randomUUID() } })).toBe(
      audience.SOLO_READ_REFUSALS.unknown
    )
    expect(await audience.soloReadRefusal(principal(chat, ids.own), op('conversation-get'), { params: { id: chat } })).toBeNull()
  })

  it('records nothing and refuses the read once the conversation was shared before the lock', async () => {
    const chat = await conversation(ids.own)
    await inOrg(() =>
      db.execute(sql`
        insert into resource_shares (organization_id, resource_type, resource_id, subject_user_id, role, granted_by)
        values (${ORG}, 'conversation', ${chat}, ${COLLEAGUE}, 'viewer', ${OWNER})`)
    )
    expect(await audience.recordSoloWorkspaceRead(principal(chat, ids.own))).toBe(false)
    expect(await recordedFolders(chat)).toEqual([])
  })
})
