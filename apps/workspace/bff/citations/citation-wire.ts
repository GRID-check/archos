/**
 * The request shape of `POST /api/citations/format`, shared by the route and the
 * MCP catalog (ADR-0122).
 */

import { z } from 'zod'

/** Guard rails: an answer cites a handful of sources, never hundreds. */
const MAX_ITEMS = 64

export const formatCitationsSchema = z.object({
  format: z.enum(['apa', 'bibtex', 'ris']),
  items: z.array(z.record(z.string(), z.unknown())).max(MAX_ITEMS),
})
