/**
 * @vitest-environment node
 */
/**
 * The hub: one subscription per topic however many listen, none left after the
 * last leaves, a message delivered once on the replica that published it
 * although the shared transport echoes it back, and what another replica
 * published delivered to the right topic only.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import type { EventTransport } from '@/lib/events/bus'
import { __setHubTransportForTests, hubStats, publish, subscribe } from './hub'

/** A shared transport that echoes every publish to its own subscribers, as Redis does, and counts SUBSCRIBEs. */
function echoingTransport() {
  const handlers = new Map<string, Set<(payload: string) => void>>()
  const published: string[] = []
  const calls: string[] = []
  const transport: EventTransport = {
    async publish(channel, payload) {
      published.push(payload)
      for (const handler of handlers.get(channel) ?? []) handler(payload)
    },
    async subscribe(channel, onMessage) {
      calls.push(`SUBSCRIBE ${channel}`)
      const set = handlers.get(channel) ?? new Set()
      set.add(onMessage)
      handlers.set(channel, set)
      return async () => {
        calls.push(`UNSUBSCRIBE ${channel}`)
        set.delete(onMessage)
        if (set.size === 0) handlers.delete(channel)
      }
    },
  }
  return { transport, published, calls, handlers }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(async () => {
  await __setHubTransportForTests(null)
})

describe('the hub', () => {
  it('subscribes a topic once for two listeners, and unsubscribes after the last one leaves', async () => {
    const remote = echoingTransport()
    await __setHubTransportForTests(remote.transport)

    const one = subscribe('rt:doc:a', () => {})
    const two = subscribe('rt:doc:a', () => {})
    await settle()
    expect(remote.calls).toEqual(['SUBSCRIBE rt:doc:a'])

    one()
    one() // idempotent
    await settle()
    expect(remote.calls).toEqual(['SUBSCRIBE rt:doc:a'])
    two()
    await settle()
    expect(remote.calls).toEqual(['SUBSCRIBE rt:doc:a', 'UNSUBSCRIBE rt:doc:a'])
    expect(hubStats()).toEqual({ topics: 0, listeners: 0 })
    expect(remote.handlers.size).toBe(0)
  })

  it('subscribes again only after a release in flight has unsubscribed', async () => {
    const remote = echoingTransport()
    await __setHubTransportForTests(remote.transport)

    const first = subscribe('rt:doc:a', () => {})
    first()
    const heard: unknown[] = []
    const second = subscribe('rt:doc:a', (payload) => heard.push(payload))
    await settle()
    expect(remote.calls).toEqual(['SUBSCRIBE rt:doc:a', 'UNSUBSCRIBE rt:doc:a', 'SUBSCRIBE rt:doc:a'])

    await remote.transport.publish('rt:doc:a', JSON.stringify({ origin: 'another-replica', payload: { kind: 'x' } }))
    expect(heard).toEqual([{ kind: 'x' }])
    second()
  })

  it('delivers once on the publishing replica although the shared transport echoes it back', async () => {
    const remote = echoingTransport()
    await __setHubTransportForTests(remote.transport)
    const heard: unknown[] = []
    const release = subscribe('rt:doc:a', (payload) => heard.push(payload))
    await settle()

    await publish('rt:doc:a', { kind: 'presence' })

    expect(heard).toEqual([{ kind: 'presence' }])
    expect(remote.published).toHaveLength(1)
    release()
  })

  it('delivers what another replica published, and only to its own topic', async () => {
    const remote = echoingTransport()
    await __setHubTransportForTests(remote.transport)
    const one: unknown[] = []
    const two: unknown[] = []
    const releaseOne = subscribe('rt:doc:a', (payload) => one.push(payload))
    const releaseTwo = subscribe('rt:doc:b', (payload) => two.push(payload))
    await settle()

    await remote.transport.publish('rt:doc:a', JSON.stringify({ origin: 'another-replica', payload: { kind: 'viewport' } }))
    await remote.transport.publish('rt:doc:a', 'not json')

    expect(one).toEqual([{ kind: 'viewport' }])
    expect(two).toEqual([])
    releaseOne()
    releaseTwo()
  })

  it('works in-process with no transport, and a throwing listener does not stop the others', async () => {
    const heard: unknown[] = []
    const releaseBad = subscribe('rt:doc:a', () => {
      throw new Error('boom')
    })
    const release = subscribe('rt:doc:a', (payload) => heard.push(payload))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await publish('rt:doc:a', { kind: 'cursor' })

    expect(heard).toEqual([{ kind: 'cursor' }])
    releaseBad()
    release()
    expect(hubStats()).toEqual({ topics: 0, listeners: 0 })
    warn.mockRestore()
  })

  it('stays in-process when the transport refuses the subscription', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await __setHubTransportForTests({
      publish: async () => {
        throw new Error('down')
      },
      subscribe: async () => {
        throw new Error('down')
      },
    })
    const heard: unknown[] = []
    const release = subscribe('rt:doc:a', (payload) => heard.push(payload))
    await settle()

    await expect(publish('rt:doc:a', { kind: 'cursor' })).resolves.toBeUndefined()
    expect(heard).toEqual([{ kind: 'cursor' }])
    release()
    warn.mockRestore()
  })
})
