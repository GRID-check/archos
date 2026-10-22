/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./catalog', async () => {
  const { FAKE_OPERATIONS } = await import('./test-operations')
  return {
    AGENT_OPERATIONS: FAKE_OPERATIONS,
    findOperation: (name: string) => FAKE_OPERATIONS.find((op) => op.name === name),
  }
})
vi.mock('./exposure.config', async (importOriginal) =>
  (await import('./test-operations')).withFakeExposure(await importOriginal<typeof import('./exposure.config')>()),
)
vi.mock('./dispatch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./dispatch')>()),
  callOperation: vi.fn(),
}))
vi.mock('./backend-operations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./backend-operations')>()),
  callBackendOperation: vi.fn(),
}))
vi.mock('./operation-proposals', () => ({ proposeOperation: vi.fn() }))
vi.mock('./telemetry', () => ({ recordOperationCalled: vi.fn(), recordOperationMissing: vi.fn() }))

import { callBackendOperation } from './backend-operations'
import { callOperation, validateOperationInput } from './dispatch'
import {
  MAX_RESULT_CHARS,
  MAX_SEARCH_QUERY_LENGTH,
  SENSITIVE_MATCH_NOTE,
  callOperationTool,
  describeOperation,
  inputSchemaOf,
  metaToolsFor,
  nativeToolRefusal,
  reportMissingOperation,
  searchOperations,
} from './discovery'
import type { AgentOperation } from './operation'
import { proposeOperation } from './operation-proposals'
import type { AgentPrincipal } from './principal'
import { recordOperationCalled, recordOperationMissing } from './telemetry'

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
const person: AgentPrincipal = { actor: 'external_agent', session, clientId: 'c', scopes: [] }
const piloti: AgentPrincipal = { actor: 'piloti', session, clientId: null, scopes: [] }
const ctx = (principal: AgentPrincipal) => ({ principal, mode: 'search' as const })

interface Structured extends Record<string, unknown> {
  operations: { name: string }[]
  total: number
  next: string
  inputSchema: unknown
}

function structured(result: { structuredContent?: unknown }): Structured {
  return result.structuredContent as Structured
}

function text(result: { content: unknown[] }): string {
  return (result.content[0] as { text: string }).text
}

beforeEach(() => {
  vi.mocked(callOperation).mockResolvedValue({ status: 200, ok: true, body: { projects: [] } })
  vi.mocked(proposeOperation).mockResolvedValue({ proposalId: 'prop_1', summary: 'Add Anna to Haus A' })
})

describe('search-operations', () => {
  const names = (result: { structuredContent?: unknown }) =>
    structured(result).operations.map((op) => op.name)

  it('ranks the operation that answers every word first', () => {
    const result = searchOperations(ctx(person), { query: 'add member project' })
    expect(names(result)[0]).toBe('project-member-add')
  })

  it('weighs the name above the summary above the description', () => {
    // "folder" is in project-folder-access-set's name only for a sensitive op the person cannot see;
    // "delete" is in project-delete's name and nowhere else's name.
    const result = searchOperations(ctx(person), { query: 'delete' })
    expect(names(result)[0]).toBe('project-delete')
  })

  it('never compiles the caller’s text as a regular expression (ReDoS)', () => {
    // A catastrophic pattern is just words here: it must return promptly, and
    // its letters still find the operations they name.
    const result = searchOperations(ctx(person), { query: '^(a+)+$ project-(list|delete)' })
    expect(names(result)).toEqual(expect.arrayContaining(['project-delete', 'project-list']))
  })

  it('narrows by domain and lists a whole domain for an empty query', () => {
    const result = searchOperations(ctx(person), { query: '', domain: 'documents' })
    expect(names(result)).toEqual(['document-search'])
  })

  it('carries the annotations a client needs to choose', () => {
    const result = searchOperations(ctx(person), { query: 'project delete' })
    const hit = structured(result).operations.find((op) => op.name === 'project-delete')
    expect(hit).toMatchObject({ domain: 'projects', readOnly: false, destructive: true })
  })

  it('does not offer an operation the principal may not see', () => {
    expect(names(searchOperations(ctx(person), { query: 'folder access' }))).not.toContain('project-folder-access-set')
  })

  it('says a hidden operation would have answered, without naming it, when it outranks every hit', () => {
    const result = searchOperations(ctx(piloti), { query: 'widen folder access' })
    expect(names(result)).not.toContain('project-folder-access-set')
    expect(structured(result).next).toMatch(/^An operation that changes who may do what/)
    expect(JSON.stringify(result)).not.toContain('project-folder-access-set')
    // A search the visible operations answer best carries no such note.
    expect(structured(searchOperations(ctx(piloti), { query: 'list projects' })).next).not.toMatch(/who may do what/)
  })

  it('says what to do when nothing matches', () => {
    const result = searchOperations(ctx(person), { query: 'zzz-qqxv' })
    expect(structured(result).total).toBe(0)
    expect(structured(result).next).toMatch(/report-missing-operation/)
  })

  it('respects the limit', () => {
    expect(names(searchOperations(ctx(person), { query: '', limit: 2 }))).toHaveLength(2)
  })

  it('ignores one-letter words, which match nearly every operation and rank nothing', () => {
    // `(a+)+$` used to match all 248 operations: its one word, "a", is in nearly every description.
    expect(structured(searchOperations(ctx(person), { query: '(a+)+$' })).total).toBe(0)
    expect(names(searchOperations(ctx(person), { query: 'a project delete' }))[0]).toBe('project-delete')
  })

  it('refuses a query longer than a search', () => {
    const result = searchOperations(ctx(person), { query: 'project '.repeat(MAX_SEARCH_QUERY_LENGTH) })
    expect(result.isError).toBe(true)
  })

  it('never offers the platform domain on the office door, to anyone, and refuses it when named', () => {
    for (const caller of [piloti, person]) {
      const domains = (metaToolsFor(caller)['search-operations'].inputSchema as { properties: { domain: { enum: string[] } } })
        .properties.domain.enum
      expect(domains).not.toContain('platform')
      expect(searchOperations(ctx(caller), { query: '', domain: 'platform' }).isError).toBe(true)
    }
  })

  it('never finds a withheld operation, nor hints at one', () => {
    const found = JSON.parse(text(searchOperations(ctx(person), { query: 'web search', limit: 50 }))) as {
      operations: { name: string }[]
      next: string
    }
    expect(found.operations.map((op) => op.name)).not.toContain('organization-web-search-set')
    expect(found.next).not.toContain(SENSITIVE_MATCH_NOTE)
  })

  it('answers compact JSON: indentation is tokens the agent pays for', () => {
    expect(text(searchOperations(ctx(person), { query: 'project' }))).not.toMatch(/\n\s/)
  })
})

const schemaOf = (name: string) =>
  structured(describeOperation(ctx(person), { name })).inputSchema as { properties: Record<string, unknown> }

describe('describe-operation', () => {
  it('returns the input schema composed from params, query and body', () => {
    const result = describeOperation(ctx(person), { name: 'project-member-add' })
    expect(structured(result)).toMatchObject({
      name: 'project-member-add',
      sensitivity: null,
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        type: 'object',
        required: ['params', 'body'],
        properties: {
          params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
          body: {
            type: 'object',
            properties: { userId: { type: 'string' }, role: { type: 'string', enum: ['viewer', 'editor'] } },
            additionalProperties: false,
          },
        },
      },
    })
  })

  it('has an empty schema for an operation with no input', () => {
    const result = describeOperation(ctx(person), { name: 'project-list' })
    expect(structured(result).inputSchema).toEqual({ type: 'object', properties: {}, additionalProperties: false })
  })

  it('suggests close names for a typo, as an error', () => {
    const result = describeOperation(ctx(person), { name: 'project-lst' })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/Unknown operation/)
  })

  it('treats a hidden operation as unknown', () => {
    expect(describeOperation(ctx(person), { name: 'project-folder-access-set' }).isError).toBe(true)
  })
})

describe('call-operation', () => {
  it('runs the operation as the person through the dispatcher', async () => {
    const result = await callOperationTool(ctx(person), {
      name: 'project-member-add',
      input: { params: { id: 'p1' }, body: { userId: 'u2', role: 'viewer' } },
    })
    expect(callOperation).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'project-member-add' }),
      { params: { id: 'p1' }, body: { userId: 'u2', role: 'viewer' } },
      session,
      'agent',
    )
    expect(result.isError).toBeUndefined()
    expect(structured(result)).toEqual({ projects: [] })
    expect(recordOperationCalled).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ operation: 'project-member-add', domain: 'projects', decision: 'run', status: 200 }),
    )
  })

  it('returns a route refusal as an error with the route\'s own message', async () => {
    vi.mocked(callOperation).mockResolvedValue({
      status: 403,
      ok: false,
      body: { error: 'You need project:members:write', code: 'FORBIDDEN' },
    })
    const result = await callOperationTool(ctx(person), { name: 'project-list' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('You need project:members:write')
    expect(text(result)).toContain('HTTP 403')
  })

  it('teaches when the input does not fit the schema, with the schema itself: one round, not two', async () => {
    // The real dispatcher validates before it calls the route; keep that step.
    vi.mocked(callOperation).mockImplementation(async (op, input) => {
      validateOperationInput(op, input)
      return { status: 200, ok: true, body: {} }
    })
    const result = await callOperationTool(ctx(person), {
      name: 'project-member-add',
      input: { params: { id: 'p1' }, body: { userId: 'u2', role: 'owner' } },
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/body\.role/)
    expect(text(result)).toContain('The input schema of project-member-add: {')
  })

  it('proposes instead of running a write for in-product Piloti', async () => {
    const result = await callOperationTool(ctx(piloti), {
      name: 'project-member-add',
      input: { params: { id: 'p1' }, body: { userId: 'u2', role: 'viewer' } },
    })
    expect(callOperation).not.toHaveBeenCalled()
    expect(proposeOperation).toHaveBeenCalledWith({
      principal: piloti,
      op: expect.objectContaining({ name: 'project-member-add' }),
      input: expect.objectContaining({ params: { id: 'p1' } }),
    })
    // The shape the in-product client reads to put the card in the chat (tools/workspace/register.py).
    expect(structured(result)).toEqual({
      decision: 'propose',
      proposalId: 'prop_1',
      summary: 'Add Anna to Haus A',
      operation: 'project-member-add',
    })
    expect(result.content).toEqual([{ type: 'text', text: 'Proposed — the person decides. Nothing was changed.' }])
    expect(recordOperationCalled).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ decision: 'propose', status: 202 }),
    )
  })

  it('lets Piloti read directly', async () => {
    await callOperationTool(ctx(piloti), { name: 'project-list' })
    expect(callOperation).toHaveBeenCalled()
    expect(proposeOperation).not.toHaveBeenCalled()
  })

  it('refuses a hidden operation as unknown and records the refusal', async () => {
    const result = await callOperationTool(ctx(person), { name: 'project-folder-access-set', input: { params: { id: 'f' }, body: { role: 'x' } } })
    expect(result.isError).toBe(true)
    expect(callOperation).not.toHaveBeenCalled()
    expect(recordOperationCalled).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ decision: 'refused', status: 404 }),
    )
  })

  it('records an unknown name as null: it is the agent\'s own text (L9)', async () => {
    await callOperationTool(ctx(person), { name: 'Anna Huber anrufen', input: {} })
    expect(recordOperationCalled).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ operation: null, domain: null, decision: 'refused', status: 404 }),
    )
    expect(JSON.stringify(vi.mocked(recordOperationCalled).mock.calls)).not.toContain('Anna Huber')
  })

  it('passes ifMatch through call-operation to the dispatcher', async () => {
    await callOperationTool(ctx(person), {
      name: 'project-member-add',
      input: { params: { id: 'p1' }, body: { userId: 'u2', role: 'viewer' }, ifMatch: '"3"' },
    })
    expect(callOperation).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'project-member-add' }),
      expect.objectContaining({ ifMatch: '"3"' }),
      session,
      'agent',
    )
  })

  it('offers ifMatch only on an operation whose route reads the header', () => {
    const write = (extra: Partial<AgentOperation>): AgentOperation => ({
      name: `profile-write-${Object.keys(extra).length}`,
      domain: 'projects',
      summary: 'Write a profile',
      description: 'A write whose route may or may not read If-Match.',
      method: 'PUT',
      path: '/api/projects/[id]/profile',
      load: async () => ({}),
      ...extra,
    })
    expect(inputSchemaOf(write({ ifMatchHeader: true })).properties).toHaveProperty('ifMatch')
    expect(inputSchemaOf(write({})).properties).not.toHaveProperty('ifMatch')
    expect(schemaOf('project-member-add').properties).not.toHaveProperty('ifMatch')
  })

  it('leaves call-operation\'s input untyped, so an agent read tool\'s own arguments get through', () => {
    // knowledge-search takes `query` as a string; a schema typing input.query as an object made the SDK refuse it.
    const input = (metaToolsFor(person)['call-operation'].inputSchema as { properties: { input: Record<string, unknown> } }).properties
      .input
    expect(input).toEqual({ type: 'object', description: expect.any(String) })
  })

  it('refuses an oversized answer and says how to narrow it', async () => {
    vi.mocked(callOperation).mockResolvedValueOnce({
      status: 200,
      ok: true,
      body: { oversized: true, contentType: 'application/json', bytes: 9 * 1024 * 1024 },
    })
    const result = await callOperationTool(ctx(person), { name: 'project-list' })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/was not read\. Narrow the call/)
  })

  it('truncates a large result and says how to page', async () => {
    vi.mocked(callOperation).mockResolvedValue({
      status: 200,
      ok: true,
      body: { rows: 'x'.repeat(MAX_RESULT_CHARS * 2) },
    })
    const result = await callOperationTool(ctx(person), { name: 'project-list' })
    expect(text(result).length).toBeLessThan(MAX_RESULT_CHARS + 500)
    expect(text(result)).toMatch(/Truncated/)
    expect(text(result)).toMatch(/limit or filters/)
    // The full payload must not slip through as structured content.
    expect(result.structuredContent).toBeUndefined()
  })

  it('wraps a non-object body so structuredContent stays an object', async () => {
    vi.mocked(callOperation).mockResolvedValue({ status: 200, ok: true, body: [1, 2] })
    const result = await callOperationTool(ctx(person), { name: 'project-list' })
    expect(structured(result)).toEqual({ result: [1, 2] })
  })
})

describe('call-operation with a file in the answer', () => {
  const base64 = Buffer.from('%PDF-1.7 fake bytes').toString('base64')

  it('returns a binary body as an embedded resource and keeps base64 out of the text', async () => {
    vi.mocked(callOperation).mockResolvedValue({
      status: 200,
      ok: true,
      body: { binary: true, contentType: 'application/pdf; charset=binary', bytes: 19, filename: 'Grundriss EG.pdf', base64 },
    })
    const result = await callOperationTool(ctx(person), { name: 'project-list' })
    expect(result.isError).toBeUndefined()
    expect(result.content).toEqual([
      { type: 'text', text: expect.stringContaining('"Grundriss EG.pdf", application/pdf, 19 bytes') },
      {
        type: 'resource',
        resource: { uri: 'piloti://operation/project-list/Grundriss_EG.pdf', mimeType: 'application/pdf', blob: base64 },
      },
    ])
    expect(text(result)).not.toContain(base64)
    expect(result.structuredContent).toBeUndefined()
  })

  it('names the resource "result" when the route sent no file name', async () => {
    vi.mocked(callOperation).mockResolvedValue({
      status: 200,
      ok: true,
      body: { binary: true, contentType: null, bytes: 3, base64: 'YWJj' },
    })
    const result = await callOperationTool(ctx(person), { name: 'project-list' })
    expect(result.content[1]).toMatchObject({
      resource: { uri: 'piloti://operation/project-list/result', mimeType: 'application/octet-stream' },
    })
  })

  it('says how to read a file that was too large, and sends nothing', async () => {
    vi.mocked(callOperation).mockResolvedValue({
      status: 200,
      ok: true,
      body: { binary: true, contentType: 'application/pdf', bytes: 12 * 1024 * 1024, tooLarge: true },
    })
    const result = await callOperationTool(ctx(person), { name: 'project-list' })
    expect(result.content).toHaveLength(1)
    expect(text(result)).toMatch(/12\.0 MiB/)
    expect(text(result)).toMatch(/5\.0 MiB/)
    expect(text(result)).toMatch(/document-text-get/)
    expect(result.structuredContent).toBeUndefined()
  })

  it('hands a redirect on as a resource link that expires, and does not follow it', async () => {
    vi.mocked(callOperation).mockResolvedValue({
      status: 302,
      ok: true,
      body: { redirect: true, location: 'https://store.test/obj?X-Amz-Signature=abc' },
    })
    const result = await callOperationTool(ctx(person), { name: 'project-list' })
    expect(result.isError).toBeUndefined()
    expect(result.content[1]).toMatchObject({ type: 'resource_link', uri: 'https://store.test/obj?X-Amz-Signature=abc', name: 'project-list' })
    expect(text(result)).toMatch(/expires/)
  })
})

describe('report-missing-operation', () => {
  it('answers recorded and sends only the length of the description', () => {
    const description = 'Export the Bauakt as a ZIP for Anna Muster'
    const result = reportMissingOperation(ctx(person), { description })
    expect(structured(result)).toEqual({ status: 'recorded' })
    expect(recordOperationMissing).toHaveBeenCalledWith(expect.anything(), description.length)
  })

  it('refuses an empty description', () => {
    expect(reportMissingOperation(ctx(person), { description: '' }).isError).toBe(true)
  })
})

describe('the Python agent’s read tools', () => {
  const PROJECT = '0d7b3a5e-7c1c-4a4e-9a63-6a4a1f5f1c11'

  it('are found by search, beside the catalog, with a domain each', () => {
    const result = searchOperations(ctx(person), { query: 'knowledge search' })
    expect(structured(result).operations[0]).toMatchObject({
      name: 'knowledge-search',
      domain: 'knowledge',
      readOnly: true,
      destructive: false,
    })
    expect(structured(searchOperations(ctx(person), { query: '', domain: 'bim' })).operations.map((op) => op.name)).toEqual(
      expect.arrayContaining(['ifc-query', 'ifc-measure']),
    )
  })

  it('are described with the fixture’s input schema and read-only annotations', () => {
    const result = describeOperation(ctx(person), { name: 'knowledge-search' })
    const described = result.structuredContent as { inputSchema: { required: string[] }; annotations: Record<string, unknown> }
    expect(described.inputSchema.required[0]).toBe('projectId')
    expect(described.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true, openWorldHint: false })
  })

  it('are called through callBackendOperation as the person, with the project', async () => {
    vi.mocked(callBackendOperation).mockResolvedValue({ status: 200, ok: true, body: { tool: 'knowledge_search', result: 'a passage' } })
    const result = await callOperationTool(ctx(person), {
      name: 'knowledge-search',
      input: { projectId: PROJECT, query: 'Stellplätze' },
    })
    expect(callBackendOperation).toHaveBeenCalledWith(
      'knowledge-search',
      { projectId: PROJECT, query: 'Stellplätze' },
      session,
      { projectId: PROJECT },
    )
    expect(callOperation).not.toHaveBeenCalled()
    expect(result.structuredContent).toEqual({ result: 'a passage' })
    expect(text(result)).toBe('a passage')
    expect(recordOperationCalled).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ operation: 'knowledge-search', domain: 'knowledge', decision: 'run', status: 200 }),
    )
  })

  it('answer a refusal as an error with the message', async () => {
    vi.mocked(callBackendOperation).mockResolvedValue({
      status: 403,
      ok: false,
      body: { error: 'You cannot use this project', code: 'forbidden' },
    })
    const result = await callOperationTool(ctx(person), { name: 'files-list', input: { projectId: PROJECT } })
    expect(result.isError).toBe(true)
    expect(text(result)).toBe('You cannot use this project (HTTP 403, forbidden)')
  })

  it('are absent for in-product Piloti, which has them natively', async () => {
    expect(structured(searchOperations(ctx(piloti), { query: 'knowledge search' })).operations.map((op) => op.name)).not.toContain(
      'knowledge-search',
    )
    expect(describeOperation(ctx(piloti), { name: 'knowledge-search' }).isError).toBe(true)
    // Flat, as its native tool takes it: `query` a string, where call-operation's input wants an object.
    const result = await callOperationTool(ctx(piloti), { name: 'knowledge-search', input: { query: 'Stellplatz', projectId: PROJECT } })
    expect(result.isError).toBe(true)
    // Hidden from Piloti because it is Piloti's own tool (`native:knowledge_search`): it is sent to that tool,
    // not told how to shape an input it cannot use.
    expect((result.content[0] as { text: string }).text).toBe(nativeToolRefusal('knowledge-search', 'knowledge_search'))
    expect(callBackendOperation).not.toHaveBeenCalled()
  })
})
