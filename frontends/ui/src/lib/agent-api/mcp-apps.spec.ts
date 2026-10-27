/**
 * @vitest-environment node
 */
/**
 * The door's MCP Apps (ADR-0142), through the real SDK, the real catalog and the
 * door's own server, read the way a host reads them (the MCP Apps SDK's own
 * host helpers, `@modelcontextprotocol/ext-apps/app-bridge`):
 *
 *  - the `ui://` resource is listed and read with the MCP Apps mime type and an
 *    empty CSP, and its document is the built file, the same for every caller;
 *  - `proposal-get` links to it, in both modes, and its result carries the
 *    route's `{ proposal }` as `structuredContent`, which the card parses;
 *  - the card's buttons are app-only tools: a host keeps them from the model,
 *    and they run `proposal-apply` / `proposal-dismiss` as the person, through
 *    `callOperation`, the dispatcher every call takes, so the route's `authz`
 *    decides; a refusal carries the route's status;
 *  - Piloti's own door and the platform door get none of it.
 *
 * That the route's gate refuses a person without the right is proven against
 * Postgres in `operation-proposals.integration.spec.ts`.
 */

import { webcrypto } from 'node:crypto'
import { getToolUiResourceUri, isToolVisibilityAppOnly } from '@modelcontextprotocol/ext-apps/app-bridge'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const VIEW_HTML = '<!doctype html><html><head></head><body><div id="root"></div><script type="module">/* view */</script></body></html>'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: vi.fn(async (path: unknown, ...rest: unknown[]) =>
      String(path).endsWith('mcp-app-views/proposal-card.html') ? VIEW_HTML : (actual.readFile as (...args: unknown[]) => unknown)(path, ...rest),
    ),
  }
})
vi.mock('./dispatch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./dispatch')>()),
  callOperation: vi.fn(),
}))
vi.mock('./telemetry', () => ({ recordOperationCalled: vi.fn(), recordOperationMissing: vi.fn() }))

import { proposalResponseSchema } from '@/lib/proposals/types'
import { APP_TOOLS, PROPOSAL_CARD_URI } from './catalog/app-views'
import { callOperation } from './dispatch'
import { buildMcpServer } from './mcp-server'
import { VIEW_UI_META } from './mcp-apps'
import type { AgentPrincipal } from './principal'
import { recordOperationCalled } from './telemetry'

const session = {
  userId: 'user_1',
  email: 'a@piloti.test',
  name: null,
  accessToken: '',
  organizationId: 'org_1',
  organizationMembershipId: 'om_1',
  role: 'member' as const,
  permissions: [],
  featureFlags: null,
}
const outside: AgentPrincipal = { actor: 'external_agent', clientId: 'client_claude', scopes: [], session }
const piloti: AgentPrincipal = { actor: 'piloti', clientId: null, scopes: [], session }
const platform: AgentPrincipal = { ...outside, door: 'platform' }

const PROPOSAL_ID = '5f0c8a3e-2b7d-4e1a-9c6f-1d2e3f4a5b6c'
const proposal = (status: string) => ({
  id: PROPOSAL_ID,
  kind: 'operation',
  projectId: null,
  status,
  proposedByKind: 'piloti',
  onBehalfOf: 'user_1',
  onBehalfOfName: 'Anna Berger',
  originConversationId: null,
  originMessageId: null,
  createdAt: '2026-10-27T09:12:00.000Z',
  decidedBy: status === 'proposed' ? null : 'user_1',
  decidedByName: status === 'proposed' ? null : 'Anna Berger',
  decidedAt: status === 'proposed' ? null : '2026-10-27T09:20:00.000Z',
  results: null,
  canDecide: status === 'proposed',
  payload: { operation: 'folder-rename', summary: 'Rename the folder', input: { params: { id: 'p-1' } } },
  targets: [],
})

beforeAll(() => {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
})

beforeEach(() => {
  vi.mocked(callOperation).mockReset().mockResolvedValue({ status: 200, ok: true, body: { proposal: proposal('proposed') } })
  vi.mocked(recordOperationCalled).mockReset()
})

type Listed = { name: string; description?: string; _meta?: Record<string, unknown> }

async function rpc(principal: AgentPrincipal, mode: 'search' | 'tools', method: string, params: object = {}) {
  const handler = createMcpHandler(() => buildMcpServer(principal, mode, 'modern'), { responseMode: 'json' })
  const response = await handler.fetch(
    new Request('https://app.piloti.test/api/mcp', {
      method: 'POST',
      // A 2026-07-28 request, as a current host sends it: the version and the client's capabilities on every request.
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': method,
        // The routing header a 2026-07-28 call names its tool or resource in.
        ...('name' in params || 'uri' in params ? { 'mcp-name': String((params as { name?: string; uri?: string }).name ?? (params as { uri: string }).uri) } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } },
            'io.modelcontextprotocol/clientInfo': { name: 'spec-host', version: '1' },
          },
        },
      }),
    }),
  )
  const raw = await response.text()
  const data = raw.split('\n').find((line) => line.startsWith('data:'))
  return JSON.parse(data ? data.slice(5) : raw) as { result?: Record<string, unknown>; error?: { message: string } }
}

const tools = async (principal: AgentPrincipal, mode: 'search' | 'tools') =>
  ((await rpc(principal, mode, 'tools/list')).result?.tools ?? []) as Listed[]
/** What a host shows its model: every listed tool but the app-only ones (MCP Apps, "Visibility"). */
const modelTools = (listed: Listed[]) => listed.filter((tool) => !isToolVisibilityAppOnly(tool))
const callTool = async (principal: AgentPrincipal, mode: 'search' | 'tools', name: string, args: object) =>
  (await rpc(principal, mode, 'tools/call', { name, arguments: args })).result as {
    isError?: boolean
    structuredContent?: Record<string, unknown>
    content: { type: string; text?: string }[]
  }

describe('the proposal card resource', () => {
  it('is listed with the MCP Apps mime type and its CSP, for an outside agent', async () => {
    const listed = ((await rpc(outside, 'search', 'resources/list')).result?.resources ?? []) as { uri: string; mimeType: string; _meta?: unknown }[]
    const card = listed.find((resource) => resource.uri === PROPOSAL_CARD_URI)
    expect(card).toMatchObject({ mimeType: 'text/html;profile=mcp-app', _meta: { ui: VIEW_UI_META } })
  })

  it('is read as the built document, with the mime type and an empty CSP on the content', async () => {
    const read = (await rpc(outside, 'tools', 'resources/read', { uri: PROPOSAL_CARD_URI })).result as {
      contents: { uri: string; mimeType: string; text: string; _meta: { ui: typeof VIEW_UI_META } }[]
    }
    expect(read.contents).toHaveLength(1)
    const [content] = read.contents
    expect(content).toMatchObject({ uri: PROPOSAL_CARD_URI, mimeType: 'text/html;profile=mcp-app', text: VIEW_HTML })
    // No origin to connect to, load from or frame: the host applies its restrictive default.
    expect(content?._meta.ui.csp).toEqual({ connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] })
    expect(content?._meta.ui.permissions).toEqual({})
  })

  it('reads the same for every caller: the template carries no tenant data', async () => {
    const other: AgentPrincipal = { ...outside, session: { ...session, userId: 'user_2', organizationId: 'org_2' } }
    const read = async (who: AgentPrincipal) =>
      JSON.stringify((await rpc(who, 'search', 'resources/read', { uri: PROPOSAL_CARD_URI })).result)
    expect(await read(other)).toBe(await read(outside))
  })

  it('is not offered on Piloti’s own door or the platform door', async () => {
    for (const who of [piloti, platform]) {
      const listed = ((await rpc(who, 'search', 'resources/list')).result?.resources ?? []) as { uri: string }[]
      expect(listed.map((resource) => resource.uri)).not.toContain(PROPOSAL_CARD_URI)
      const names = (await tools(who, 'tools')).map((tool) => tool.name)
      for (const tool of APP_TOOLS) expect(names, who.actor).not.toContain(tool.name)
    }
  })
})

describe('the tool that draws it', () => {
  it.each(['search', 'tools'] as const)('is proposal-get, linked to the card in %s mode', async (mode) => {
    const get = (await tools(outside, mode)).find((tool) => tool.name === 'proposal-get')
    expect(get, 'proposal-get is listed').toBeDefined()
    expect(getToolUiResourceUri(get as Listed)).toBe(PROPOSAL_CARD_URI)
    // The SDK also writes the deprecated flat key, for a host that reads only that.
    expect(get?._meta?.['ui/resourceUri']).toBe(PROPOSAL_CARD_URI)
    expect(get?.description).toContain('MCP Apps')
  })

  it('carries the route’s own answer as the structured content the card parses', async () => {
    const result = await callTool(outside, 'search', 'proposal-get', { params: { id: PROPOSAL_ID } })
    expect(result.isError).toBeFalsy()
    expect(proposalResponseSchema.safeParse(result.structuredContent).success).toBe(true)
    // And the text a host without MCP Apps, and the model, read.
    expect(result.content[0]?.text).toContain(PROPOSAL_ID)
    expect(vi.mocked(callOperation).mock.calls[0]?.[0].name).toBe('proposal-get')
  })

  it('is no view for Piloti: its proposal-get links to nothing', async () => {
    const get = (await tools(piloti, 'tools')).find((tool) => tool.name === 'proposal-get')
    expect(get && getToolUiResourceUri(get)).toBeUndefined()
  })
})

describe('the card’s buttons, app-only tools', () => {
  it.each(['search', 'tools'] as const)('are listed in %s mode for the view, and a host keeps them from the model', async (mode) => {
    const listed = await tools(outside, mode)
    for (const tool of APP_TOOLS) {
      const entry = listed.find((candidate) => candidate.name === tool.name)
      expect(entry, tool.name).toBeDefined()
      expect(isToolVisibilityAppOnly(entry as Listed), tool.name).toBe(true)
      expect(getToolUiResourceUri(entry as Listed), tool.name).toBe(PROPOSAL_CARD_URI)
    }
    const shown = modelTools(listed).map((tool) => tool.name)
    for (const tool of APP_TOOLS) expect(shown).not.toContain(tool.name)
    // What the model is shown in search mode: the four meta-tools and the card's read.
    if (mode === 'search') {
      expect(shown).toEqual(['search-operations', 'describe-operation', 'call-operation', 'report-missing-operation', 'proposal-get'])
    }
  })

  it('are not names the model can find or run through the catalog', async () => {
    const search = await callTool(outside, 'search', 'search-operations', { query: 'proposal card apply' })
    expect(JSON.stringify(search)).not.toContain('proposal-card-apply')
    const run = await callTool(outside, 'search', 'call-operation', { name: 'proposal-card-apply', input: { params: { id: PROPOSAL_ID } } })
    expect(run.isError).toBe(true)
    expect(callOperation).not.toHaveBeenCalled()
  })

  it('apply runs proposal-apply as the person, through the dispatcher, and answers the decided proposal', async () => {
    vi.mocked(callOperation).mockResolvedValue({ status: 200, ok: true, body: { proposal: proposal('applied') } })
    const result = await callTool(outside, 'search', 'proposal-card-apply', { id: PROPOSAL_ID })
    expect(result.isError).toBeFalsy()
    expect(proposalResponseSchema.parse(result.structuredContent).proposal.status).toBe('applied')
    const [op, input, person, reader] = vi.mocked(callOperation).mock.calls[0] ?? []
    expect(op?.name).toBe('proposal-apply')
    expect(op?.path).toBe('/api/proposals/[id]/apply')
    expect(input).toEqual({ params: { id: PROPOSAL_ID }, body: {} })
    expect(person).toBe(session)
    expect(reader).toBe('agent')
    // Recorded as the person's press on the card.
    expect(vi.mocked(recordOperationCalled).mock.calls[0]?.[0]).toMatchObject({ decisionSource: 'app' })
  })

  it('apply passes the one choice the card offers, a note kept in the project', async () => {
    await callTool(outside, 'tools', 'proposal-card-apply', { id: PROPOSAL_ID, memoryScope: 'project' })
    expect(vi.mocked(callOperation).mock.calls[0]?.[1]).toEqual({ params: { id: PROPOSAL_ID }, body: { memoryScope: 'project' } })
  })

  it('dismiss runs proposal-dismiss, with no body', async () => {
    vi.mocked(callOperation).mockResolvedValue({ status: 200, ok: true, body: { proposal: proposal('dismissed') } })
    await callTool(outside, 'tools', 'proposal-card-dismiss', { id: PROPOSAL_ID })
    const [op, input] = vi.mocked(callOperation).mock.calls[0] ?? []
    expect(op?.name).toBe('proposal-dismiss')
    expect(input).toEqual({ params: { id: PROPOSAL_ID } })
  })

  it('answer a refusal of the route with its status: 403 for a person without the right, 409 once decided', async () => {
    vi.mocked(callOperation).mockResolvedValueOnce({ status: 403, ok: false, body: { error: 'Forbidden', code: 'FORBIDDEN' } })
    const forbidden = await callTool(outside, 'search', 'proposal-card-apply', { id: PROPOSAL_ID })
    expect(forbidden).toMatchObject({ isError: true, structuredContent: { status: 403, code: 'FORBIDDEN' } })
    vi.mocked(callOperation).mockResolvedValueOnce({ status: 409, ok: false, body: { error: 'Already decided', code: 'CONFLICT' } })
    const decided = await callTool(outside, 'search', 'proposal-card-dismiss', { id: PROPOSAL_ID })
    expect(decided).toMatchObject({ isError: true, structuredContent: { status: 409, code: 'CONFLICT' } })
  })

  it('refuse an input that is not one proposal id, before any route runs', async () => {
    const result = await callTool(outside, 'search', 'proposal-card-apply', { id: 'not-a-uuid' })
    expect(result.isError).toBe(true)
    expect(callOperation).not.toHaveBeenCalled()
  })
})

describe('the extension', () => {
  it('is declared to an outside agent on the 2026-07-28 era, never to Piloti', async () => {
    const extensions = async (who: AgentPrincipal) =>
      ((await rpc(who, 'search', 'server/discover')).result as { capabilities: { extensions?: Record<string, unknown> } }).capabilities.extensions ?? {}
    expect(await extensions(outside)).toHaveProperty(['io.modelcontextprotocol/ui'])
    expect(await extensions(piloti)).not.toHaveProperty(['io.modelcontextprotocol/ui'])
  })
})
