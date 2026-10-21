/**
 * The bodies of `PATCH` and `DELETE /api/projects/[id]`, kept out of the route
 * file (a Next route exports handlers only) so the route and the MCP catalog
 * (`lib/agent-api/catalog/projects.ts`) parse against one schema.
 */

import { z } from 'zod'

export const renameProjectSchema = z.object({
  name: z.string().min(1).max(255).trim(),
})

/** Deleting asks for the project's name, as the dialog does: a person types it to confirm. */
export const deleteProjectSchema = z.object({
  confirmName: z.string().min(1),
})
