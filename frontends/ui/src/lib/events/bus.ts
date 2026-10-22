/**
 * Per-user event bus for live collaboration updates (ADR-0035 §9, spec RT-1…RT-8).
 *
 * **What this is NOT:** a store. The database is the system of record. Dragonfly
 * runs `cache_mode=true` with no persistence volume and evicts under memory
 * pressure (ADR-0020), so a notification that existed only here could vanish
 * unseen. Every event published here is a *hint that something changed*; the
 * receiver's correctness comes from re-reading Postgres.
 *
 * **Authorization happens at publish time.** Events go to per-USER channels
 * (`user:<id>:events`), never per-resource channels. The server resolves a
 * resource's participants and publishes to each one's own channel, so a
 * subscriber can only ever receive what was addressed to them and there is no
 * shared channel to accidentally over-subscribe to. Browsers never filter
 * locally.
 *
 * **Carried by the realtime hub** (`lib/realtime/hub.ts`, ADR-0110 phase 2):
 * one Dragonfly subscriber connection per process, however many streams are
 * open, a publish delivered in-process to this replica's listeners and through
 * Dragonfly to the others, and the publishing replica's echo dropped by process
 * id so nobody hears an event twice. With no `REDIS_URL` it is in-process only,
 * which is correct on a single replica (dev, tests, the single-node Coolify
 * deployment). Nothing here throws: an outage degrades to local-only delivery
 * instead of failing the request that triggered it.
 */

import 'server-only'
import * as hub from '@/lib/realtime/hub'
import type { CollaborationEvent, EventEnvelope } from './types'

/** Channel a single user's live updates flow on. */
export function userChannel(userId: string): string {
  return `user:${userId}:events`
}

// Event kinds and the envelope live in `./types` (no `server-only`), because the
// browser hub needs them to interpret an SSE frame and must not import this
// module's transport. Re-exported here so server callers have one import.
export type { CollaborationEvent, EventEnvelope } from './types'

/** The pluggable transport, so the protocol is testable without Redis. */
export interface EventTransport {
  publish(channel: string, payload: string): Promise<void>
  subscribe(channel: string, onMessage: (payload: string) => void): Promise<() => Promise<void>>
}

let counter = 0

function envelope(event: CollaborationEvent): EventEnvelope {
  counter += 1
  return { id: `${Date.now().toString(36)}-${counter}`, at: new Date().toISOString(), event }
}

/**
 * Publish an event to one user's channel.
 *
 * NEVER throws: a delivery failure must not fail the user action that caused it.
 * The event is a latency optimisation — the receiver would converge anyway on
 * its next fetch (spec RT-4).
 */
export async function publishToUser(userId: string, event: CollaborationEvent): Promise<void> {
  // Not awaited: this replica's listeners are served synchronously inside
  // `hub.publish`, and the user action must not wait on Dragonfly, whose client
  // queues while it is down (up to its command timeout).
  void hub.publish(userChannel(userId), envelope(event))
}

/**
 * Publish the same event to several users — the participant fan-out.
 *
 * Deliberately N publishes rather than one broadcast: it is what makes the
 * authorization argument trivial (a user's channel only ever carries what was
 * addressed to them). Fine at present scale; revisit for very large rosters.
 */
export async function publishToUsers(userIds: readonly string[], event: CollaborationEvent): Promise<void> {
  const unique = [...new Set(userIds)].filter(Boolean)
  await Promise.all(unique.map((userId) => publishToUser(userId, event)))
}

/**
 * Subscribe to one user's channel. Returns an unsubscribe function that MUST be
 * called (the SSE route calls it when the client disconnects), or the hub keeps
 * the listener for the life of the process.
 */
export async function subscribeUser(
  userId: string,
  onEvent: (envelope: EventEnvelope) => void,
): Promise<() => Promise<void>> {
  const release = hub.subscribe(userChannel(userId), (payload) => {
    if (!payload || typeof payload !== 'object') {
      console.warn('[events] dropping malformed envelope')
      return
    }
    onEvent(payload as EventEnvelope)
  })
  return async () => release()
}
