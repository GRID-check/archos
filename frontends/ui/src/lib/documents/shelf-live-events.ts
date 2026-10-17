/**
 * A shelf as a live channel hint (ADR-0110, ADR-0078): the vocabulary of
 * `shelf:<id>`, shared by the server that publishes it and the Files and
 * Archiv workspaces that read it. No `server-only`: the browser parses these.
 *
 * The hint says that the shelf's documents changed, and whether its folders
 * did too, and nothing else. The receiver re-reads the level, the counts and,
 * when told, the folder tree through the API, where the reader's own access is
 * worked out (a held upload, a restricted folder). Nothing renders from the
 * hint, so it may reach everyone who may read the shelf.
 */

import { z } from 'zod'

/**
 * The shelf as the channel names it. Structurally `DocumentShelf`
 * (`./shelf`), restated here so the browser does not import the schema.
 */
export type LiveShelf = { kind: 'project'; projectId: string } | { kind: 'archiv' }

const PROJECT_PREFIX = 'project-'
const PROJECT_ID = /^[A-Za-z0-9_-]{1,120}$/

/** The channel key a workspace opens for its shelf. The Archiv is the tenant's, so the session names it. */
export function shelfChannelKey(shelf: LiveShelf): string {
  return shelf.kind === 'archiv' ? 'shelf:archiv' : `shelf:${PROJECT_PREFIX}${shelf.projectId}`
}

/** The shelf the part of a key after `shelf:` names, or null. */
export function parseShelfChannelId(id: string): LiveShelf | null {
  if (id === 'archiv') return { kind: 'archiv' }
  if (!id.startsWith(PROJECT_PREFIX)) return null
  const projectId = id.slice(PROJECT_PREFIX.length)
  return PROJECT_ID.test(projectId) ? { kind: 'project', projectId } : null
}

/** The hub topic a shelf's hints travel on, in one tenant. */
export function shelfTopic(organizationId: string, shelf: LiveShelf): string {
  return shelf.kind === 'archiv'
    ? `rt:shelf:${organizationId}:archiv`
    : `rt:shelf:${organizationId}:project:${shelf.projectId}`
}

export const shelfEventSchema = z.object({
  kind: z.literal('shelf.changed'),
  /** The folder tree changed as well: a folder was made, renamed, moved, binned, restored or had its access set. */
  folders: z.boolean(),
})
export type ShelfEvent = z.infer<typeof shelfEventSchema>
