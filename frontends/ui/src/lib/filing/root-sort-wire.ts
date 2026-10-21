/**
 * The body a root-sort apply takes (ADR-0121): the one schema the route
 * parses, the agent door describes (`lib/agent-api/catalog/folders.ts`) and
 * the dialog sends. A wire module: no database layer, service or `server-only`.
 */

import { z } from 'zod'
import { MAX_ROOT_SORT_DOCUMENTS } from './root-sort-types'

/** A placement the person kept: into an existing folder, a new one, or back to the root (`folderId` and `newFolderPath` null). */
export const keptMoveSchema = z.object({
  documentId: z.string().uuid(),
  folderId: z.string().uuid().nullable(),
  newFolderPath: z.string().min(1).max(1024).nullable(),
})
export type KeptMove = z.infer<typeof keptMoveSchema>

export const applyRootSortRequestSchema = z.object({
  keep: z.array(keptMoveSchema).min(1).max(MAX_ROOT_SORT_DOCUMENTS),
})
export type ApplyRootSortRequest = z.infer<typeof applyRootSortRequestSchema>
