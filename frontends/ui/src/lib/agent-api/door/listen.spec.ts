/**
 * @vitest-environment node
 */
/**
 * Listening on the door, through the real SDK: a client that attached
 * `piloti://project/{id}` hears when that project changes; it cannot listen to a
 * project it may not read, nor hear another organization; the capabilities say
 * only what is supported; and the bus works over a shared (fake Dragonfly)
 * transport.
 */
import { webcrypto } from 'node:crypto'
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  type AuthInfo,
} from '@modelcontextprotocol/server'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EventTransport } from '@/lib/events/bus'
import { __setHubTransportForTests } from '@/lib/realtime/hub'
import { publishProjectChanged, publishProjectListChanged } from '@/lib/realtime/door-events'
import * as discovery from '../discovery'
import { buildMcpServer, createAgentDoorHandler } from '../mcp-server'
import type { AgentPrincipal } from '../principal'

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
const otherOffice: AgentPrincipal = { ...outside, session: { ...session, organizationId: 'org_2', userId: 'user_2' } }

const READABLE = new Set(['p-1'])

beforeAll(() => {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
})

beforeEach(async () => {
  await __setHubTransportForTests(null)
  vi.spyOn(discovery, 'readOperationBody').mockImplementation(async (_ctx, _name, input) => {
    const id = String((input.params as { id?: string } | undefined)?.id)
    return READABLE.has(id) ? { body: { project: { id } } } : { refusal: 'project-overview-get was refused (HTTP 403).' }
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

const authInfoFor = (principal: AgentPrincipal): AuthInfo => ({ token: '', clientId: 'c', scopes: [], extra: { principal, mode: 'search' } })

function modernRequest(method: string, params: Record<string, unknown>, signal?: AbortSignal): Request {
  return new Request('https://app.piloti.test/api/mcp', {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': method,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 7,
      method,
      params: {
        ...params,
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
          [CLIENT_INFO_META_KEY]: { name: 'test', version: '1' },
          [CLIENT_CAPABILITIES_META_KEY]: {},
        },
      },
    }),
  })
}

interface Frame {
  method?: string
  params?: Record<string, unknown>
}

/** Reads SSE frames off a listen response until `stop` returns true. */
async function frames(response: Response, stop: (all: Frame[]) => boolean): Promise<Frame[]> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const all: Frame[] = []
  let buffer = ''
  const deadline = Date.now() + 2000
  while (Date.now() < deadline && !stop(all)) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<{ value: undefined; done: true }>((resolve) => setTimeout(() => resolve({ value: undefined, done: true }), 300)),
    ])
    if (done) break
    buffer += decoder.decode(value)
    for (const chunk of buffer.split('\n\n').slice(0, -1)) {
      const data = chunk.split('\n').find((line) => line.startsWith('data:'))
      if (data) all.push(JSON.parse(data.slice(5)) as Frame)
    }
    buffer = buffer.slice(buffer.lastIndexOf('\n\n') + 2 > 1 ? buffer.lastIndexOf('\n\n') + 2 : 0)
  }
  void reader.cancel().catch(() => undefined)
  return all
}

const listen = (handler: ReturnType<typeof createAgentDoorHandler>, principal: AgentPrincipal, notifications: Record<string, unknown>) =>
  handler.fetch(modernRequest('subscriptions/listen', { notifications }), { authInfo: authInfoFor(principal) })

const acknowledged = (all: Frame[]) => all.find((frame) => frame.method === 'notifications/subscriptions/acknowledged')?.params?.notifications
const updates = (all: Frame[]) => all.filter((frame) => frame.method === 'notifications/resources/updated').map((frame) => frame.params?.uri)

describe('listening to a project', () => {
  it('delivers resource_updated after a publish, through the real SDK', async () => {
    const handler = createAgentDoorHandler()
    const response = await listen(handler, outside, { resourceSubscriptions: ['piloti://project/p-1'], resourcesListChanged: true })
    const pending = frames(response, (all) => updates(all).length > 0 && all.some((f) => f.method === 'notifications/resources/list_changed'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    publishProjectChanged('org_1', 'p-1')
    publishProjectChanged('org_1', 'p-9')
    publishProjectListChanged('org_1')
    const all = await pending
    expect(acknowledged(all)).toEqual({ resourcesListChanged: true, resourceSubscriptions: ['piloti://project/p-1'] })
    expect(updates(all)).toEqual(['piloti://project/p-1'])
    expect(all.some((f) => f.method === 'notifications/resources/list_changed')).toBe(true)
  })

  it('refuses to listen to a project the person may not read: the acknowledgement honors only what they can', async () => {
    const handler = createAgentDoorHandler()
    const response = await listen(handler, outside, { resourceSubscriptions: ['piloti://project/p-2', 'piloti://guide', 'piloti://project/../x'] })
    const all = await frames(response, (found) => found.length > 0)
    expect(acknowledged(all)).toEqual({})
  })

  it('does not deliver another organization’s change, even for the same project id', async () => {
    const handler = createAgentDoorHandler()
    const response = await listen(handler, otherOffice, { resourceSubscriptions: ['piloti://project/p-1'], resourcesListChanged: true })
    const pending = frames(response, () => false)
    await new Promise((resolve) => setTimeout(resolve, 20))
    publishProjectChanged('org_1', 'p-1')
    publishProjectListChanged('org_1')
    const all = await pending
    expect(updates(all)).toEqual([])
    expect(all.some((f) => f.method === 'notifications/resources/list_changed')).toBe(false)
  })

  it('drops an event nobody stamped with an organization (the SDK’s own notify sugar)', async () => {
    const handler = createAgentDoorHandler()
    const response = await listen(handler, outside, { resourceSubscriptions: ['piloti://project/p-1'] })
    const pending = frames(response, () => false)
    await new Promise((resolve) => setTimeout(resolve, 20))
    handler.bus.publish({ kind: 'resource_updated', uri: 'piloti://project/p-1' })
    expect(updates(await pending)).toEqual([])
  })

  it('honors nothing for Piloti’s own principal', async () => {
    const handler = createAgentDoorHandler()
    const response = await listen(handler, piloti, { resourceSubscriptions: ['piloti://project/p-1'], resourcesListChanged: true })
    expect(acknowledged(await frames(response, (all) => all.length > 0))).toEqual({})
  })
})

describe('capabilities', () => {
  async function capabilitiesOf(principal: AgentPrincipal, era: 'modern' | 'legacy') {
    const server = buildMcpServer(principal, 'search', era)
    return server.server.getCapabilities()
  }

  it('advertises resources.subscribe and listChanged only to a modern, outside client', async () => {
    expect((await capabilitiesOf(outside, 'modern')).resources).toEqual({ listChanged: true, subscribe: true })
    expect((await capabilitiesOf(outside, 'legacy')).resources).toEqual({ listChanged: false })
  })

  it('claims no list changes where the lists only change with a deploy', async () => {
    const caps = await capabilitiesOf(outside, 'modern')
    expect(caps.tools).toEqual({ listChanged: false })
    expect(caps.prompts).toEqual({ listChanged: false })
  })

  it('advertises no resources or prompts to Piloti', async () => {
    const caps = await capabilitiesOf(piloti, 'modern')
    expect(caps.resources).toBeUndefined()
    expect(caps.prompts).toBeUndefined()
  })
})

describe('the bus over a shared transport (a fake Dragonfly)', () => {
  /** A broker two "pods" share: it echoes every publish to every subscriber, as Redis does. */
  function broker() {
    const handlers = new Map<string, Set<(payload: string) => void>>()
    const transport: EventTransport = {
      async publish(channel, payload) {
        for (const handler of handlers.get(channel) ?? []) handler(payload)
      },
      async subscribe(channel, onMessage) {
        const set = handlers.get(channel) ?? new Set()
        set.add(onMessage)
        handlers.set(channel, set)
        return async () => void set.delete(onMessage)
      },
    }
    return { transport, handlers }
  }

  it('publishes to the shared channel and delivers what another pod published, once', async () => {
    const { transport, handlers } = broker()
    await __setHubTransportForTests(transport)
    const handler = createAgentDoorHandler()
    const response = await listen(handler, outside, { resourceSubscriptions: ['piloti://project/p-1'] })
    const pending = frames(response, () => false)
    await new Promise((resolve) => setTimeout(resolve, 20))
    // Another pod's message arrives on the shared channel.
    const [receive] = [...(handlers.get('rt:door:events') ?? [])]
    receive(JSON.stringify({ origin: 'another-pod', payload: { kind: 'resource_updated', organizationId: 'org_1', uri: 'piloti://project/p-1' } }))
    // A malformed or foreign-tenant message is ignored.
    receive(JSON.stringify({ origin: 'another-pod', payload: { kind: 'resource_updated', organizationId: 'org_2', uri: 'piloti://project/p-1' } }))
    receive('not json')
    // This pod's own publish loops back locally and echoes from the broker: heard once.
    publishProjectChanged('org_1', 'p-1')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(updates(await pending)).toEqual(['piloti://project/p-1', 'piloti://project/p-1'])
  })
})
