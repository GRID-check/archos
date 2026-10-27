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
 *  - Piloti's own door and the platform door get none of it, and on the
 *    2026-07-28 era neither does a client that did not declare it renders MCP
 *    Apps; a 2025-era client, which declares nothing, gets them as before, and a
 *    press from it is recorded as `app-unverified`;
 *  - a model's own `proposal-apply` or `proposal-dismiss` is put to the person
 *    first (elicitation), like a destructive write;
 *  - a large proposal keeps its `structuredContent`; only the text is capped.
 *
 * That the route's gate refuses a person without the right is proven against
 * Postgres in `operation-proposals.integration.spec.ts`.
 */

import { webcrypto } from 'node:crypto'
import { getToolUiResourceUri, isToolVisibilityAppOnly } from '@modelcontextprotocol/ext-apps/app-bridge'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

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
vi.mock('./read-gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./read-gate')>()
  return { ...actual, readGateFor: vi.fn(actual.readGateFor) }
})

import { ConflictError } from '@/lib/api/errors'
import { proposalResponseSchema } from '@/lib/proposals/types'
import { APP_TOOLS, PROPOSAL_CARD_URI } from './catalog/app-views'
import { MAX_RESULT_CHARS } from './discovery'
import { callOperation } from './dispatch'
import { isAppToolFor } from './exposure'
import { createAgentDoorHandler } from './mcp-server'
import { VIEW_UI_META, declaresMcpApps, runAppTool } from './mcp-apps'
import type { AgentPrincipal } from './principal'
import { readGateFor } from './read-gate'
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

afterEach(() => {
  vi.unstubAllEnvs()
})

/** A client that renders MCP Apps, as it declares itself (MCP Apps, "Capability Negotiation"). */
const RENDERS_APPS = { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } }
const handler = createAgentDoorHandler(() => undefined)

type Listed = { name: string; description?: string; _meta?: Record<string, unknown> }

async function rpc(
  principal: AgentPrincipal,
  mode: 'search' | 'tools',
  method: string,
  params: object = {},
  capabilities: Record<string, unknown> = RENDERS_APPS,
) {
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
            'io.modelcontextprotocol/clientCapabilities': capabilities,
            'io.modelcontextprotocol/clientInfo': { name: 'spec-host', version: '1' },
          },
        },
      }),
    }),
    { authInfo: { token: '', clientId: principal.clientId ?? '', scopes: [], extra: { principal, mode } } },
  )
  const raw = await response.text()
  const data = raw.split('\n').find((line) => line.startsWith('data:'))
  return JSON.parse(data ? data.slice(5) : raw) as { result?: Record<string, unknown>; error?: { message: string } }
}

const tools = async (principal: AgentPrincipal, mode: 'search' | 'tools') =>
  ((await rpc(principal, mode, 'tools/list')).result?.tools ?? []) as Listed[]
/** What a host shows its model: every listed tool but the app-only ones (MCP Apps, "Visibility"). */
const modelTools = (listed: Listed[]) => listed.filter((tool) => !isToolVisibilityAppOnly(tool))
type CallResult = {
  isError?: boolean
  structuredContent?: Record<string, unknown>
  content: { type: string; text?: string }[]
  resultType?: string
}
const callTool = async (
  principal: AgentPrincipal,
  mode: 'search' | 'tools',
  name: string,
  args: object,
  capabilities: Record<string, unknown> = RENDERS_APPS,
) => (await rpc(principal, mode, 'tools/call', { name, arguments: args }, capabilities)).result as CallResult

/** The same request as a 2025-era client sends it: no envelope, no capabilities, nothing to read them from. */
async function legacyRpc(method: string, params: object = {}) {
  const response = await handler.fetch(
    new Request('https://app.piloti.test/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'mcp-protocol-version': '2025-11-25' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
    { authInfo: { token: '', clientId: 'client_claude', scopes: [], extra: { principal: outside, mode: 'search' } } },
  )
  return JSON.parse(await response.text()) as { result?: Record<string, unknown> }
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

describe('a client that does not render MCP Apps', () => {
  it('reads which clients declare it: the extension with the MCP Apps mime type, nothing less', () => {
    expect(declaresMcpApps(RENDERS_APPS)).toBe(true)
    expect(declaresMcpApps({})).toBe(false)
    expect(declaresMcpApps({ extensions: { 'io.modelcontextprotocol/ui': {} } })).toBe(false)
    expect(declaresMcpApps({ extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html'] } } })).toBe(false)
  })

  it.each(['search', 'tools'] as const)('is offered neither the view, its link nor its buttons on the 2026-07-28 era (%s)', async (mode) => {
    const listed = ((await rpc(outside, mode, 'tools/list', {}, {})).result?.tools ?? []) as Listed[]
    const names = listed.map((tool) => tool.name)
    for (const tool of APP_TOOLS) expect(names).not.toContain(tool.name)
    for (const tool of listed) expect(getToolUiResourceUri(tool), tool.name).toBeUndefined()
    if (mode === 'search') expect(names).toEqual(['search-operations', 'describe-operation', 'call-operation', 'report-missing-operation'])
    const resources = ((await rpc(outside, mode, 'resources/list', {}, {})).result?.resources ?? []) as { uri: string }[]
    expect(resources.map((resource) => resource.uri)).not.toContain(PROPOSAL_CARD_URI)
  })

  it('cannot run a button there: the tool does not exist for it, and no route runs', async () => {
    const result = await callTool(outside, 'tools', 'proposal-card-apply', { id: PROPOSAL_ID }, {})
    expect(result?.structuredContent?.proposal).toBeUndefined()
    expect(callOperation).not.toHaveBeenCalled()
  })

  it('on the 2025 era, which declares nothing, is offered the card as before, and a press is not recorded as a press', async () => {
    const names = ((await legacyRpc('tools/list')).result?.tools as Listed[]).map((tool) => tool.name)
    for (const tool of APP_TOOLS) expect(names).toContain(tool.name)
    vi.mocked(callOperation).mockResolvedValue({ status: 200, ok: true, body: { proposal: proposal('applied') } })
    await legacyRpc('tools/call', { name: 'proposal-card-apply', arguments: { id: PROPOSAL_ID } })
    expect(vi.mocked(callOperation).mock.calls[0]?.[0].name).toBe('proposal-apply')
    expect(vi.mocked(recordOperationCalled).mock.calls[0]?.[0]).toMatchObject({ decisionSource: 'app-unverified' })
  })
})

describe('a model deciding a proposal itself', () => {
  const ELICITS = { ...RENDERS_APPS, elicitation: { form: {} } }

  it.each([
    ['search', 'call-operation', { name: 'proposal-apply', input: { params: { id: PROPOSAL_ID } } }],
    ['search', 'call-operation', { name: 'proposal-dismiss', input: { params: { id: PROPOSAL_ID } } }],
    ['tools', 'proposal-apply', { params: { id: PROPOSAL_ID }, body: {} }],
    ['tools', 'proposal-dismiss', { params: { id: PROPOSAL_ID } }],
  ] as const)('is put to the person first (%s, %s %j), and nothing runs yet', async (mode, name, args) => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', 'a-real-internal-token-for-the-mcp-apps-spec')
    const result = await callTool(outside, mode, name, args, ELICITS)
    expect(result.resultType, JSON.stringify(result)).toBe('input_required')
    expect(callOperation).not.toHaveBeenCalled()
  })

  it('is not asked about on the card: a press is the person’s, and runs', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', 'a-real-internal-token-for-the-mcp-apps-spec')
    vi.mocked(callOperation).mockResolvedValue({ status: 200, ok: true, body: { proposal: proposal('applied') } })
    const result = await callTool(outside, 'search', 'proposal-card-apply', { id: PROPOSAL_ID }, ELICITS)
    expect(result.resultType).not.toBe('input_required')
    expect(vi.mocked(callOperation).mock.calls[0]?.[0].name).toBe('proposal-apply')
  })
})

describe('a large proposal', () => {
  const large = () => {
    const big = proposal('proposed')
    return { ...big, payload: { ...big.payload, input: { params: { id: 'p-1' }, body: { name: 'x'.repeat(50_000) } } } }
  }

  it('keeps its structured content for the card; only the text the model reads is capped', async () => {
    vi.mocked(callOperation).mockResolvedValue({ status: 200, ok: true, body: { proposal: large() } })
    const read = await callTool(outside, 'search', 'proposal-get', { params: { id: PROPOSAL_ID } })
    expect(read.content[0]?.text?.length).toBeLessThan(MAX_RESULT_CHARS + 1_000)
    expect(read.content[0]?.text).toContain('[Truncated')
    expect(proposalResponseSchema.safeParse(read.structuredContent).success).toBe(true)

    vi.mocked(callOperation).mockResolvedValue({ status: 200, ok: true, body: { proposal: { ...large(), status: 'applied', canDecide: false } } })
    const applied = await callTool(outside, 'search', 'proposal-card-apply', { id: PROPOSAL_ID })
    expect(applied.isError).toBeFalsy()
    expect(proposalResponseSchema.parse(applied.structuredContent).proposal.status).toBe('applied')
  })
})

describe('a refusal before the route answers', () => {
  it('carries the read gate’s status, not one parsed from its words', async () => {
    vi.mocked(readGateFor).mockReturnValueOnce({
      beforeRead: async () => 'This conversation is shared; ask in your own.',
      mayHandOnLink: async () => true,
    } as unknown as ReturnType<typeof readGateFor>)
    const result = await callTool(outside, 'search', 'proposal-card-apply', { id: PROPOSAL_ID })
    expect(result).toMatchObject({ isError: true, structuredContent: { status: 403, code: 'FORBIDDEN' } })
    expect(callOperation).not.toHaveBeenCalled()
  })

  it('carries a thrown ApiError’s status and code', async () => {
    vi.mocked(callOperation).mockRejectedValueOnce(new ConflictError('This proposal has already been decided'))
    const result = await callTool(outside, 'search', 'proposal-card-dismiss', { id: PROPOSAL_ID })
    expect(result).toMatchObject({ isError: true, structuredContent: { status: 409, code: 'CONFLICT' } })
  })
})

describe('who may press', () => {
  it('is an outside agent only: Piloti’s audience has no app-only tool', () => {
    for (const tool of APP_TOOLS) {
      expect(isAppToolFor('external', tool.name)).toBe(true)
      expect(isAppToolFor('piloti', tool.name), tool.name).toBe(false)
    }
  })

  it('refuses Piloti’s own press of a button, even with a host that declares MCP Apps, and runs no route', async () => {
    for (const tool of APP_TOOLS) {
      const result = await runAppTool({ principal: piloti, mode: 'tools', appHost: 'declared' }, tool, { id: PROPOSAL_ID })
      expect(result, tool.name).toMatchObject({ isError: true, structuredContent: { status: 404 } })
    }
    const call = await callTool(piloti, 'tools', 'proposal-card-apply', { id: PROPOSAL_ID })
    expect(call?.structuredContent?.proposal).toBeUndefined()
    expect(callOperation).not.toHaveBeenCalled()
  })
})

describe('the extension', () => {
  it('is declared to an outside agent on the 2026-07-28 era, never to Piloti', async () => {
    const extensions = async (who: AgentPrincipal) =>
      ((await rpc(who, 'search', 'server/discover')).result as { capabilities: { extensions?: Record<string, unknown> } }).capabilities.extensions ?? {}
    expect(await extensions(outside)).toHaveProperty(['io.modelcontextprotocol/ui'])
    expect(await extensions(piloti)).not.toHaveProperty(['io.modelcontextprotocol/ui'])
    const undeclared = (await rpc(outside, 'search', 'server/discover', {}, {})).result as { capabilities: { extensions?: object } }
    expect(undeclared.capabilities.extensions ?? {}).not.toHaveProperty(['io.modelcontextprotocol/ui'])
  })
})
