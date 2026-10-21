/**
 * The bodies of the folder routes, written once for a project's Dateien and the
 * org-wide Archiv (ADR-0078), and shared with the MCP catalog
 * (`lib/agent-api/catalog/folders.ts`) so the routes and the agent parse
 * against one schema.
 */

import { z } from 'zod'

/** `POST …/folders`. */
export const createFolderSchema = z.object({
  name: z.string().min(1).max(255),
  parentId: z.string().uuid().nullable().optional(),
})

/** `PATCH …/folders/[folderId]`. */
export const updateFolderSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    // Explicit `null` moves the folder to the shelf root, which is why this is
    // `.nullable().optional()` and not merely optional: absent and null mean
    // different things here.
    parentId: z.string().uuid().nullable().optional(),
    /**
     * What belongs in the folder (migration 0145). `null` or blank clears it.
     * Bounded above the column's 500 so the service, which folds whitespace
     * first, gives the refusal in words; this is only the untrusted edge.
     */
    description: z.string().max(2000).nullable().optional(),
  })
  .refine((body) => body.name !== undefined || body.parentId !== undefined || body.description !== undefined, {
    message: 'Nothing to update.',
  })

/** `POST …/folders/ensure`. */
export const ensureFoldersSchema = z.object({
  /**
   * The level the paths are relative to — the folder the reader was standing in
   * when they dropped the tree. `null` is the shelf root.
   */
  parentId: z.string().uuid().nullable().optional(),
  /**
   * Distinct directory paths out of the dropped tree.
   *
   * Bounded here as well as in the service: this is the untrusted edge, and the
   * service's own ceiling exists for a caller that is not a route. 4096
   * characters per path is four times the `project_folders.path` column, which
   * is the real limit a segment walk runs into.
   */
  paths: z.array(z.string().min(1).max(4096)).max(300),
})
