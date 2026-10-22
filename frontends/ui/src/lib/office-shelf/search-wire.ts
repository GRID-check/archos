/**
 * The body of `POST /api/office-shelf/documents/search`, shared by the route
 * and the MCP catalog (`lib/agent-api/catalog/folders.ts`).
 */

import { z } from 'zod'

export const searchOfficeShelfSchema = z.object({
  q: z.string().trim().min(1).max(1000),
  topK: z.number().int().min(1).max(100).optional(),
})
