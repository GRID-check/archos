/**
 * @vitest-environment node
 */
/**
 * Output schemas and icons, through the real SDK: the three meta-tools declare
 * what they answer and always answer it; the icons are on the server, the
 * meta-tools, the prompts and the resources, and `tools` mode stays in budget.
 */

import { webcrypto } from 'node:crypto'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { fromJsonSchema } from '@modelcontextprotocol/server'
import { MAX_RESULT_CHARS } from './discovery'
import { buildMcpServer, createAgentDoorHandler } from './mcp-server'
import { META_OUTPUT_SCHEMAS } from './meta-output-schemas'
import { visibleBackendOperations, visibleOperations } from './policy'
import type { AgentPrincipal } from './principal'

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
const principal: AgentPrincipal = { actor: 'external_agent', clientId: 'c', scopes: ['piloti:sensitive'], session }

beforeAll(() => {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
})
afterEach(() => vi.unstubAllEnvs())

type Rpc = {
  result?: {
    tools?: { name: string; icons?: { src: string; theme?: string }[]; outputSchema?: { type: string } }[]
    prompts?: { icons: { theme?: string }[] }[]
    resources?: { icons: { theme?: string }[] }[]
    serverInfo?: unknown
    isError?: boolean
    content?: { text: string }[]
    structuredContent?: unknown
  }
  error?: { message: string }
}

async function rpc(method: string, params: Record<string, unknown> = {}, mode: 'search' | 'tools' = 'search'): Promise<Rpc> {
  const handler = createMcpHandler(() => buildMcpServer(principal, mode), { responseMode: 'json' })
  const response = await handler.fetch(
    new Request('https://app.piloti.test/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
  )
  const raw = await response.text()
  const data = raw.split('\n').find((line) => line.startsWith('data:'))
  return JSON.parse(data ? data.slice(5) : raw) as Rpc
}

const call = (name: string, args: Record<string, unknown>) => rpc('tools/call', { name, arguments: args })

describe('output schemas of the meta-tools', () => {
  it('declares them on search, describe and report, and not on call-operation', async () => {
    const tools = ((await rpc('tools/list')).result?.tools ?? []) as { name: string; outputSchema?: { type: string } }[]
    const declared = Object.fromEntries(tools.map((tool) => [tool.name, tool.outputSchema?.type]))
    expect(declared).toEqual({
      'search-operations': 'object',
      'describe-operation': 'object',
      'call-operation': undefined,
      'report-missing-operation': 'object',
    })
  })

  it('answers a search with structuredContent that validates', async () => {
    const { result } = await call('search-operations', { query: 'project' })
    expect(result?.isError).toBeFalsy()
    const structured = result?.structuredContent as { total: number; operations: { name: string }[]; next: string }
    expect(structured.operations.length).toBeGreaterThan(0)
    const check = await fromJsonSchema(META_OUTPUT_SCHEMAS['search-operations'] as never)['~standard'].validate(structured)
    expect('issues' in check && check.issues).toBeFalsy()
  })

  it('answers an empty search with the same shape', async () => {
    const { result } = await call('search-operations', { query: 'zzzzqqqq' })
    expect(result?.isError).toBeFalsy()
    expect(result?.structuredContent).toMatchObject({ total: 0, operations: [] })
  })

  it('answers a describe, for a catalog operation and an agent read tool, and a report', async () => {
    for (const name of ['project-list', 'knowledge-search']) {
      const { result } = await call('describe-operation', { name })
      expect(result?.isError).toBeFalsy()
      expect(result?.structuredContent).toMatchObject({ name, sensitivity: null })
    }
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', '')
    const { result } = await call('report-missing-operation', { description: 'Plot a drawing.' })
    expect(result?.structuredContent).toEqual({ status: 'recorded' })
  })

  it('never reaches the cap that drops structuredContent', async () => {
    const hits = (await call('search-operations', { query: '', limit: 50 })).result?.content as { text: string }[]
    expect(hits[0].text.length).toBeLessThan(MAX_RESULT_CHARS / 2)
    const names = [...visibleOperations(principal), ...visibleBackendOperations(principal)].map((op) => op.name)
    let largest = 0
    for (const name of names) {
      const { result } = await call('describe-operation', { name })
      expect(result?.isError, name).toBeFalsy()
      expect(result?.structuredContent, name).toBeDefined()
      largest = Math.max(largest, (result?.content as { text: string }[])[0].text.length)
    }
    expect(largest).toBeLessThan(MAX_RESULT_CHARS / 2)
  })
})

describe('icons', () => {
  const THEMES = (icons: { theme?: string }[]) => icons.map((icon) => icon.theme).sort()

  it('shows the server its title, icons and, with a pinned origin, its website, on initialize', async () => {
    vi.stubEnv('WORKOS_REDIRECT_URI', 'https://app.piloti.test/callback')
    const handler = createAgentDoorHandler(() => undefined)
    const response = await handler.fetch(
      new Request('https://app.piloti.test/api/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'mcp-protocol-version': '2025-11-25' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } },
        }),
      }),
      { authInfo: { token: '', clientId: 'c', scopes: [], extra: { principal, mode: 'search' } } },
    )
    const info = ((await response.json()) as Rpc).result?.serverInfo as { title: string; websiteUrl?: string; icons: { src: string; theme: string }[] }
    expect(info.title).toBe('Piloti')
    expect(info.websiteUrl).toBe('https://app.piloti.test')
    expect(THEMES(info.icons)).toEqual(['dark', 'light'])
    expect(info.icons[0].src).toMatch(/^data:image\/svg\+xml,/)
  })

  it('puts one icon per meaning on the meta-tools, the prompts and the resources', async () => {
    const tools = (await rpc('tools/list')).result?.tools as { icons: { src: string; theme?: string }[] }[]
    expect(new Set(tools.map((tool) => tool.icons[0].src)).size).toBe(4)
    const prompts = (await rpc('prompts/list')).result?.prompts as { icons: { src: string; theme?: string }[] }[]
    expect(prompts.length).toBeGreaterThan(0)
    for (const prompt of prompts) expect(THEMES(prompt.icons)).toEqual(['dark', 'light'])
    const resources = (await rpc('resources/list')).result?.resources as { icons: { src: string; theme?: string }[] }[]
    expect(resources.length).toBeGreaterThanOrEqual(3)
    for (const resource of resources) expect(THEMES(resource.icons)).toEqual(['dark', 'light'])
  })

  it('keeps tools mode free of per-operation icons and output schemas: its budget is spent', async () => {
    const tools = (await rpc('tools/list', {}, 'tools')).result?.tools as { name: string; icons?: unknown[]; outputSchema?: unknown }[]
    expect(tools.filter((tool) => tool.icons || tool.outputSchema)).toEqual([])
  })

  it('measures what the icons and schemas add to a search-mode tools/list', async () => {
    const tools = (await rpc('tools/list')).result?.tools as { icons?: unknown; outputSchema?: unknown }[]
    const bare = tools.map(({ icons: _i, outputSchema: _o, ...rest }) => rest)
    const added = JSON.stringify(tools).length - JSON.stringify(bare).length
    expect(added).toBeLessThan(5_000)
  })
})
