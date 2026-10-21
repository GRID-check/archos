/**
 * @vitest-environment node
 */
/**
 * The ratchet on Piloti's reads in a conversation other people read (H1,
 * ADR-0093, ADR-0094, ADR-0121).
 *
 * A read runs as the requester and lands in a transcript the whole audience
 * reads, so in a shared conversation no read Piloti can name may reach the
 * dispatcher or the backend. Walked over the REAL catalog and the real backend
 * operations: an operation added tomorrow is held by this file the day it
 * ships, with no list to remember to extend.
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
vi.mock('./conversation-audience', () => ({
  conversationReachOf: vi.fn(),
  recordSoloWorkspaceRead: vi.fn(),
  soloReadRefusal: vi.fn(),
}))

import { BACKEND_OPERATIONS, callBackendOperation } from './backend-operations'
import { AGENT_OPERATIONS } from './catalog'
import { conversationReachOf, recordSoloWorkspaceRead, soloReadRefusal } from './conversation-audience'
import { callOperation } from './dispatch'
import { runBackendOperation, runOperation } from './discovery'
import type { AgentOperation } from './operation'
import { proposeOperation } from './operation-proposals'
import { KEY_TARGETS } from './operation-targets'
import { callDecision, visibleOperations } from './policy'
import type { AgentPrincipal } from './principal'
import { AUDIENCE_SAFE_READ_DOMAINS, LINK_BEARING_OPERATIONS, readGateFor, sharedConversationReadRefusal } from './read-gate'

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

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(callOperation).mockResolvedValue({ status: 200, ok: true, body: { ok: true } })
  vi.mocked(callBackendOperation).mockResolvedValue({ status: 200, ok: true, body: { result: 'ok' } })
  vi.mocked(recordSoloWorkspaceRead).mockResolvedValue(true)
  vi.mocked(soloReadRefusal).mockResolvedValue(null)
})

describe('in a shared conversation', () => {
  beforeEach(() => {
    vi.mocked(conversationReachOf).mockResolvedValue('shared')
  })

  const reads = visibleOperations(piloti()).filter((op) => callDecision(piloti(), op) === 'run')

  it('has reads to hold (the walk below is not vacuous)', () => {
    expect(reads.length).toBeGreaterThan(50)
  })

  it.each(reads.map((op) => [op.name]))('%s never reaches callOperation', async (name) => {
    const result = await runOperation(ctx(piloti()), name, {})
    expect(callOperation).not.toHaveBeenCalled()
    expect(result.isError).toBe(true)
    expect(text(result)).toBe(sharedConversationReadRefusal())
  })

  it.each(BACKEND_OPERATIONS.map((op) => [op.name, op] as const))('%s never reaches callBackendOperation', async (_name, op) => {
    const result = await runBackendOperation(ctx(piloti()), op, { projectId: 'proj_1' })
    expect(callBackendOperation).not.toHaveBeenCalled()
    expect(result.isError).toBe(true)
  })

  it('reads the audience once per request, however many reads it carries', async () => {
    const principal = piloti()
    for (const op of reads.slice(0, 5)) await runOperation(ctx(principal), op.name, {})
    expect(conversationReachOf).toHaveBeenCalledTimes(1)
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

  it('keeps every link-bearing read out even if its domain is ever listed as safe', async () => {
    expect([...AUDIENCE_SAFE_READ_DOMAINS]).toEqual([])
    for (const name of LINK_BEARING_OPERATIONS) {
      expect(AGENT_OPERATIONS.some((op) => op.name === name), `${name} is not in the catalog`).toBe(true)
    }
    expect(await readGateFor(piloti()).mayHandOnLink()).toBe(false)
  })

  it('fails closed when the audience cannot be read', async () => {
    vi.mocked(conversationReachOf).mockRejectedValue(new Error('database down'))
    const result = await runOperation(ctx(piloti()), 'project-list', {})
    expect(result.isError).toBe(true)
    expect(callOperation).not.toHaveBeenCalled()
  })
})

describe('in a conversation that is the requester’s alone', () => {
  beforeEach(() => {
    vi.mocked(conversationReachOf).mockResolvedValue('solo')
  })

  it('records the read once per request, before the first read runs', async () => {
    const principal = piloti()
    await runOperation(ctx(principal), 'project-list', {})
    await runOperation(ctx(principal), 'document-get', { params: { id: 'doc_1' } })
    expect(recordSoloWorkspaceRead).toHaveBeenCalledTimes(1)
    expect(recordSoloWorkspaceRead).toHaveBeenCalledWith(principal)
    expect(vi.mocked(recordSoloWorkspaceRead).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(callOperation).mock.invocationCallOrder[0],
    )
    expect(callOperation).toHaveBeenCalledTimes(2)
  })

  it('asks what each read names, with the call’s own input, before it runs', async () => {
    const principal = piloti()
    const input = { params: { id: 'doc_1' } }
    await runOperation(ctx(principal), 'document-get', input)
    expect(soloReadRefusal).toHaveBeenCalledWith(principal, { path: '/api/documents/[id]' }, input)
  })

  it('runs nothing that names another project, and relays the refusal (the SQL is proven in read-gate.integration.spec.ts)', async () => {
    vi.mocked(soloReadRefusal).mockResolvedValue('That belongs to another project')
    const result = await runOperation(ctx(piloti()), 'document-get', { params: { id: 'doc_1' } })
    expect(result.isError).toBe(true)
    expect(text(result)).toBe('That belongs to another project')
    expect(callOperation).not.toHaveBeenCalled()
  })

  it('runs nothing once the lock finds the conversation shared after all', async () => {
    vi.mocked(recordSoloWorkspaceRead).mockResolvedValue(false)
    const result = await runOperation(ctx(piloti()), 'project-list', {})
    expect(text(result)).toBe(sharedConversationReadRefusal())
    expect(callOperation).not.toHaveBeenCalled()
  })

  it('runs nothing when the record cannot be written', async () => {
    vi.mocked(recordSoloWorkspaceRead).mockRejectedValue(new Error('lock timeout'))
    const result = await runOperation(ctx(piloti()), 'project-list', {})
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
const READS_WITHOUT_PROJECT_CONTENT: Readonly<Record<string, string>> = {
  'inbox-summary-get': 'a count of waiting items, no item',
  'office-shelf-folder-list': 'the office shelf, which belongs to no project',
  'office-shelf-document-list': 'the office shelf, which belongs to no project',
  'office-shelf-document-summary': 'the office shelf, which belongs to no project',
  'office-shelf-document-lookup': 'the office shelf, which belongs to no project',
  'office-shelf-document-name-probe': 'the office shelf, which belongs to no project',
  'office-shelf-document-revision-probe': 'the office shelf, which belongs to no project',
  'office-shelf-document-search': 'the office shelf, which belongs to no project',
  'knowledge-base-get': 'the platform’s base corpus, the same for every organization',
  'organization-member-list': 'the organization’s members, which every member sees',
  'organization-role-list': 'the organization’s roles',
  'organization-memory-list': 'the knowledge shared by every project, which every member reads',
  'organization-storage-get': 'storage totals of the organization',
  'skill-list': 'the organization’s skills',
  'skill-invocable-list': 'the skills the person may invoke',
  'skill-category-list': 'the skill categories',
}

describe('every read of no named place either spans projects or carries no project’s content', () => {
  const namesSomething = (op: AgentOperation): boolean => {
    if (/\[[^\]]+\]/.test(op.path)) return true
    const shapes = [op.query, op.body].filter((schema): schema is z.ZodObject<z.ZodRawShape> => schema instanceof z.ZodObject)
    return shapes.some((schema) =>
      Object.entries(schema.shape).some(([key, field]) => (key in KEY_TARGETS || key === 'resourceId' || key === 'entityId') && !(field as z.ZodTypeAny).isOptional()),
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
    vi.mocked(conversationReachOf).mockResolvedValue('none')
    const person: AgentPrincipal = { actor: 'external_agent', session, clientId: 'c', scopes: [] }
    const result = await runOperation(ctx(person), 'project-list', {})
    expect(result.isError).toBeUndefined()
    expect(recordSoloWorkspaceRead).not.toHaveBeenCalled()
    expect(callOperation).toHaveBeenCalledTimes(1)
  })
})
