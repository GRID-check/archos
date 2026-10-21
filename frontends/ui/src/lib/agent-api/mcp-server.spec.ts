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
import { beforeAll, describe, expect, it } from 'vitest'
import { AGENT_OPERATIONS } from './catalog'
import { MCP_INSTRUCTIONS, buildMcpServer, resolveMode } from './mcp-server'
import { BACKEND_OPERATIONS } from './backend-operations'
import { visibleBackendOperations, visibleOperations } from './policy'
import type { AgentPrincipal } from './principal'

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

type ListedTool = { name: string; inputSchema: unknown; annotations?: Record<string, unknown> }

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
      expect(tool?.annotations).toMatchObject({
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: op.name === 'law-lookup',
      })
    }
  })

  it('never reuse a catalog name', () => {
    const catalog = new Set(AGENT_OPERATIONS.map((op) => op.name))
    for (const op of BACKEND_OPERATIONS) expect(catalog.has(op.name)).toBe(false)
  })
})

describe('search mode', () => {
  it('stays four tools however large the catalog grows', async () => {
    expect((await listTools('search')).map((tool) => tool.name)).toEqual([
      'search-operations',
      'describe-operation',
      'call-operation',
      'report-missing-operation',
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
