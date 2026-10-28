/**
 * @vitest-environment node
 */
/**
 * The hub against a real Redis-protocol server, because a mock never sees a
 * connection that is not up yet (docs/contributing/gotchas.md): the first
 * SUBSCRIBE is issued before the connection is up and still holds, another
 * replica's message arrives, our own echo does not arrive twice, and the
 * last release leaves no subscriber on the server.
 *
 * Runs only with `REALTIME_REDIS_URL` set, e.g. against a local server:
 *   redis-server --port 6390 --save '' &
 *   REALTIME_REDIS_URL=redis://127.0.0.1:6390 npx vitest run src/lib/realtime/hub.redis.spec.ts
 */

import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { __setHubTransportForTests, publish, SharedRedisTransport, subscribe } from './hub'

const URL = process.env.REALTIME_REDIS_URL

const until = async (check: () => boolean, ms = 2_000) => {
  const end = Date.now() + ms
  while (!check() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 20))
}

describe.skipIf(!URL)('the hub on a real redis-server', () => {
  const transports: SharedRedisTransport[] = []
  afterAll(async () => {
    await __setHubTransportForTests(null)
    for (const transport of transports) transport.disconnect()
  })

  it('subscribes before the connection is up, hears another replica once, and drops its own echo', async () => {
    const ours = new SharedRedisTransport(URL!)
    const theirs = new SharedRedisTransport(URL!)
    transports.push(ours, theirs)
    await __setHubTransportForTests(ours)

    const topic = `rt:doc:redis-${Date.now()}`
    const heard: unknown[] = []
    const releaseOne = subscribe(topic, (payload) => heard.push(payload))
    const releaseTwo = subscribe(topic, (payload) => heard.push(payload))

    const remoteHeard: string[] = []
    const releaseRemote = await theirs.subscribe(topic, (payload) => remoteHeard.push(payload))

    // Wait for our SUBSCRIBE to land, then another replica speaks.
    await until(() => {
      void theirs.publish(topic, JSON.stringify({ origin: 'another-replica', payload: { kind: 'probe' } }))
      return heard.length > 0
    })
    heard.length = 0
    remoteHeard.length = 0

    await theirs.publish(topic, JSON.stringify({ origin: 'another-replica', payload: { kind: 'viewport' } }))
    await publish(topic, { kind: 'cursor' })
    await until(() => heard.length >= 4 && remoteHeard.length >= 2)
    await new Promise((resolve) => setTimeout(resolve, 100))

    // Two listeners, each hears the other replica's message once and our own once.
    expect(heard.filter((payload) => (payload as { kind: string }).kind === 'viewport')).toHaveLength(2)
    expect(heard.filter((payload) => (payload as { kind: string }).kind === 'cursor')).toHaveLength(2)
    expect(remoteHeard.filter((payload) => payload.includes('"cursor"'))).toHaveLength(1)

    releaseOne()
    releaseTwo()
    await releaseRemote()
    await __setHubTransportForTests(ours)

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const IORedis = require('ioredis')
    const probe = new IORedis(URL)
    const [, count] = (await probe.pubsub('NUMSUB', topic)) as [string, number]
    probe.disconnect()
    expect(Number(count)).toBe(0)
  })
})
