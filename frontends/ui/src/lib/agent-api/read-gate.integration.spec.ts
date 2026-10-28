/**
 * @vitest-environment node
 *
 * Piloti's workspace reads in a conversation, against a REAL Postgres through
 * the restricted runtime role (ADR-0093, ADR-0094, ADR-0122):
 *
 *   TEST_DATABASE_URL=postgres://app_rw@host:port/app \
 *     npx vitest run src/lib/agent-api/read-gate.integration.spec.ts
 *
 * `task db:test:rls` (scripts/rls-test-db.sh) builds that database and runs it.
 *
 * The gate, the target lookups, the audience's reach and the record are the
 * real ones over the real catalog; WorkOS's answers are faked (the requester's
 * roles: none, so the session's own permissions decide; who else may open which
 * project: `opens`). What it proves, each the one rule ADR-0094 set for
 * reaching other projects:
 *   - a solo conversation in one project reads another project's document, and
 *     that project and the document's restricted folder are recorded before
 *     the read runs, the answer marked; a read of a whole other project records
 *     every restricted folder of it the requester may read;
 *   - a shared conversation reads a closed project (recorded) and refuses an
 *     active one not every reader may open, a restricted folder, and a read
 *     that answers with the requester's own view;
 *   - a share racing a read: the record under the audience lock refuses the
 *     read and records nothing of it;
 *   - `project_lookup` and the workspace door record the same for one document;
 *   - unchanged: a read spanning the office's projects is refused in a
 *     project's conversation, one naming what the lookup cannot place
 *     everywhere, and a read of the turn's own project runs on the record of its
 *     restricted folders.
 */

import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AuthorizedSession } from '@/lib/auth/types'
import { restrictedCollectionName } from '@/lib/authz/folder-access-rule'

vi.mock('server-only', () => ({}))
// No roles from WorkOS: the session's own permissions decide (`seesEverything`).
vi.mock('@/lib/auth/membership-roles', () => ({ resolveMembershipRoles: vi.fn(async () => null) }))

const STAMP = Date.now()
const ORG = `org_readgate_${STAMP}`
const OWNER = `user_readgate_${STAMP}`
const COLLEAGUE = `${OWNER}_2`
const ids = {
  own: '',
  other: '',
  closed: '',
  folder: '',
  otherFolder: '',
  closedFolder: '',
  otherDocument: '',
  openOtherDocument: '',
  closedDocument: '',
  closedRestrictedDocument: '',
}

/** Who besides the requester may open which active project (WorkOS's answer). A closed one is everyone's. */
const opens = new Set<string>()
vi.mock('@/lib/authz/project-membership', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/authz/project-membership')>()),
  userHoldsProjectPermission: vi.fn(async (_session: unknown, projectId: string, userId: string) =>
    projectId === ids.closed || opens.has(`${userId}:${projectId}`)
  ),
}))
// The lookup's backend: the vector search answers one passage of the document named here.
const searchHit = vi.hoisted(() => ({ collection: '', fileName: '' }))
vi.mock('@/lib/documents/semantic-search', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/documents/semantic-search')>()),
  fetchGroupedSemanticHits: vi.fn(async (collections: readonly string[]) =>
    collections.includes(searchHit.collection)
      ? [{ file_name: searchHit.fileName, score: 0.9, snippet: 'Brandabschnitt', page_number: 1, collection: searchHit.collection, rank: 0 }]
      : []
  ),
}))
vi.mock('@/lib/cross-project/decisions-repository', () => ({ searchProjectDecisions: vi.fn(async () => []) }))
vi.mock('@/lib/permits/repository', () => ({ searchPermitRequirements: vi.fn(async () => []) }))

const url = process.env.TEST_DATABASE_URL

describe('the read-gate suite is not silently skipped in CI', () => {
  it('has a database to run against', () => {
    if (!process.env.RLS_SUITE_REQUIRED) return
    expect(url, 'TEST_DATABASE_URL is unset while RLS_SUITE_REQUIRED is set').toBeTruthy()
  })
})

describe.skipIf(!url)('Piloti’s workspace reads against Postgres', () => {
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

  async function conversation(projectId: string | null, grantees: readonly string[] = []): Promise<string> {
    seq += 1
    const id = `conv_readgate_${STAMP}_${seq}`
    await inOrg(() =>
      db.execute(sql`
        insert into conversations (id, organization_id, created_by, project_id, visibility)
        values (${id}, ${ORG}, ${OWNER}, ${projectId}::uuid, 'private')`)
    )
    for (const grantee of grantees) await share(id, grantee)
    return id
  }
  const share = (conversationId: string, grantee: string) =>
    inOrg(() =>
      db.execute(sql`
        insert into resource_shares (organization_id, resource_type, resource_id, subject_user_id, role, granted_by)
        values (${ORG}, 'conversation', ${conversationId}, ${grantee}, 'viewer', ${OWNER})`)
    )
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
  const column = async (query: ReturnType<typeof sql>) =>
    Array.from(await inOrg(() => db.execute<{ id: string }>(query)))
      .map((row) => String(row.id))
      .sort()
  const recordedFolders = (conversationId: string) =>
    column(sql`select folder_id as id from conversation_restricted_folders where conversation_id = ${conversationId}`)
  const recordedProjects = (conversationId: string) =>
    column(sql`select project_id as id from conversation_source_projects where conversation_id = ${conversationId}`)
  const marked = async (messageId: string) =>
    Number(
      Array.from(
        await inOrg(() =>
          db.execute<{ n: number }>(sql`select count(*)::int as n from message_restricted_use where message_id = ${messageId}`)
        )
      )[0]?.n
    )

  beforeAll(async () => {
    process.env.APP_DATABASE_URL = url
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
    const folder = async (projectId: string, name: string) =>
      first(
        await inOrg(() =>
          db.execute<{ id: string }>(sql`
            insert into project_folders (organization_id, project_id, name, path, access_mode, access_changed_by, access_changed_at)
            values (${ORG}, ${projectId}::uuid, ${name}, ${name}, 'custom', ${OWNER}, now())
            returning id`)
        )
      )
    const document = async (projectName: string, projectId: string, filename: string, folderId: string | null) => {
      const base = `proj_readgate_${projectName}_${STAMP}`
      const collection = folderId ? restrictedCollectionName(base, folderId) : base
      return first(
        await inOrg(() =>
          db.execute<{ id: string }>(sql`
            insert into documents (organization_id, project_id, scope, filename, storage_key, collection_name, created_by,
                                   status, screening_outcome, folder_id)
            values (${ORG}, ${projectId}::uuid, 'project', ${filename}, ${`k/readgate/${STAMP}/${filename}`},
                    ${collection}, ${OWNER}, 'completed', 'clean', ${folderId}::uuid) returning id`)
        )
      )
    }
    ids.own = await project('own')
    ids.other = await project('other')
    ids.closed = await project('closed')
    ids.folder = await folder(ids.own, 'Verträge')
    ids.otherFolder = await folder(ids.other, 'Honorar')
    ids.closedFolder = await folder(ids.closed, 'Personal')
    ids.otherDocument = await document('other', ids.other, 'fremd.pdf', ids.otherFolder)
    ids.openOtherDocument = await document('other', ids.other, 'offen.pdf', null)
    ids.closedDocument = await document('closed', ids.closed, 'archiv.pdf', null)
    ids.closedRestrictedDocument = await document('closed', ids.closed, 'gehalt.pdf', ids.closedFolder)
    // A closed project takes no new folder or document, so it closes last.
    await inOrg(() =>
      db.execute(sql`
        update projects set status = 'closed', closed_at = now(), closed_by = ${OWNER}, closed_outcome = 'completed',
          ended_on = coalesce(ended_on, greatest(date_trunc('month', now())::date, started_on))
        where id = ${ids.closed}::uuid`)
    )
  })

  afterAll(async () => {
    if (!db) return
    await inOrg(() => db.execute(sql`delete from conversations where organization_id = ${ORG}`))
    await inOrg(() => db.execute(sql`delete from documents where organization_id = ${ORG}`))
    await inOrg(() => db.execute(sql`delete from projects where organization_id = ${ORG}`))
  })

  describe('in a conversation that is the requester’s alone', () => {
    it('reads another project’s document, recording the project and its restricted folder before it runs', async () => {
      const chat = await conversation(ids.own)
      const answer = randomUUID()
      const reads = gate.readGateFor(principal(chat, ids.own, answer))
      expect(await reads.beforeRead(op('document-get'), { params: { id: ids.otherDocument } })).toBeNull()
      expect(await recordedProjects(chat)).toEqual([ids.other])
      // The document's own folder, not the conversation's project's: the read touched only the other project.
      expect(await recordedFolders(chat)).toEqual([ids.otherFolder])
      expect(await marked(answer)).toBe(1)
    })

    it('records every restricted folder of another project for a read of the whole project', async () => {
      const chat = await conversation(ids.own)
      const reads = gate.readGateFor(principal(chat, ids.own))
      expect(await reads.beforeRead(op('document-list'), { query: { projectId: ids.other } })).toBeNull()
      expect(await recordedProjects(chat)).toEqual([ids.other])
      expect(await recordedFolders(chat)).toEqual([ids.otherFolder])
      // A project's facts carry no folder.
      const facts = await conversation(ids.own)
      expect(await gate.readGateFor(principal(facts, ids.own)).beforeRead(op('project-get'), { params: { id: ids.other } })).toBeNull()
      expect(await recordedProjects(facts)).toEqual([ids.other])
      expect(await recordedFolders(facts)).toEqual([])
    })

    it('reads a project from a conversation in no project, recorded as a hand-out', async () => {
      const chat = await conversation(null)
      const reads = gate.readGateFor(principal(chat, null))
      expect(await reads.beforeRead(op('project-get'), { params: { id: ids.own } })).toBeNull()
      expect(await recordedProjects(chat)).toEqual([ids.own])
    })

    it('runs a read of the turn’s own project after recording its restricted folders and marking the answer', async () => {
      const chat = await conversation(ids.own)
      const answer = randomUUID()
      const reads = gate.readGateFor(principal(chat, ids.own, answer))
      expect(await reads.beforeRead(op('project-get'), { params: { id: ids.own } })).toBeNull()
      expect(await recordedFolders(chat)).toEqual([ids.folder])
      expect(await recordedProjects(chat)).toEqual([])
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
        audience.READ_REFUSALS.spansProjects
      )
      expect(await reads.beforeRead(op('project-list'), {})).toBe(audience.READ_REFUSALS.spansProjects)
      expect(await reads.beforeRead(op('conversation-list'), {})).toBe(audience.READ_REFUSALS.spansProjects)
      expect(await recordedFolders(chat)).toEqual([])
    })

    it('refuses a read naming something the lookup does not find, and passes the conversation’s own first turn', async () => {
      const chat = `conv_readgate_${STAMP}_unborn`
      const reads = gate.readGateFor(principal(chat, ids.own))
      expect(await reads.beforeRead(op('document-get'), { params: { id: randomUUID() } })).toBe(audience.READ_REFUSALS.unknown)
      expect(await reads.beforeRead(op('conversation-get'), { params: { id: chat } })).toBeNull()
      // A resource of a type the lookup cannot place names nothing it could check.
      expect(
        await reads.beforeRead(op('assignment-candidate-list'), { params: { resourceType: 'annotation', resourceId: randomUUID() } })
      ).toBe(audience.READ_REFUSALS.unknown)
    })
  })

  describe('in a shared conversation', () => {
    it('reads a closed project and records it; refuses an active one not every reader may open', async () => {
      const chat = await conversation(ids.own, [COLLEAGUE])
      const reads = gate.readGateFor(principal(chat, ids.own))
      expect(await reads.beforeRead(op('project-get'), { params: { id: ids.closed } })).toBeNull()
      expect(await reads.beforeRead(op('document-get'), { params: { id: ids.closedDocument } })).toBeNull()
      expect(await recordedProjects(chat)).toEqual([ids.closed])
      expect(await reads.beforeRead(op('project-get'), { params: { id: ids.other } })).toBe(audience.READ_REFUSALS.outsideReach)
      expect(await reads.beforeRead(op('document-get'), { params: { id: ids.openOtherDocument } })).toBe(
        audience.READ_REFUSALS.outsideReach
      )
      expect(await recordedProjects(chat)).toEqual([ids.closed])
      expect(await recordedFolders(chat)).toEqual([])
    })

    it('reads an active project every reader may open', async () => {
      opens.add(`${COLLEAGUE}:${ids.other}`)
      try {
        const chat = await conversation(ids.own, [COLLEAGUE])
        const reads = gate.readGateFor(principal(chat, ids.own))
        expect(await reads.beforeRead(op('document-get'), { params: { id: ids.openOtherDocument } })).toBeNull()
        expect(await recordedProjects(chat)).toEqual([ids.other])
      } finally {
        opens.delete(`${COLLEAGUE}:${ids.other}`)
      }
    })

    it('refuses a restricted folder, even of a closed project, and records nothing', async () => {
      const chat = await conversation(ids.own, [COLLEAGUE])
      const reads = gate.readGateFor(principal(chat, ids.own))
      expect(await reads.beforeRead(op('document-get'), { params: { id: ids.closedRestrictedDocument } })).toBe(
        audience.READ_REFUSALS.restrictedFolder
      )
      expect(await recordedProjects(chat)).toEqual([])
      expect(await recordedFolders(chat)).toEqual([])
    })

    it('refuses a read that answers with the requester’s own view, of its own project too', async () => {
      const chat = await conversation(ids.own, [COLLEAGUE])
      const reads = gate.readGateFor(principal(chat, ids.own))
      expect(await reads.beforeRead(op('project-member-list'), { params: { id: ids.closed } })).toBe(audience.READ_REFUSALS.shared)
      expect(await reads.beforeRead(op('document-list'), { query: { projectId: ids.own } })).toBe(
        audience.READ_REFUSALS.shared
      )
      expect(await reads.beforeRead(op('project-get'), { params: { id: ids.own } })).toBeNull()
      expect(await recordedFolders(chat)).toEqual([])
    })
  })

  it('refuses a read whose conversation was shared after its audience was read, and records nothing of it', async () => {
    const chat = await conversation(ids.own)
    const reads = gate.readGateFor(principal(chat, ids.own))
    // The audience is read now: the requester's alone.
    expect(await reads.beforeRead(op('project-get'), { params: { id: ids.own } })).toBeNull()
    await share(chat, COLLEAGUE)
    // Judged against the solo audience it read, the record under the lock sees the share.
    expect(await reads.beforeRead(op('document-get'), { params: { id: ids.otherDocument } })).toBe(
      audience.READ_REFUSALS.audienceChanged
    )
    expect(await recordedProjects(chat)).toEqual([])
    expect(await recordedFolders(chat)).toEqual([ids.folder])
  })

  it('records the same for one document whether project_lookup or the workspace door hands it out', async () => {
    const { searchAcrossProjects } = await import('@/lib/cross-project/service')
    const { crossProjectSearchRequestSchema } = await import('@/lib/cross-project/types')
    searchHit.collection = restrictedCollectionName(`proj_readgate_other_${STAMP}`, ids.otherFolder)
    searchHit.fileName = 'fremd.pdf'
    const viaLookup = await conversation(ids.own)
    const found = await inOrg(() =>
      searchAcrossProjects(
        { session, conversationId: viaLookup, currentProjectId: ids.own },
        crossProjectSearchRequestSchema.parse({ query: 'Brandabschnitt', scope: 'named', projectIds: [ids.other] })
      )
    )
    expect(found.hits.map((hit) => hit.documentId)).toEqual([ids.otherDocument])
    const viaDoor = await conversation(ids.own)
    expect(await gate.readGateFor(principal(viaDoor, ids.own)).beforeRead(op('document-get'), { params: { id: ids.otherDocument } })).toBeNull()

    expect(await recordedProjects(viaDoor)).toEqual(await recordedProjects(viaLookup))
    expect(await recordedFolders(viaDoor)).toEqual(await recordedFolders(viaLookup))
    expect(await recordedFolders(viaDoor)).toEqual([ids.otherFolder])
  })
})
