/**
 * The body of `POST /api/holds`, shared by the route and the MCP catalog
 * (`lib/agent-api/catalog/folders.ts`).
 */

import { z } from 'zod'

export const createHoldSchema = z.object({
  entityType: z.enum(['project', 'document', 'conversation', 'organization', 'user', 'folder']),
  entityId: z.string().min(1),
  reason: z.string().min(1).max(2000),
})
