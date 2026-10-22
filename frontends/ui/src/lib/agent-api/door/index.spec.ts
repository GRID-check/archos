/**
 * @vitest-environment node
 */
/**
 * The door's resources and prompts through the real SDK, for an outside agent
 * and for Piloti's own client.
 */
import { webcrypto } from 'node:crypto'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { beforeAll, describe, expect, it } from 'vitest'
import { BACKEND_OPERATIONS } from '../backend-operations'
import { AGENT_OPERATIONS } from '../catalog'
import { isExposedTo } from '../exposure'
import { buildMcpServer } from '../mcp-server'
import type { AgentPrincipal } from '../principal'
import { DOOR_DOCS } from './docs.generated'
import { CATALOG_URI, DOOR_PROMPTS, GLOSSARY_URI, GUIDE_URI, placeholdersOf, promptDoc } from './index'

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
const outside: AgentPrincipal = { actor: 'external_agent', clientId: 'c', scopes: [], session }
const piloti: AgentPrincipal = { actor: 'piloti', clientId: null, scopes: [], session }

beforeAll(() => {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
})

async function rpc(principal: AgentPrincipal, method: string, params: Record<string, unknown> = {}) {
  const handler = createMcpHandler(() => buildMcpServer(principal, 'search'), { responseMode: 'json' })
  const response = await handler.fetch(
    new Request('https://app.piloti.test/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
  )
  const raw = await response.text()
  const data = raw.split('\n').find((line) => line.startsWith('data:'))
  return JSON.parse(data ? data.slice(5) : raw) as { result?: Record<string, unknown>; error?: { message: string } }
}

describe('resources for an outside agent', () => {
  it('lists the guide, the glossary and the catalog', async () => {
    const { result } = await rpc(outside, 'resources/list')
    const uris = (result?.resources as { uri: string }[]).map((resource) => resource.uri)
    expect(uris).toEqual(expect.arrayContaining([GUIDE_URI, GLOSSARY_URI, CATALOG_URI]))
  })

  it('reads the guide as its Markdown file says it', async () => {
    const { result } = await rpc(outside, 'resources/read', { uri: GUIDE_URI })
    expect((result?.contents as { text: string }[])[0].text).toBe(DOOR_DOCS['guide.md'])
  })

  it('lists in the catalog what this caller may run, and nothing it may not', async () => {
    const { result } = await rpc(outside, 'resources/read', { uri: CATALOG_URI })
    const text = (result?.contents as { text: string }[])[0].text
    expect(text).toContain('`project-list` (read)')
    const withheld = AGENT_OPERATIONS.find((op) => !isExposedTo('external', op.name))
    if (withheld) expect(text).not.toContain(`\`${withheld.name}\``)
  })

  it('maps the office’s German words in the glossary', async () => {
    const { result } = await rpc(outside, 'resources/read', { uri: GLOSSARY_URI })
    expect((result?.contents as { text: string }[])[0].text).toMatch(/^- fassung: version/m)
  })
})

describe('prompts for an outside agent', () => {
  it('offers the workflows and the office skills', async () => {
    const { result } = await rpc(outside, 'prompts/list')
    const names = (result?.prompts as { name: string }[]).map((prompt) => prompt.name)
    expect(names).toEqual(expect.arrayContaining([...DOOR_PROMPTS.map((prompt) => prompt.name), 'office-skill']))
  })

  it('fills a prompt’s Markdown with its arguments', async () => {
    const { result } = await rpc(outside, 'prompts/get', { name: 'project-briefing', arguments: { project: 'Haus Josef' } })
    const text = (result?.messages as { content: { text: string } }[])[0].content.text
    expect(text).toContain('"Haus Josef"')
    expect(text).not.toContain('{{')
  })
})

describe('the door docs', () => {
  it('has a Markdown file for every prompt, asking for exactly its arguments', () => {
    for (const prompt of DOOR_PROMPTS) {
      expect(placeholdersOf(promptDoc(prompt.name)).sort()).toEqual(Object.keys(prompt.args).sort())
    }
  })

  it('names only operations an outside agent is offered (ADR-0131, rule 8)', () => {
    const names = new Set([...AGENT_OPERATIONS, ...BACKEND_OPERATIONS].map((op) => op.name))
    for (const [doc, text] of Object.entries(DOOR_DOCS)) {
      for (const [, name] of text.matchAll(/`([a-z][a-z0-9]*(?:-[a-z0-9]+)+)`/g)) {
        if (names.has(name)) expect({ doc, name, offered: isExposedTo('external', name) }).toEqual({ doc, name, offered: true })
      }
    }
  })
})

describe('Piloti’s own client', () => {
  it('gets neither resources nor prompts: it reads neither, and the guide names its native tools', async () => {
    expect((await rpc(piloti, 'resources/list')).error).toBeDefined()
    expect((await rpc(piloti, 'prompts/list')).error).toBeDefined()
  })
})
