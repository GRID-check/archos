/**
 * @vitest-environment node
 */
/**
 * The ratchet on Piloti's reads in a conversation (H1, ADR-0093, ADR-0094,
 * ADR-0122).
 *
 * A read runs as the requester and lands in a transcript the whole audience
 * reads. In a shared conversation only a read listed in `AUDIENCE_READS` (one
 * document's content, one project's facts) may reach the dispatcher, and no
 * backend read. Walked over the REAL catalog and the real backend operations
 * with the REAL judge: an operation added tomorrow is held by this file the day
 * it ships, with no list to remember to extend. Who reads the conversation and
 * the record are the database's (`read-gate.integration.spec.ts`).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

vi.mock('./dispatch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./dispatch')>()),
  callOperation: vi.fn(),
}))
vi.mock('./backend-operations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./backend-operations')>()),
  callBackendOperation: vi.fn(),
}))
vi.mock('./operation-proposals', () => ({ proposeOperation: vi.fn() }))
vi.mock('./telemetry', () => ({ recordOperationCalled: vi.fn(), recordCapabilityMissing: vi.fn() }))
vi.mock('@/lib/db/tenant-context', () => ({ withTenant: vi.fn((_tenant: unknown, run: () => unknown) => run()) }))
vi.mock('./operation-targets', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./operation-targets')>()),
  placesOf: vi.fn(),
}))
vi.mock('@/lib/cross-project/audience-reach', () => ({ audienceReachAmong: vi.fn() }))
vi.mock('@/lib/authz/folder-access-repository', () => ({ listProjectFolderTree: vi.fn(async () => []) }))
vi.mock('./conversation-audience', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./conversation-audience')>()),
  conversationAudienceOf: vi.fn(),
  ownRestrictingFolders: vi.fn(async () => ['folder_own']),
  recordWorkspaceHandOut: vi.fn(),
}))

import { audienceReachAmong } from '@/lib/cross-project/audience-reach'
import type { Project } from '@/lib/db/schema/projects'
import { BACKEND_OPERATIONS, callBackendOperation } from './backend-operations'
import { AGENT_OPERATIONS } from './catalog'
import {
  type ConversationAudience,
  READ_REFUSALS,
  conversationAudienceOf,
  ownRestrictingFolders,
  recordWorkspaceHandOut,
} from './conversation-audience'
import { callDecision, visibleOperations } from './policy'
import { callOperation } from './dispatch'
import { runBackendOperation, runOperation } from './discovery'
import type { AgentOperation } from './operation'
import { proposeOperation } from './operation-proposals'
import { KEY_TARGETS, placesOf } from './operation-targets'
import type { AgentPrincipal } from './principal'
import { AUDIENCE_READS, LINK_BEARING_OPERATIONS, readGateFor, sharedConversationReadRefusal } from './read-gate'

const session = {
  userId: 'user_1',
  email: 'a@piloti.test',
  name: null,
  accessToken: '',
  organizationId: 'org_1',
  organizationMembershipId: 'om_1',
  role: 'admin' as const,
  permissions: [],
  featureFlags: null,
}

/** A fresh principal per call, as the route builds one per HTTP request. */
const piloti = (): AgentPrincipal => ({
  actor: 'piloti',
  session,
  clientId: null,
  scopes: [],
  conversationId: 'conv_1',
  projectId: 'proj_1',
  answerMessageId: '6f1c2b8e-3d4a-5b6c-8d7e-9f0a1b2c3d4e',
})
const ctx = (principal: AgentPrincipal) => ({ principal, mode: 'search' as const })

const text = (result: { content: unknown[] }) => (result.content[0] as { text: string }).text

const audienceOf = (solo: boolean): ConversationAudience => ({
  row: { exists: true, projectId: 'proj_1', createdBy: 'user_1', visibility: 'private', grantees: solo ? [] : ['user_2'] },
  solo,
  key: solo ? 'private|user_1' : 'private|user_1|user_2',
})
const reachOf = (ids: string[], solo: boolean) => ({
  projects: ids.map((id) => ({ id }) as Project),
  restrictedFolders: solo,
  key: audienceOf(solo).key,
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(callOperation).mockResolvedValue({ status: 200, ok: true, body: { ok: true } })
  vi.mocked(callBackendOperation).mockResolvedValue({ status: 200, ok: true, body: { result: 'ok' } })
  vi.mocked(recordWorkspaceHandOut).mockResolvedValue(true)
  vi.mocked(placesOf).mockResolvedValue([])
})

describe('in a shared conversation', () => {
  beforeEach(() => {
    vi.mocked(conversationAudienceOf).mockResolvedValue(audienceOf(false))
  })

  const reads = visibleOperations(piloti()).filter((op) => callDecision(piloti(), op) === 'run')
  const unlisted = reads.filter((op) => !AUDIENCE_READS[op.name])

  it('has reads to hold (the walk below is not vacuous)', () => {
    expect(unlisted.length).toBeGreaterThan(50)
  })

  it.each(unlisted.map((op) => [op.name]))('%s never reaches callOperation', async (name) => {
    const result = await runOperation(ctx(piloti()), name, {})
    expect(callOperation).not.toHaveBeenCalled()
    expect(recordWorkspaceHandOut).not.toHaveBeenCalled()
    expect(result.isError).toBe(true)
    expect(text(result)).toBe(sharedConversationReadRefusal())
  })

  it.each(BACKEND_OPERATIONS.map((op) => [op.name, op] as const))('%s never reaches callBackendOperation', async (_name, op) => {
    const result = await runBackendOperation(ctx(piloti()), op, { projectId: 'proj_1' })
    expect(callBackendOperation).not.toHaveBeenCalled()
    expect(result.isError).toBe(true)
  })

  const PLACE_KEY = /project|folder|document|conversation|organi[sz]ation|url|path/i

  it('lists only reads of the catalog that name the one kind of place they carry, and no link', () => {
    for (const [name, { carries, narrows }] of Object.entries(AUDIENCE_READS)) {
      const op = reads.find((candidate) => candidate.name === name)
      expect(op, `${name} is not a read Piloti runs`).toBeDefined()
      expect(LINK_BEARING_OPERATIONS.has(name), `${name} hands on a link`).toBe(false)
      expect(op?.spansProjects, `${name} spans projects`).toBeUndefined()
      const segment = carries === 'document' ? '/api/documents/[id]' : '/api/projects/[id]'
      expect(op?.path.startsWith(segment), `${name} must name its ${carries} in its path`).toBe(true)
      expect(op?.path.match(/\[[^\]]+\]/g), `${name} must name nothing else`).toHaveLength(1)
      // A query only cuts the same answer shorter, says how, and names no place.
      if (narrows) expect(Object.keys((op?.query as { shape?: object } | undefined)?.shape ?? {}).filter((key) => PLACE_KEY.test(key)), name).toEqual([])
      else expect(op?.query, name).toBeUndefined()
      expect(op?.body, name).toBeUndefined()
    }
  })

  it('runs a listed read of a project in the audience’s reach, recorded before it runs', async () => {
    vi.mocked(placesOf).mockResolvedValue([{ projectId: 'proj_closed', conversationId: null }])
    vi.mocked(audienceReachAmong).mockResolvedValue(reachOf(['proj_closed'], false))
    const result = await runOperation(ctx(piloti()), 'project-get', { params: { id: 'proj_closed' } })
    expect(result.isError).toBeUndefined()
    expect(recordWorkspaceHandOut).toHaveBeenCalledWith(expect.anything(), audienceOf(false), {
      projectIds: ['proj_closed'],
      folderIds: [],
    })
    expect(vi.mocked(recordWorkspaceHandOut).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(callOperation).mock.invocationCallOrder[0],
    )
    // Nothing of the conversation's own project's restricted folders: a shared chat records none.
    expect(ownRestrictingFolders).not.toHaveBeenCalled()
  })

  it('refuses a listed read of a project outside the reach, and records nothing', async () => {
    vi.mocked(placesOf).mockResolvedValue([{ projectId: 'proj_active', conversationId: null }])
    vi.mocked(audienceReachAmong).mockResolvedValue(reachOf([], false))
    const result = await runOperation(ctx(piloti()), 'project-get', { params: { id: 'proj_active' } })
    expect(text(result)).toBe(READ_REFUSALS.outsideReach)
    expect(callOperation).not.toHaveBeenCalled()
    expect(recordWorkspaceHandOut).not.toHaveBeenCalled()
  })

  it('refuses a held document or another conversation’s file, even in reach', async () => {
    vi.mocked(audienceReachAmong).mockResolvedValue(reachOf(['proj_closed'], false))
    vi.mocked(placesOf).mockResolvedValueOnce([
      { projectId: 'proj_closed', conversationId: null, document: { folderId: null, passedScreening: false } },
    ])
    expect(text(await runOperation(ctx(piloti()), 'document-get', { params: { id: 'doc_1' } }))).toBe(
      READ_REFUSALS.notEveryReader,
    )
    vi.mocked(placesOf).mockResolvedValueOnce([
      { projectId: 'proj_1', conversationId: 'conv_other', document: { folderId: null, passedScreening: true } },
    ])
    expect(text(await runOperation(ctx(piloti()), 'document-get', { params: { id: 'doc_2' } }))).toBe(
      READ_REFUSALS.notEveryReader,
    )
    expect(callOperation).not.toHaveBeenCalled()
  })

  it('reads the audience once per request, however many reads it carries', async () => {
    const principal = piloti()
    for (const op of unlisted.slice(0, 5)) await runOperation(ctx(principal), op.name, {})
    expect(conversationAudienceOf).toHaveBeenCalledTimes(1)
  })

  it('still files a write as a proposal: it runs as whoever accepts it', async () => {
    vi.mocked(proposeOperation).mockResolvedValue({ proposalId: 'prop_1', summary: 'Rename' })
    const write = visibleOperations(piloti()).find((op) => callDecision(piloti(), op) === 'propose' && !op.params)
    expect(write).toBeDefined()
    await runOperation(ctx(piloti()), write!.name, {})
    expect(callOperation).not.toHaveBeenCalled()
  })

  it('words the refusal in English whatever the locale, for the model to word for the reader', () => {
    expect(sharedConversationReadRefusal()).toMatch(/^This conversation is shared/)
  })

  it('never hands on a link', async () => {
    for (const name of LINK_BEARING_OPERATIONS) {
      expect(AGENT_OPERATIONS.some((op) => op.name === name), `${name} is not in the catalog`).toBe(true)
    }
    expect(await readGateFor(piloti()).mayHandOnLink()).toBe(false)
  })

  it('fails closed when the audience cannot be read', async () => {
    vi.mocked(conversationAudienceOf).mockRejectedValue(new Error('database down'))
    const result = await runOperation(ctx(piloti()), 'project-get', { params: { id: 'proj_1' } })
    expect(result.isError).toBe(true)
    expect(callOperation).not.toHaveBeenCalled()
  })
})

describe('in a conversation that is the requester’s alone', () => {
  beforeEach(() => {
    vi.mocked(conversationAudienceOf).mockResolvedValue(audienceOf(true))
  })

  it('records each read before it runs, with the own project’s folders computed once per request', async () => {
    const principal = piloti()
    vi.mocked(placesOf).mockResolvedValue([{ projectId: 'proj_1', conversationId: null }])
    await runOperation(ctx(principal), 'project-get', { params: { id: 'proj_1' } })
    await runOperation(ctx(principal), 'project-member-list', { params: { id: 'proj_1' } })
    expect(recordWorkspaceHandOut).toHaveBeenCalledTimes(2)
    expect(recordWorkspaceHandOut).toHaveBeenCalledWith(principal, audienceOf(true), {
      projectIds: [],
      folderIds: ['folder_own'],
    })
    expect(ownRestrictingFolders).toHaveBeenCalledTimes(1)
    expect(vi.mocked(recordWorkspaceHandOut).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(callOperation).mock.invocationCallOrder[0],
    )
    expect(callOperation).toHaveBeenCalledTimes(2)
  })

  it('runs a read of another project in reach as a hand-out of that project', async () => {
    vi.mocked(placesOf).mockResolvedValue([{ projectId: 'proj_b', conversationId: null }])
    vi.mocked(audienceReachAmong).mockResolvedValue(reachOf(['proj_b'], true))
    const result = await runOperation(ctx(piloti()), 'project-get', { params: { id: 'proj_b' } })
    expect(result.isError).toBeUndefined()
    // A project's facts carry no folder; the conversation's own project is not touched.
    expect(recordWorkspaceHandOut).toHaveBeenCalledWith(expect.anything(), audienceOf(true), {
      projectIds: ['proj_b'],
      folderIds: [],
    })
    expect(audienceReachAmong).toHaveBeenCalledWith(session, audienceOf(true).row, ['proj_b'])
  })

  it('runs nothing outside the reach, and relays the refusal', async () => {
    vi.mocked(placesOf).mockResolvedValue([{ projectId: 'proj_b', conversationId: null }])
    vi.mocked(audienceReachAmong).mockResolvedValue(reachOf([], true))
    const result = await runOperation(ctx(piloti()), 'document-get', { params: { id: 'doc_1' } })
    expect(text(result)).toBe(READ_REFUSALS.outsideReach)
    expect(callOperation).not.toHaveBeenCalled()
  })

  it('runs nothing once the lock finds the audience changed', async () => {
    vi.mocked(recordWorkspaceHandOut).mockResolvedValue(false)
    const result = await runOperation(ctx(piloti()), 'inbox-summary-get', {})
    expect(text(result)).toBe(READ_REFUSALS.audienceChanged)
    expect(callOperation).not.toHaveBeenCalled()
  })

  it('runs nothing when the record cannot be written', async () => {
    vi.mocked(recordWorkspaceHandOut).mockRejectedValue(new Error('lock timeout'))
    const result = await runOperation(ctx(piloti()), 'inbox-summary-get', {})
    expect(result.isError).toBe(true)
    expect(callOperation).not.toHaveBeenCalled()
  })
})

/**
 * Reads Piloti runs in a project's solo conversation that name no project, document,
 * folder, conversation or model, and still carry no project's content. Each needs a
 * reason a reviewer can disagree with; a read that can carry another project's content
 * declares `spansProjects` instead, and is refused there.
 */
const SHELF_SCOPED =
  'a project only when its `projectId` names one, which the gate judges as any named project; else the office shelf, which belongs to no project'

const READS_WITHOUT_PROJECT_CONTENT: Readonly<Record<string, string>> = {
  'inbox-summary-get': 'a count of waiting items, no item',
  'feedback-report-list': "the person's own product feedback to the Piloti team, which belongs to no project",
  'feedback-office-report-list': "the office's product feedback to the Piloti team, which belongs to no project",
  'office-shelf-folder-list': 'the office shelf, which belongs to no project',
  'document-list': SHELF_SCOPED,
  'document-summary-get': SHELF_SCOPED,
  'document-by-name-resolve': SHELF_SCOPED,
  'document-name-match': SHELF_SCOPED,
  'document-revision-candidates': SHELF_SCOPED,
  'office-shelf-root-sort-get': 'the office shelf, which belongs to no project',
  'knowledge-base-get': 'the platform’s base corpus, the same for every organization',
  'norm-list': 'the platform’s norm register, public law pointers, the same for every organization',
  'organization-member-list': 'the organization’s members, which every member sees',
  'organization-role-list': 'the organization’s roles',
  'organization-memory-list': 'the knowledge shared by every project, which every member reads',
  'office-conventions-list': 'the office’s conventions, counted as patterns over several projects and shown as shapes; every member reads them',
  'organization-storage-get': 'storage totals of the organization',
  'skill-list': 'the organization’s skills',
  'skill-invocable-list': 'the skills the person may invoke',
  'skill-category-list': 'the skill categories',
  'saved-search-list':
    'search questions the person saved or the office shared, never a result: a scope may name a project by id, none of its content',
}

describe('every read of no named place either spans projects or carries no project’s content', () => {
  const namesSomething = (op: AgentOperation): boolean => {
    if (/\[[^\]]+\]/.test(op.path)) return true
    const shapes = [op.query, op.body].filter((schema): schema is z.ZodObject => schema instanceof z.ZodObject)
    return shapes.some((schema) =>
      Object.entries(schema.shape).some(([key, field]) => (key in KEY_TARGETS || key === 'resourceId' || key === 'entityId') && !(field as z.ZodType).isOptional()),
    )
  }
  const unscoped = visibleOperations(piloti()).filter(
    (op) => callDecision(piloti(), op) === 'run' && !op.spansProjects && !namesSomething(op),
  )

  it.each(unscoped.map((op) => [op.name]))('%s is listed with the reason it carries no project’s content', (name) => {
    expect(READS_WITHOUT_PROJECT_CONTENT[name], `${name}: declare spansProjects, or list it with a reason`).toBeTruthy()
  })

  it('lists nothing that has left the catalog or now spans projects', () => {
    for (const name of Object.keys(READS_WITHOUT_PROJECT_CONTENT)) {
      expect(unscoped.some((op) => op.name === name), `${name} is no longer an unscoped read`).toBe(true)
    }
  })

  it('marks the reads the review found leaking other projects’ content into a project conversation', () => {
    const spans = (name: string) => AGENT_OPERATIONS.find((op) => op.name === name)?.spansProjects
    expect(spans('passage-similar-search')).toBe('always')
    expect(spans('project-list')).toBe('always')
    expect(spans('inbox-list')).toBe('always')
    expect(spans('conversation-list')).toBe('unlessScoped')
  })
})

describe('outside a conversation', () => {
  it('reads the audience of nothing and records nothing for an external agent', async () => {
    vi.mocked(conversationAudienceOf).mockResolvedValue(null)
    const person: AgentPrincipal = { actor: 'external_agent', session, clientId: 'c', scopes: [] }
    const result = await runOperation(ctx(person), 'project-list', {})
    expect(result.isError).toBeUndefined()
    expect(recordWorkspaceHandOut).not.toHaveBeenCalled()
    expect(callOperation).toHaveBeenCalledTimes(1)
  })
})
