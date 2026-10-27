/**
 * Where a viewer action may take the person (ADR-0142): the one question the
 * browser asks the BFF before Piloti's proposal moves anything on their screen.
 *
 * `GET /api/documents/[id]/viewer-place` answers with the document's listing
 * row, read in the person's own session and through the shelf's visibility
 * (`getListedDocument`), and, for a comparison, the older Fassung's row on the
 * same shelf. A document they may not see is a 404, and the page moves nothing.
 */

import { z } from 'zod'

export const viewerPlaceQuerySchema = z.object({
  against: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe('The older revision a comparison is made against, by document id; it must sit on the same shelf.'),
})

export type ViewerPlaceQuery = z.infer<typeof viewerPlaceQuerySchema>
