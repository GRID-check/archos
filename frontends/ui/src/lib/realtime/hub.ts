/**
 * The process's one way onto Dragonfly pub/sub for live channels (ADR-0104).
 *
 * `publish(topic, payload)` reaches every listener of the topic on every
 * replica; `subscribe(topic, listener)` returns its release. Behind that:
 *
 * - **One subscriber connection and one publisher per process**, opened lazily
 *   and only with `REDIS_URL`. A topic is SUBSCRIBEd when its first listener
 *   arrives and UNSUBSCRIBEd when its last one leaves, so a hundred viewers of
 *   one document on this replica are one subscription, and a thousand open
 *   streams are still one connection. (`lib/events/bus.ts` opens a connection
 *   per subscription; ADR-0104 moves it here next.)
 * - **In-process loopback, always.** A publish is delivered to this process's
 *   listeners directly, which is all a single replica (development, one pod)
 *   needs, and goes to Dragonfly for the others. A remote message carries the
 *   publishing process's id, and the replica that published it drops its own
 *   echo instead of delivering it twice.
 * - **Never throws.** What travels here is company and hints, not state: a lost
 *   message costs a pointer frame or one refetch that the next hint repeats.
 *
 * The transport is a seam (`EventTransport` from `lib/events/bus`), so the
 * ref-counting and the echo rule are tested without Redis (`hub.spec.ts`) and
 * once against a real `redis-server` (`hub.redis.spec.ts`).
 */

import 'server-only'
import { randomUUID } from 'node:crypto'
import type { EventTransport } from '@/lib/events/bus'

/** A listener receives the payload as published (loopback) or as parsed JSON (another replica). */
export type HubListener = (payload: unknown) => void

/** This process, on every message it sends to the others. */
const PROCESS_ID = randomUUID()

interface Topic {
  listeners: Set<HubListener>
  /** The remote subscription's release, once it is up; null when there is none. */
  remote: Promise<(() => Promise<void>) | null>
}

const topics = new Map<string, Topic>()
/** A topic's last UNSUBSCRIBE still in flight: a new SUBSCRIBE waits for it, or it would undo the new one. */
const releasing = new Map<string, Promise<void>>()

let remote: EventTransport | null | undefined

function getRemote(): EventTransport | null {
  if (remote !== undefined) return remote
  const url = process.env.REDIS_URL
  try {
    remote = url ? new SharedRedisTransport(url) : null
  } catch (error) {
    console.warn('[realtime] no redis transport, staying in-process:', error)
    remote = null
  }
  return remote
}

function deliver(topic: Topic | undefined, payload: unknown): void {
  if (!topic) return
  for (const listener of [...topic.listeners]) {
    try {
      listener(payload)
    } catch (error) {
      console.warn('[realtime] listener threw:', error)
    }
  }
}

function onRemote(name: string, raw: string): void {
  let message: { origin?: unknown; payload?: unknown } | null = null
  try {
    message = JSON.parse(raw) as { origin?: unknown; payload?: unknown }
  } catch {
    return
  }
  // Our own publish already went out through the loopback.
  if (!message || typeof message !== 'object' || message.origin === PROCESS_ID) return
  deliver(topics.get(name), message.payload)
}

/** Publish to a topic on every replica. Never throws. */
export async function publish(topic: string, payload: unknown): Promise<void> {
  deliver(topics.get(topic), payload)
  const transport = getRemote()
  if (!transport) return
  try {
    await transport.publish(topic, JSON.stringify({ origin: PROCESS_ID, payload }))
  } catch (error) {
    console.warn('[realtime] publish failed (other replicas miss this one):', error)
  }
}

/**
 * Listen to a topic. Returns the release, which MUST be called and is
 * idempotent. The CALLER authorizes: the hub carries whatever it is given.
 */
export function subscribe(name: string, listener: HubListener): () => void {
  let topic = topics.get(name)
  if (!topic) {
    const transport = getRemote()
    const after = releasing.get(name) ?? Promise.resolve()
    topic = {
      listeners: new Set(),
      remote: transport
        ? after
            .then(() => transport.subscribe(name, (raw) => onRemote(name, raw)))
            .catch((error: unknown) => {
              console.warn('[realtime] subscribe failed, this replica hears only itself:', error)
              return null
            })
        : Promise.resolve(null),
    }
    topics.set(name, topic)
  }
  const own = topic
  own.listeners.add(listener)
  let released = false
  return () => {
    if (released) return
    released = true
    own.listeners.delete(listener)
    if (own.listeners.size > 0 || topics.get(name) !== own) return
    topics.delete(name)
    const done = own.remote
      .then((release) => release?.())
      .catch((error: unknown) => console.warn('[realtime] unsubscribe failed:', error))
    releasing.set(name, done)
    void done.then(() => {
      if (releasing.get(name) === done) releasing.delete(name)
    })
  }
}

/** How many topics this process listens to, and to how many listeners: for tests and diagnostics. */
export function hubStats(): { topics: number; listeners: number } {
  let listeners = 0
  for (const topic of topics.values()) listeners += topic.listeners.size
  return { topics: topics.size, listeners }
}

/** Test seam: a transport (or none), and no topics. Resolves once every pending release has run. */
export async function __setHubTransportForTests(next: EventTransport | null): Promise<void> {
  await Promise.all([...releasing.values()])
  topics.clear()
  releasing.clear()
  remote = next
}

/**
 * One subscriber connection and one publisher for the whole process.
 *
 * A first command matters here: the first viewer of a document after a deploy
 * subscribes before the connection is up, and refusing it would leave that
 * viewer deaf to other replicas until they reload. So commands queue until the
 * connection is up (`enableOfflineQueue`) and are bounded by `commandTimeout`
 * (docs/contributing/gotchas.md, „Stream isn't writeable"). ioredis
 * re-subscribes every channel on reconnect by itself.
 */
export class SharedRedisTransport implements EventTransport {
  // ioredis has no types we import here: it is required lazily, so bundles without REDIS_URL never load it.
  private readonly subscriber: RedisLike
  private readonly publisher: RedisLike
  private readonly handlers = new Map<string, Set<(payload: string) => void>>()

  constructor(url: string) {
    this.publisher = createClient(url)
    this.subscriber = createClient(url)
    this.subscriber.on('message', (channel: string, payload: string) => {
      for (const handler of this.handlers.get(channel) ?? []) {
        try {
          handler(payload)
        } catch (error) {
          console.warn('[realtime] redis handler threw:', error)
        }
      }
    })
  }

  async publish(channel: string, payload: string): Promise<void> {
    await this.publisher.publish(channel, payload)
  }

  async subscribe(channel: string, onMessage: (payload: string) => void): Promise<() => Promise<void>> {
    let set = this.handlers.get(channel)
    if (!set) {
      set = new Set()
      this.handlers.set(channel, set)
    }
    set.add(onMessage)
    if (set.size === 1) {
      try {
        await this.subscriber.subscribe(channel)
      } catch (error) {
        const current = this.handlers.get(channel)
        current?.delete(onMessage)
        if (current?.size === 0) this.handlers.delete(channel)
        throw error
      }
    }
    return async () => {
      const current = this.handlers.get(channel)
      if (!current?.delete(onMessage) || current.size > 0) return
      this.handlers.delete(channel)
      await this.subscriber.unsubscribe(channel)
    }
  }

  /** Close both connections: for tests. */
  disconnect(): void {
    this.subscriber.disconnect()
    this.publisher.disconnect()
  }
}

interface RedisLike {
  on(event: string, listener: (...args: string[]) => void): unknown
  publish(channel: string, payload: string): Promise<unknown>
  subscribe(channel: string): Promise<unknown>
  unsubscribe(channel: string): Promise<unknown>
  disconnect(): void
}

function createClient(url: string): RedisLike {
  // Lazy require keeps ioredis out of bundles that never set REDIS_URL.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const IORedis = require('ioredis')
  const client = new IORedis(url, {
    connectTimeout: 1000,
    commandTimeout: 2000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: true,
    lazyConnect: false,
  }) as RedisLike
  client.on('error', (error: unknown) => {
    console.warn('[realtime] redis error:', error)
  })
  return client
}
