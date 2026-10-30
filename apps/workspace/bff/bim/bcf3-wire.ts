/**
 * The query of `GET /api/documents/{id}/annotations/bcf`, shared by the route
 * and the agent operation. No `server-only`: the catalog imports it.
 */

import { z } from 'zod'
import { ANNOTATION_EXPORT_SCOPES } from '@/lib/annotations/export-request'

/**
 * `all` (default): closed ones too, because a BCF manager filters by status and a
 * file without the closed topics cannot tell a tool they are done. `open`: only
 * what still asks something of somebody. A Vorschlag nobody took over is never
 * in the file, whatever the scope.
 */
export const bcf3QuerySchema = z.object({
  scope: z.enum(ANNOTATION_EXPORT_SCOPES).default('all').describe('all (default): closed ones too; open: what still asks something.'),
})
export type Bcf3Query = z.output<typeof bcf3QuerySchema>

export const BCF3_MEDIA_TYPE = 'application/octet-stream'
