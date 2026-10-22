import 'server-only'
/**
 * What the agent door's listeners hear: that a project's overview changed, or
 * that the projects an office lists did (ADR-0122, "Listening").
 *
 * The same shape as the shelf hints (`documents/shelf-live.ts`): a hint on the
 * hub (`realtime/hub.ts`, Dragonfly across pods, in-process without it) that the
 * receiver answers by reading again, as itself. Nothing but the URI of a
 * resource travels, and every event names its organization: the door delivers
 * an event only to a listener of that organization, and only for a URI that
 * listener was allowed to read when it subscribed (`door/index.ts`).
 *
 * Called AFTER the write has committed, never inside its transaction: a client
 * re-reads at once, and a read that beats the commit sees the old project.
 * Fire and forget and never throws, for the reason the shelf's publisher gives.
 */

import { z } from 'zod'
import { publish } from '@/lib/realtime/hub'

/** The one hub topic every door listener of every pod hears. */
export const DOOR_EVENTS_TOPIC = 'rt:door:events'

/** The URI an agent attaches a project by; `door/index.ts` registers the template. */
export const PROJECT_URI_PREFIX = 'piloti://project/'

export const projectResourceUri = (projectId: string): string => `${PROJECT_URI_PREFIX}${projectId}`

const organizationId = z.string().min(1)

export const doorEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('resource_updated'), organizationId, uri: z.string().min(1) }),
  z.object({ kind: z.literal('resources_list_changed'), organizationId }),
])
export type DoorEvent = z.infer<typeof doorEventSchema>

function announce(event: DoorEvent): void {
  try {
    void publish(DOOR_EVENTS_TOPIC, event).catch((error: unknown) => console.warn('[mcp] could not announce a change:', error))
  } catch (error) {
    console.warn('[mcp] could not announce a change:', error)
  }
}

/** A project's overview changed: its name, status, profile, documents or members. */
export function publishProjectChanged(orgId: string, projectId: string): void {
  announce({ kind: 'resource_updated', organizationId: orgId, uri: projectResourceUri(projectId) })
}

/** The projects an office lists changed: one was created, deleted, restored or renamed. */
export function publishProjectListChanged(orgId: string): void {
  announce({ kind: 'resources_list_changed', organizationId: orgId })
}
