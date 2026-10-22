/**
 * @vitest-environment node
 */
/**
 * The agent's read tools over MCP (ADR-0122): the operations are the contract
 * the Python tools generate, and a call is the person's own chat turn context,
 * signed by this tier and sent to the backend with the internal token.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthorizedSession } from '@/lib/auth/types'
import { NotFoundError } from '@/lib/api/errors'
import { verifyGridRequestContextEnvelope } from '@/lib/request-context'
import { AGENT_OPERATIONS } from './catalog'
import {
  backendRefusal,
  BACKEND_OPERATIONS,
  callBackendOperation,
  findBackendOperation,
  toMcpContent,
} from './backend-operations'
import { MAX_TEXT_BYTES } from './dispatch'

const requireProjectAccess = vi.hoisted(() => vi.fn())
const resolveTurnContext = vi.hoisted(() => vi.fn())

vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess }))
vi.mock('@/lib/turns/turn-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/turns/turn-context')>()),
  resolveTurnContext,
}))

const SECRET = 'a-shared-secret' // pragma: allowlist secret
const PROJECT = '0d7b3a5e-7c1c-4a4e-9a63-6a4a1f5f1c11'

const session = {
  userId: 'user_1',
  email: 'a@example.test',
  name: 'Ada',
  accessToken: 'token-never-forwarded',
  organizationId: 'org_1',
  organizationMembershipId: 'om_1',
  role: 'member',
  permissions: [],
  featureFlags: null,
} satisfies AuthorizedSession

const fetchMock = vi.fn()

function backendAnswers(status: number, body: unknown): void {
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  )
}

beforeEach(() => {
  vi.stubEnv('GRID_INTERNAL_API_TOKEN', SECRET)
  vi.stubEnv('BACKEND_URL', 'http://aiq-api:8000')
  vi.stubGlobal('fetch', fetchMock)
  requireProjectAccess.mockResolvedValue({
    role: 'project-viewer',
    closed: false,
    readsBecauseClosed: false,
  })
  resolveTurnContext.mockResolvedValue({
    scope: ['proj_x'],
    scopedCollections: [{ collection: 'proj_x', shelf: 'project' }],
    header: 'ignored',
    organizationId: 'org_1',
    userId: 'user_1',
    accessToken: 'token-never-forwarded',
    projectId: PROJECT,
    memoryReflectionEnabled: false,
  })
  backendAnswers(200, { tool: 'knowledge_search', result: 'passage' })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('the operations', () => {
  it('are the seven read tools, named like the catalog and unique across it', () => {
    expect(BACKEND_OPERATIONS.map((op) => op.name)).toEqual([
      'knowledge-search',
      'passage-read',
      'files-list',
      'document-look',
      'ifc-query',
      'ifc-measure',
      'law-lookup',
    ])
    const catalogNames = new Set(AGENT_OPERATIONS.map((op) => op.name))
    for (const op of BACKEND_OPERATIONS) {
      expect(op.name).toMatch(/^[a-z]+(-[a-z]+)+$/)
      expect(op.name.length).toBeLessThanOrEqual(52)
      expect(catalogNames.has(op.name), `${op.name} is also a catalog operation`).toBe(false)
      expect(['knowledge', 'bim']).toContain(op.domain)
    }
  })

  it('offer every tool the contract lists, and no other', () => {
    const fixture = JSON.parse(
      readFileSync(
        join(
          dirname(fileURLToPath(import.meta.url)),
          '../../../tests/fixtures/backend-tools.schema.json'
        ),
        'utf8'
      )
    ) as { tools: { name: string; description: string; inputSchema: { properties?: Record<string, unknown> } }[] }

    expect(BACKEND_OPERATIONS.map((op) => op.tool)).toEqual(fixture.tools.map((tool) => tool.name))
    for (const tool of fixture.tools) {
      const op = BACKEND_OPERATIONS.find((candidate) => candidate.tool === tool.name)
      // The description is the agent surface's own English one, not Piloti's native tool text
      // (`backend-operations.ts`); the input is the tool's own, property for property.
      expect(op?.description.length).toBeGreaterThan(200)
      expect(op?.description).not.toBe(tool.description)
      const own = Object.keys(op?.inputSchema.properties ?? {}).filter((key) => key !== 'projectId')
      expect(own).toEqual(Object.keys(tool.inputSchema.properties ?? {}))
    }
  })

  it('are all reads, and ask for the project the person works in, except the law lookup', () => {
    for (const op of BACKEND_OPERATIONS) {
      expect(op.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        // Only the law lookup leaves the workspace (it reaches the public RIS).
        openWorldHint: op.name === 'law-lookup',
      })
      const schema = op.inputSchema
      if (op.name === 'law-lookup') {
        expect(op.needsProject).toBe(false)
        expect(schema.properties).not.toHaveProperty('projectId')
      } else {
        expect(op.needsProject).toBe(true)
        expect(Object.keys(schema.properties ?? {})[0]).toBe('projectId')
        // The shared corpus belongs to no project: the search may leave it out with `shelf: "base"`.
        if (op.name === 'knowledge-search') expect(schema.required).not.toContain('projectId')
        else expect(schema.required?.[0]).toBe('projectId')
      }
    }
  })
})

describe('callBackendOperation', () => {
  it('searches the shared corpus without a project, and refuses any other search without one', async () => {
    backendAnswers(200, { tool: 'knowledge_search', result: 'x' })
    const base = await callBackendOperation('knowledge-search', { query: 'OIB 2', shelf: 'base' }, session, {})
    expect(base.status).not.toBe(400)
    const other = await callBackendOperation('knowledge-search', { query: 'OIB 2' }, session, {})
    expect(other).toMatchObject({ status: 400, ok: false })
  })

  it('signs the person’s turn context for the project and posts it with the internal token', async () => {
    const result = await callBackendOperation(
      'knowledge-search',
      { projectId: PROJECT, query: 'Fluchtweg' },
      session,
      {
        projectId: PROJECT,
      }
    )

    expect(result).toEqual({
      status: 200,
      ok: true,
      body: { tool: 'knowledge_search', result: 'passage' },
    })
    expect(resolveTurnContext).toHaveBeenCalledWith(session, { projectId: PROJECT })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://aiq-api:8000/v1/internal/tools/knowledge_search')
    const headers = init.headers as Record<string, string>
    expect(headers['x-grid-internal-token']).toBe(SECRET)
    const verified = verifyGridRequestContextEnvelope(
      headers['x-grid-request-context'],
      headers['x-grid-request-context-sig'],
      SECRET
    )
    expect(verified).toMatchObject({
      organizationId: 'org_1',
      userId: 'user_1',
      projectId: PROJECT,
      collectionScope: ['proj_x'],
    })
    expect(Object.keys(headers).sort()).toEqual([
      'content-type',
      'x-grid-internal-token',
      'x-grid-request-context',
      'x-grid-request-context-sig',
    ])
  })

  it('sends the tool its arguments without the project, which the envelope carries', async () => {
    await callBackendOperation('passage-read', { projectId: PROJECT, document: 'OIB 2' }, session, {
      projectId: PROJECT,
    })

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({ arguments: { document: 'OIB 2' } })
  })

  it('puts the operations’ names in the tool’s hints and says what a ranked order means', async () => {
    backendAnswers(200, {
      tool: 'knowledge_search',
      result: 'Found 3 relevant document(s):\n\nOpen with `read_passage(document=…, page=…)`.',
    })

    const ranked = await callBackendOperation('knowledge-search', { query: 'x' }, session, {
      projectId: PROJECT,
    })
    const text = (ranked.body as { result: string }).result
    expect(text).toContain('`passage-read` with input {document=…, page=…}')
    expect(text).not.toContain('read_passage')
    expect(text).toContain('final order')

    backendAnswers(200, { tool: 'knowledge_search', result: 'Found 3 relevant document(s):\n' })
    const literal = await callBackendOperation(
      'knowledge-search',
      { query: 'x', match: 'exact' },
      session,
      { projectId: PROJECT }
    )
    expect((literal.body as { result: string }).result).not.toContain('final order')
  })

  it('refuses a project the person may not chat in, before anything is signed or sent', async () => {
    requireProjectAccess.mockRejectedValue(new NotFoundError())

    const result = await callBackendOperation('knowledge-search', { query: 'x' }, session, {
      projectId: PROJECT,
    })

    expect(result.status).toBe(403)
    expect(result.ok).toBe(false)
    expect(requireProjectAccess).toHaveBeenCalledWith(
      session,
      PROJECT,
      expect.arrayContaining(['project:chat'])
    )
    expect(resolveTurnContext).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('asks for a project when the tool needs one, and runs the law lookup without', async () => {
    const missing = await callBackendOperation('ifc-query', {}, session, {})
    expect(missing).toMatchObject({ status: 400, ok: false })
    expect(fetchMock).not.toHaveBeenCalled()

    backendAnswers(200, { tool: 'ris_lookup_tool', result: 'Par. 1' })
    const lookup = await callBackendOperation('law-lookup', { question: 'Par. 1 BO' }, session, {})
    expect(lookup.status).toBe(200)
    expect(requireProjectAccess).not.toHaveBeenCalled()
    expect(resolveTurnContext).toHaveBeenCalledWith(session, { projectId: undefined })
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      'http://aiq-api:8000/v1/internal/tools/ris_lookup_tool'
    )
  })

  it('answers an unknown name without calling anything', async () => {
    const result = await callBackendOperation('file_draft', {}, session, { projectId: PROJECT })

    expect(result).toMatchObject({ status: 404, ok: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('passes the backend’s refusal through with its status, in the routes’ error envelope', async () => {
    const issues = [{ loc: ['top_k'], msg: 'Input should be a valid integer' }]
    backendAnswers(422, { detail: { error: 'invalid_arguments', tool: 'knowledge_search', issues } })

    const result = await callBackendOperation('knowledge-search', { top_k: 'many' }, session, {
      projectId: PROJECT,
    })

    expect(result).toEqual({
      status: 422,
      ok: false,
      body: {
        error: 'The backend refused the call (invalid_arguments)',
        code: 'invalid_arguments',
        details: issues,
      },
    })
  })

  it('normalises every refusal shape the backend has once, here', () => {
    expect(backendRefusal(403, { detail: { error: 'context_envelope_required', detail: 'a signed envelope' } }).body).toEqual({
      error: 'The backend refused the call (context_envelope_required: a signed envelope)',
      code: 'context_envelope_required',
    })
    expect(backendRefusal(500, { detail: 'Internal Server Error' }).body).toEqual({ error: 'Internal Server Error', code: 'http_500' })
    expect(backendRefusal(502, 'Bad Gateway').body).toEqual({ error: 'The backend answered HTTP 502', code: 'http_502' })
  })

  it('reads the backend’s answer no further than a route’s (MAX_TEXT_BYTES)', async () => {
    fetchMock.mockResolvedValue(
      new Response('x', { status: 200, headers: { 'content-type': 'application/json', 'content-length': String(MAX_TEXT_BYTES + 1) } })
    )
    const result = await callBackendOperation('knowledge-search', {}, session, { projectId: PROJECT })
    expect(result.body).toMatchObject({ oversized: true })
  })

  it('does not sign for a backend it cannot safely send the token to, or without the secret', async () => {
    vi.stubEnv('BACKEND_URL', 'http://backend.example.com')
    expect(
      (await callBackendOperation('knowledge-search', {}, session, { projectId: PROJECT })).status
    ).toBe(503)

    vi.stubEnv('BACKEND_URL', 'http://aiq-api:8000')
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', '')
    expect(
      (await callBackendOperation('knowledge-search', {}, session, { projectId: PROJECT })).status
    ).toBe(503)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports a backend that does not answer as 503, and one that is too slow as 504', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))
    expect(
      (await callBackendOperation('knowledge-search', {}, session, { projectId: PROJECT })).status
    ).toBe(503)

    fetchMock.mockRejectedValue(Object.assign(new Error('timed out'), { name: 'TimeoutError' }))
    expect(
      (await callBackendOperation('knowledge-search', {}, session, { projectId: PROJECT })).status
    ).toBe(504)
  })
})

describe('toMcpContent', () => {
  it('keeps text as text and turns a page image into an image block', () => {
    expect(toMcpContent('Passage')).toEqual([{ type: 'text', text: 'Passage' }])
    expect(
      toMcpContent([
        { type: 'text', text: 'Seite 3' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } },
      ])
    ).toEqual([
      { type: 'text', text: 'Seite 3' },
      { type: 'image', mimeType: 'image/jpeg', data: 'QUJD' },
    ])
  })

  it('finds every operation by name', () => {
    expect(findBackendOperation('ifc-measure')?.tool).toBe('ifc_measure')
    expect(findBackendOperation('nope')).toBeUndefined()
  })
})
