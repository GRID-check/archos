import 'server-only'
/**
 * The door's `ServerEventBus` over the hub (`realtime/hub.ts`): one topic every
 * pod listens to, so a change written on one pod reaches a `subscriptions/listen`
 * stream held open on another. Without `REDIS_URL` the hub is in-process, which
 * is all a single pod needs.
 *
 * The SDK's bus knows nothing of tenants, and its listen router filters only by
 * what the client asked for. Tenancy is therefore kept here: a listener is
 * registered inside {@link listeningAs} for the organization of the person who
 * listens, and hears only events of that organization (`door-events.ts` stamps
 * every event with one). A listener registered outside it hears nothing, and an
 * event without an organization (the SDK's own `handler.notify`) reaches nobody.
 * Which resource URIs a listener may name is decided before the SDK sees the
 * request (`readableProjectUris` in `door/index.ts`).
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { ServerEvent, ServerEventBus } from '@modelcontextprotocol/server'
import { DOOR_EVENTS_TOPIC, doorEventSchema } from '@/lib/realtime/door-events'
import { publish, subscribe } from '@/lib/realtime/hub'

const listeningOrganization = new AsyncLocalStorage<string>()

/** Runs `work` so that every listen stream it opens belongs to `organizationId`. */
export function listeningAs<T>(organizationId: string, work: () => T): T {
  return listeningOrganization.run(organizationId, work)
}

export class DoorEventBus implements ServerEventBus {
  /** Only a tagged event goes out; the SDK's untagged `notify.*` would reach every tenant, so it is dropped. */
  publish(event: ServerEvent): void {
    const parsed = doorEventSchema.safeParse(event)
    if (!parsed.success) return
    void publish(DOOR_EVENTS_TOPIC, parsed.data)
  }

  subscribe(listener: (event: ServerEvent) => void): () => void {
    const organizationId = listeningOrganization.getStore()
    if (!organizationId) return () => undefined
    return subscribe(DOOR_EVENTS_TOPIC, (payload) => {
      const parsed = doorEventSchema.safeParse(payload)
      if (!parsed.success || parsed.data.organizationId !== organizationId) return
      const event = parsed.data
      listener(event.kind === 'resource_updated' ? { kind: 'resource_updated', uri: event.uri } : { kind: 'resources_list_changed' })
    })
  }
}
