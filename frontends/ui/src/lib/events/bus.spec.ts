/**
 * @vitest-environment node
 */
/**
 * The per-user bus rides on the realtime hub (ADR-0110 phase 2): an event is
 * heard once on the replica that published it although Dragonfly echoes it
 * back, another replica's event arrives, and a closed stream leaves no
 * subscription behind.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { __setHubTransportForTests, hubStats } from '@/lib/realtime/hub'
import {
  publishToUser,
  subscribeUser,
  userChannel,
  type CollaborationEvent,
  type EventEnvelope,
  type EventTransport,
} from './bus'

/** A shared transport that echoes every publish to its own subscribers, as Redis does. */
function echoingTransport() {
  const handlers = new Map<string, Set<(payload: string) => void>>()
  const transport: EventTransport = {
    async publish(channel, payload) {
      for (const handler of handlers.get(channel) ?? []) handler(payload)
    },
    async subscribe(channel, onMessage) {
      const set = handlers.get(channel) ?? new Set()
      set.add(onMessage)
      handlers.set(channel, set)
      return async () => {
        set.delete(onMessage)
        if (set.size === 0) handlers.delete(channel)
      }
    },
  }
  return { transport, handlers }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const event: CollaborationEvent = { kind: 'inbox.changed', pending: 1 }

beforeEach(async () => {
  await __setHubTransportForTests(null)
})

describe('the per-user bus', () => {
  it('delivers once on the publishing replica, although the transport echoes it', async () => {
    const remote = echoingTransport()
    await __setHubTransportForTests(remote.transport)
    const heard: EventEnvelope[] = []
    const unsubscribe = await subscribeUser('u1', (envelope) => heard.push(envelope))
    await settle()

    await publishToUser('u1', event)
    await publishToUser('u2', event)

    expect(heard).toHaveLength(1)
    expect(heard[0]?.event).toEqual(event)
    await unsubscribe()
  })

  it("delivers another replica's event, and drops a malformed one", async () => {
    const remote = echoingTransport()
    await __setHubTransportForTests(remote.transport)
    const heard: EventEnvelope[] = []
    const unsubscribe = await subscribeUser('u1', (envelope) => heard.push(envelope))
    await settle()

    const fromElsewhere = { id: 'x-1', at: '2026-10-22T00:00:00.000Z', event }
    await remote.transport.publish(userChannel('u1'), JSON.stringify({ origin: 'other', payload: fromElsewhere }))
    await remote.transport.publish(userChannel('u1'), JSON.stringify({ origin: 'other', payload: 'nonsense' }))

    expect(heard).toEqual([fromElsewhere])
    await unsubscribe()
  })

  it('leaves no listener and no subscription after the stream closes', async () => {
    const remote = echoingTransport()
    await __setHubTransportForTests(remote.transport)
    const unsubscribe = await subscribeUser('u1', () => {})
    await settle()
    expect(remote.handlers.size).toBe(1)

    await unsubscribe()
    await settle()

    expect(hubStats()).toEqual({ topics: 0, listeners: 0 })
    expect(remote.handlers.size).toBe(0)
  })

  it('works in-process with no transport at all', async () => {
    const heard: EventEnvelope[] = []
    const unsubscribe = await subscribeUser('u1', (envelope) => heard.push(envelope))
    await publishToUser('u1', event)
    expect(heard).toHaveLength(1)
    await unsubscribe()
  })
})
