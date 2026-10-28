/**
 * @vitest-environment node
 */
/**
 * The door's resources and prompts through the real SDK, for an outside agent
 * and for Piloti's own client.
 */
import { webcrypto } from 'node:crypto'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { BACKEND_OPERATIONS } from '../backend-operations'
import { AGENT_OPERATIONS } from '../catalog'
import { isExposedTo } from '../exposure'
import { buildMcpServer } from '../mcp-server'
import type { AgentPrincipal } from '../principal'
import { DOOR_DOCS } from './docs.generated'
import * as discovery from '../discovery'
import { CATALOG_URI, DOOR_PROMPTS, GLOSSARY_URI, GUIDE_URI, PROJECT_URI_TEMPLATE, placeholdersOf, promptDoc } from './index'

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

const PROJECTS = [
  { id: 'p-1', name: 'Wohnhaus Kellermanngasse', projectName: 'Haus Josef', status: 'active', siteAddress: 'Kellermanngasse 8' },
  { id: 'p-2', name: 'Schulbau', projectName: null, status: 'active', siteAddress: null },
]

describe('completions and the project resource, through the real SDK', () => {
  it('completes a prompt’s project from the projects the person may open, by the name people use', async () => {
    const read = vi.spyOn(discovery, 'readOperationBody').mockImplementation(async (_ctx, _name, input) => {
      const wanted = String((input.query as { nameContains?: string } | undefined)?.nameContains ?? '').toLowerCase()
      return { body: PROJECTS.filter((p) => [p.name, p.projectName].some((n) => n?.toLowerCase().includes(wanted))) }
    })
    const { result } = await rpc(outside, 'completion/complete', {
      ref: { type: 'ref/prompt', name: 'project-briefing' },
      argument: { name: 'project', value: 'jos' },
    })
    expect((result?.completion as { values: string[] }).values).toEqual(['Haus Josef'])
    read.mockRestore()
  })

  it('loads an office skill with skill-get and completes its name from skill-search', async () => {
    const read = vi.spyOn(discovery, 'readOperationBody').mockImplementation(async (_ctx, name, input) => {
      if (name === 'skill-search') return { body: { skills: [{ name: 'stair-check' }, { name: 'client-letter' }], total: 2 } }
      const wanted = (input.params as { name: string }).name
      return wanted === 'stair-check'
        ? { body: { skill: { name: 'stair-check', description: 'Checks stairs.', origin: 'org', body: 'Measure every riser.' } } }
        : { refusal: 'Unknown skill.' }
    })
    const complete = await rpc(outside, 'completion/complete', { ref: { type: 'ref/prompt', name: 'office-skill' }, argument: { name: 'skill', value: 'stair' } })
    expect((complete.result?.completion as { values: string[] }).values).toEqual(['stair-check'])
    const loaded = await rpc(outside, 'prompts/get', { name: 'office-skill', arguments: { skill: 'stair-check' } })
    expect((loaded.result?.messages as { content: { text: string } }[])[0].content.text).toContain('Measure every riser.')
    const missing = await rpc(outside, 'prompts/get', { name: 'office-skill', arguments: { skill: 'nope' } })
    expect((missing.result?.messages as { content: { text: string } }[])[0].content.text).toContain('stair-check, client-letter')
    expect(read).toHaveBeenCalledWith(expect.anything(), 'skill-get', { params: { name: 'stair-check' } })
    read.mockRestore()
  })

  it('lists the person’s projects as attachable resources and reads one as its overview', async () => {
    const read = vi.spyOn(discovery, 'readOperationBody').mockImplementation(async (_ctx, name) =>
      name === 'project-list' ? { body: PROJECTS } : { body: { project: { id: 'p-1' }, counts: { documents: 1 } } },
    )
    const templates = (await rpc(outside, 'resources/templates/list')).result?.resourceTemplates as { uriTemplate: string }[]
    expect(templates.map((t) => t.uriTemplate)).toContain(PROJECT_URI_TEMPLATE)
    const listed = (await rpc(outside, 'resources/list')).result?.resources as { uri: string; name: string }[]
    expect(listed).toContainEqual(expect.objectContaining({ uri: 'piloti://project/p-1', name: 'Haus Josef' }))
    const { result } = await rpc(outside, 'resources/read', { uri: 'piloti://project/p-1' })
    expect(JSON.parse((result?.contents as { text: string }[])[0].text)).toEqual({ project: { id: 'p-1' }, counts: { documents: 1 } })
    expect(read).toHaveBeenCalledWith(expect.anything(), 'project-overview-get', { params: { id: 'p-1' } })
    read.mockRestore()
  })
})
