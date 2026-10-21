/**
 * The body of `PUT /api/projects/[id]/folders/[folderId]/access` (ADR-0088,
 * ADR-0097), kept out of the route file (a Next route exports handlers only)
 * so the route and the MCP catalog (`lib/agent-api/catalog/folders.ts`) parse
 * against one schema.
 */

import { z } from 'zod'

/** Most people one folder's own list may name. A list longer than this is a group's job. */
export const FOLDER_ACCESS_MAX_PEOPLE = 50

const folderPersonSchema = z
  .object({
    userId: z.string().trim().min(1).max(100),
    level: z.enum(['read', 'write']),
  })
  .strict()

/** `{ mode: 'inherit' }`, or the folder's own list. */
export const folderAccessSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('inherit') }).strict(),
  z
    .object({
      mode: z.literal('custom'),
      everyoneReads: z.boolean(),
      people: z.array(folderPersonSchema).max(FOLDER_ACCESS_MAX_PEOPLE),
    })
    .strict(),
])
