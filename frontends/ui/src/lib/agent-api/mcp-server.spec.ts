/**
 * @vitest-environment node
 */
/**
 * The real catalog through the real SDK: every operation must survive being
 * published as an MCP tool (its input schema compiles, its name is accepted),
 * or `tools` mode would fail for a client the day somebody adds an operation
 * whose schema the validator rejects.
 */

import { webcrypto } from 'node:crypto'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { AGENT_OPERATIONS } from './catalog'
import { MCP_INSTRUCTIONS, buildMcpServer, createAgentDoorHandler, resolveMode } from './mcp-server'
import { BACKEND_OPERATIONS } from './backend-operations'
import { visibleBackendOperations, visibleOperations } from './policy'
import type { AgentPrincipal } from './principal'
import { APP_TOOLS } from './catalog/app-views'

const principal: AgentPrincipal = {
  actor: 'external_agent',
  clientId: 'c',
  scopes: ['piloti:sensitive'],
  session: {
    userId: 'user_1',
    email: 'a@piloti.test',
    name: null,
    accessToken: '',
    organizationId: 'org_1',
    organizationMembershipId: 'om_1',
    role: 'admin',
    permissions: [],
    featureFlags: null,
  },
}

beforeAll(() => {
  // The shared setup file swaps `crypto` for a stub with no randomUUID.
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
})

type ListedTool = { name: string; inputSchema: unknown; annotations?: Record<string, unknown>; _meta?: Record<string, unknown> }

/** A 2025-11-25 request without `initialize`, as Piloti's own client sends it (`tools/workspace/client.py`). */
function legacyRequest(body: unknown, accept: string, mode: 'search' | 'tools' = 'search'): Request {
  return new Request('https://app.piloti.test/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept, 'mcp-protocol-version': '2025-11-25', 'x-piloti-mcp-mode': mode },
    body: JSON.stringify(body),
  })
}

const authInfoFor = (mode: 'search' | 'tools') => ({ token: '', clientId: 'c', scopes: [], extra: { principal, mode } })

afterEach(() => {
  vi.unstubAllEnvs()
})

async function listTools(mode: 'search' | 'tools'): Promise<ListedTool[]> {
  const handler = createMcpHandler(() => buildMcpServer(principal, mode), { responseMode: 'json' })
  const response = await handler.fetch(
    new Request('https://app.piloti.test/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    }),
  )
  const raw = await response.text()
  const data = raw.split('\n').find((line) => line.startsWith('data:'))
  return (JSON.parse(data ? data.slice(5) : raw) as { result: { tools: ListedTool[] } }).result.tools
}

describe('tools mode over the real catalog', () => {
  it('publishes one tool per visible operation, plus report-missing-operation', async () => {
    const tools = await listTools('tools')
    const names = tools.map((tool) => tool.name)
    expect(names).toEqual([
      ...visibleOperations(principal).map((op) => op.name),
      ...visibleBackendOperations(principal).map((op) => op.name),
      'report-missing-operation',
      // The proposal card's buttons, app-only (`mcp-apps.ts`): a host keeps them from the model.
      ...APP_TOOLS.map((tool) => tool.name),
    ])
    expect(new Set(names).size).toBe(names.length)
    expect(AGENT_OPERATIONS.length).toBeGreaterThan(0)
  })
})

describe('backend read tools in tools mode', () => {
  it('are listed as reads, open-world only for the law lookup', async () => {
    const tools = await listTools('tools')
    for (const op of BACKEND_OPERATIONS) {
      const tool = tools.find((candidate) => candidate.name === op.name)
      expect(tool?.annotations).toEqual({ readOnlyHint: true, openWorldHint: op.name === 'law-lookup' })
    }
  })

  it('never reuse a catalog name', () => {
    const catalog = new Set(AGENT_OPERATIONS.map((op) => op.name))
    for (const op of BACKEND_OPERATIONS) expect(catalog.has(op.name)).toBe(false)
  })
})

describe('search mode', () => {
  it('stays four meta-tools however large the catalog grows, beside the proposal card’s read and buttons', async () => {
    expect((await listTools('search')).map((tool) => tool.name)).toEqual([
      'search-operations',
      'describe-operation',
      'call-operation',
      'report-missing-operation',
      // The card (ADR-0142): its read, linked to the view, and its two app-only buttons (`mcp-apps.spec.ts`).
      'proposal-get',
      ...APP_TOOLS.map((tool) => tool.name),
    ])
  })
})

describe('mode and instructions', () => {
  const at = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers })

  it('defaults to search and honours the header and the query', () => {
    expect(resolveMode(at('https://x.test/api/mcp'))).toBe('search')
    expect(resolveMode(at('https://x.test/api/mcp?mode=tools'))).toBe('tools')
    expect(resolveMode(at('https://x.test/api/mcp', { 'x-piloti-mcp-mode': 'tools' }))).toBe('tools')
    expect(resolveMode(at('https://x.test/api/mcp?mode=nonsense'))).toBe('search')
    // The mode's name until October 2026, still accepted.
    expect(resolveMode(at('https://x.test/api/mcp', { 'x-piloti-mcp-mode': 'discovery' }))).toBe('search')
  })

  it('introduces Piloti as the architects\' workspace and says where to start', () => {
    expect(MCP_INSTRUCTIONS).toMatch(/workspace for architects/)
    expect(MCP_INSTRUCTIONS).toMatch(/project-list/)
    expect(MCP_INSTRUCTIONS).toMatch(/search-operations/)
    expect(MCP_INSTRUCTIONS).not.toMatch(/compliance/i)
  })
})

describe('the agent door handler', () => {
  const handler = createAgentDoorHandler(() => undefined)
  const toolsList = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }

  it.each(['application/json', 'application/json, text/event-stream', '*/*'])(
    'answers a 2025-era request with one JSON body when the client accepts JSON (Accept: %s)',
    async (accept) => {
      const response = await handler.fetch(legacyRequest(toolsList, accept), { authInfo: authInfoFor('search') })
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toMatch(/^application\/json/)
      const message = (await response.json()) as { result: { tools: { name: string }[] } }
      expect(message.result.tools.map((tool) => tool.name)).toContain('call-operation')
    },
  )

  it('lets call-operation reach an agent read tool whose own `query` is a string', async () => {
    // input.query used to be typed as an object, so the SDK refused knowledge-search before the handler ran:
    // "data/input/query must be object".
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', '')
    const call = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'call-operation',
        arguments: { name: 'knowledge-search', input: { projectId: '0d7b3a5e-7c1c-4a4e-9a63-6a4a1f5f1c11', query: 'Stellplätze Wien' } },
      },
    }
    const response = await handler.fetch(legacyRequest(call, 'application/json'), { authInfo: authInfoFor('search') })
    const message = (await response.json()) as { result: { isError?: boolean; content: { text: string }[] } }
    const said = message.result.content[0]?.text ?? ''
    expect(said).not.toMatch(/must be object/)
    // It reached callBackendOperation, which (no internal token here) refuses to sign: the call got past validation.
    expect(said).toMatch(/cannot sign a request to the backend.*HTTP 503, backend_not_configured/)
  })
})

describe('what a client loads up front', () => {
  it('marks the entry points to load although a Claude client defers MCP tools', async () => {
    const meta = ['search-operations', 'describe-operation', 'call-operation', 'report-missing-operation']
    for (const tool of (await listTools('search')).filter((listed) => meta.includes(listed.name))) {
      expect(tool._meta).toEqual({ 'anthropic/alwaysLoad': true })
    }
    const loaded = (await listTools('tools')).filter((tool) => tool._meta?.['anthropic/alwaysLoad']).map((tool) => tool.name)
    expect(loaded.sort()).toEqual(['files-list', 'knowledge-search', 'project-list'])
  })

  it('states each hint where it says something, and never the title twice', async () => {
    const tools = await listTools('tools')
    for (const tool of tools) {
      expect(tool.annotations).not.toHaveProperty('title')
      // openWorldHint defaults to true; every operation reaches a closed workspace except the law lookup.
      expect(tool.annotations?.openWorldHint).toBe(tool.name === 'law-lookup')
      // destructiveHint defaults to true: a write that does not destroy must say so.
      if (!tool.annotations?.readOnlyHint) expect(typeof tool.annotations?.destructiveHint).toBe('boolean')
    }
    const byName = (name: string) => tools.find((tool) => tool.name === name)?.annotations
    expect(byName('project-list')).toEqual({ readOnlyHint: true, openWorldHint: false })
    expect(byName('project-delete')).toEqual({ destructiveHint: true, idempotentHint: true, openWorldHint: false })
  })
})

describe('what tools mode costs a client', () => {
  // Measured October 2026 (chars of the tools/list result, about four per token): 1,141 per tool before the
  // fix wave (ifMatch on every write, `additionalProperties: true` everywhere, every hint and the title twice),
  // 922 after. A ratchet: an operation that needs more says so in its description, not in schema ballast.
  const MAX_AVERAGE_CHARS = 1_000
  const MAX_OPERATION_CHARS = 9_000

  it(`stays under ${MAX_AVERAGE_CHARS} characters a tool on average, and ${MAX_OPERATION_CHARS} for any catalog operation`, async () => {
    const tools = await listTools('tools')
    const sizes = tools.map((tool) => [tool.name, JSON.stringify(tool).length] as const)
    const total = sizes.reduce((sum, [, size]) => sum + size, 0)
    expect(total / tools.length).toBeLessThan(MAX_AVERAGE_CHARS)
    const backend = new Set(BACKEND_OPERATIONS.map((op) => op.name))
    // The backend read tools carry the Python tools' own schemas (`backend-tools.schema.json`), sized there.
    expect(sizes.filter(([name, size]) => !backend.has(name) && size > MAX_OPERATION_CHARS)).toEqual([])
  })
})
