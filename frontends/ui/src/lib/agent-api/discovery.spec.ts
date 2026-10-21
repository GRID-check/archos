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
vi.mock('./dispatch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./dispatch')>()),
  callOperation: vi.fn(),
}))
vi.mock('./operation-proposals', () => ({ proposeOperation: vi.fn() }))
vi.mock('./telemetry', () => ({ recordOperationCalled: vi.fn(), recordCapabilityMissing: vi.fn() }))

import { callOperation, parseOperationInput } from './dispatch'
import {
  MAX_RESULT_CHARS,
  callOperationTool,
  describeOperation,
  reportMissingCapability,
  searchOperations,
} from './discovery'
import { proposeOperation } from './operation-proposals'
import type { AgentPrincipal } from './principal'
import { recordCapabilityMissing, recordOperationCalled } from './telemetry'

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
const person: AgentPrincipal = { kind: 'person', session, clientId: 'c', scopes: [] }
const piloti: AgentPrincipal = { kind: 'piloti', session, clientId: null, scopes: [] }
const ctx = (principal: AgentPrincipal) => ({ principal, mode: 'discovery' as const })

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
    // "folder" is in folder-access-grant's name only for a sensitive op the person cannot see;
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
    expect(names(searchOperations(ctx(person), { query: 'folder access' }))).not.toContain('folder-access-grant')
  })

  it('says what to do when nothing matches', () => {
    const result = searchOperations(ctx(person), { query: 'zzz-nothing' })
    expect(structured(result).total).toBe(0)
    expect(structured(result).next).toMatch(/report-missing-capability/)
  })

  it('respects the limit', () => {
    expect(names(searchOperations(ctx(person), { query: '', limit: 2 }))).toHaveLength(2)
  })
})

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
    expect(describeOperation(ctx(person), { name: 'folder-access-grant' }).isError).toBe(true)
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

  it('teaches when the input does not fit the schema', async () => {
    // The real dispatcher validates before it calls the route; keep that step.
    vi.mocked(callOperation).mockImplementation(async (op, input) => {
      parseOperationInput(op, input)
      return { status: 200, ok: true, body: {} }
    })
    const result = await callOperationTool(ctx(person), {
      name: 'project-member-add',
      input: { params: { id: 'p1' }, body: { userId: 'u2', role: 'owner' } },
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/body\.role/)
    expect(text(result)).toMatch(/describe-operation/)
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
    expect(structured(result)).toMatchObject({ proposed: true, applied: false, proposalId: 'prop_1' })
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
    const result = await callOperationTool(ctx(person), { name: 'folder-access-grant', input: { params: { id: 'f' }, body: { role: 'x' } } })
    expect(result.isError).toBe(true)
    expect(callOperation).not.toHaveBeenCalled()
    expect(recordOperationCalled).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ decision: 'refused', status: 404 }),
    )
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

describe('report-missing-capability', () => {
  it('answers recorded and sends only the length of the description', () => {
    const description = 'Export the Bauakt as a ZIP for Anna Muster'
    const result = reportMissingCapability(ctx(person), { description })
    expect(structured(result)).toEqual({ status: 'recorded' })
    expect(recordCapabilityMissing).toHaveBeenCalledWith(expect.anything(), description.length)
  })

  it('refuses an empty description', () => {
    expect(reportMissingCapability(ctx(person), { description: '' }).isError).toBe(true)
  })
})
