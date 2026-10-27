/**
 * The proposal card as an MCP App, end to end (ADR-0142), with nothing faked
 * between the card and the door but the route itself:
 *
 *   the card (`ProposalCardFrame`, the SDK's `App`)
 *     ⇄ the host (the SDK's own `AppBridge`, with an MCP `Client`)
 *     ⇄ Piloti's door (`buildMcpServer`, the real catalog and policy)
 *     → `callOperation` (mocked: the route's answer)
 *
 * The host calls `proposal-get` as its model would, hands the result to the
 * view, and the person presses Apply on the card: the press travels as the
 * app-only tool through the host to the door, which runs `proposal-apply` as
 * the person. The card shows the decided proposal, the model is told
 * (`ui/update-model-context`), and the card wears the host's theme and
 * language. The SDK's reference host (`examples/basic-host`) is an example app,
 * not a package; `AppBridge` is the part of it a host is built from.
 */

import { act, render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { webcrypto } from 'node:crypto'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { AppBridge, type McpUiHostContext } from '@modelcontextprotocol/ext-apps/app-bridge'
import { App } from '@modelcontextprotocol/ext-apps/react-with-deps'
import { Client, InMemoryTransport, type CallToolResult } from '@modelcontextprotocol/client'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/agent-api/dispatch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agent-api/dispatch')>()),
  callOperation: vi.fn(),
}))
vi.mock('@/lib/agent-api/telemetry', () => ({ recordOperationCalled: vi.fn(), recordOperationMissing: vi.fn() }))

import { callOperation } from '@/lib/agent-api/dispatch'
import { buildMcpServer } from '@/lib/agent-api/mcp-server'
import type { AgentPrincipal } from '@/lib/agent-api/principal'
import { APP_INFO, ProposalCardFrame } from './ProposalCardApp'

const session = {
  userId: 'user_anna',
  email: 'anna@piloti.test',
  name: 'Anna Berger',
  accessToken: '',
  organizationId: 'org_1',
  organizationMembershipId: 'om_1',
  role: 'member' as const,
  permissions: [],
  featureFlags: null,
}
const outside: AgentPrincipal = { actor: 'external_agent', clientId: 'client_claude', scopes: [], session }

const ID = '5f0c8a3e-2b7d-4e1a-9c6f-1d2e3f4a5b6c'
const proposal = (status: 'proposed' | 'applied') => ({
  id: ID,
  kind: 'operation',
  projectId: null,
  status,
  proposedByKind: 'piloti',
  onBehalfOf: 'user_anna',
  onBehalfOfName: 'Anna Berger',
  originConversationId: null,
  originMessageId: null,
  createdAt: '2026-10-27T09:12:00.000Z',
  decidedBy: status === 'applied' ? 'user_anna' : null,
  decidedByName: status === 'applied' ? 'Anna Berger' : null,
  decidedAt: status === 'applied' ? '2026-10-27T09:20:00.000Z' : null,
  results: status === 'applied' ? [{ label: 'folder-rename', ok: true }] : null,
  canDecide: status === 'proposed',
  payload: { operation: 'folder-rename', summary: 'Rename the folder „Pläne alt“ to „Archiv 2025“', input: { params: { id: 'p-1' } } },
  targets: [{ type: 'folder', id: 'f-1', name: 'Pläne alt' }],
})

const HOST: McpUiHostContext = {
  theme: 'dark',
  locale: 'de-AT',
  styles: { variables: { '--color-background-primary': 'light-dark(#fff, #262624)', '--color-text-primary': 'light-dark(#141413, #faf9f5)' } as never },
}

beforeAll(() => {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
})

afterEach(() => {
  document.documentElement.className = ''
  document.documentElement.removeAttribute('style')
})

/** Door ⇄ host ⇄ view, connected the way a host connects them. */
async function connect() {
  const [doorSide, hostClientSide] = InMemoryTransport.createLinkedPair()
  const door = buildMcpServer(outside, 'search')
  await door.connect(doorSide)
  const client = new Client({ name: 'spec-host', version: '1.0.0' })
  await client.connect(hostClientSide)

  const contexts: string[] = []
  const bridge = new AppBridge(client, { name: 'spec-host', version: '1.0.0' }, { serverTools: {}, updateModelContext: { text: {} } }, { hostContext: HOST })
  bridge.onupdatemodelcontext = async (params) => {
    const text = params.content?.find((item) => item.type === 'text')
    if (text && 'text' in text) contexts.push(text.text)
    return {}
  }
  const initialized = new Promise<void>((settle) => {
    bridge.oninitialized = () => settle()
  })
  const [hostSide, viewSide] = InMemoryTransport.createLinkedPair()
  await bridge.connect(hostSide)

  const app = new App(APP_INFO, { availableDisplayModes: ['inline'] }, { autoResize: false })
  let delivered: CallToolResult | null = null
  app.ontoolresult = (params) => {
    delivered = params as CallToolResult
  }
  await app.connect(viewSide)
  await initialized
  return { client, bridge, app, contexts, delivered: () => delivered }
}

describe('the proposal card in a host', () => {
  it('draws proposal-get’s result in the host’s theme and language, and a press applies it through the door as the person', async () => {
    vi.mocked(callOperation).mockResolvedValueOnce({ status: 200, ok: true, body: { proposal: proposal('proposed') } })
    const { client, bridge, app, contexts, delivered } = await connect()

    // The host's model calls the tool; the host hands its result to the view.
    const result = (await client.callTool({ name: 'proposal-get', arguments: { params: { id: ID } } })) as CallToolResult
    await bridge.sendToolResult(result)
    await waitFor(() => expect(delivered()).not.toBeNull())

    render(<ProposalCardFrame result={delivered()} hostContext={app.getHostContext()} app={app} />)
    expect(await screen.findByText('Rename the folder „Pläne alt“ to „Archiv 2025“')).toBeInTheDocument()
    // German copy from the host's locale; the host's theme on the document.
    expect(screen.getByText('Übernehmen?')).toBeInTheDocument()
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.style.getPropertyValue('--background')).toBe('var(--color-background-primary)')
    expect(document.documentElement.style.getPropertyValue('--foreground')).toBe('var(--color-text-primary)')
    // A token the host did not give keeps Piloti's own value.
    expect(document.documentElement.style.getPropertyValue('--muted-foreground')).toBe('')

    vi.mocked(callOperation).mockResolvedValueOnce({ status: 200, ok: true, body: { proposal: proposal('applied') } })
    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: 'Übernehmen' }))
    })

    expect(await screen.findByText('Die Aktion wurde ausgeführt.')).toBeInTheDocument()
    const [op, input, person] = vi.mocked(callOperation).mock.calls[1] ?? []
    expect(op?.name).toBe('proposal-apply')
    expect(input).toEqual({ params: { id: ID }, body: {} })
    expect(person).toBe(session)
    await waitFor(() => expect(contexts).toEqual([expect.stringContaining(`proposal ${ID}`)]))

    await app.close()
    await bridge.close()
    await client.close()
  })
})
