/**
 * The query of `GET /api/ris/document`, kept out of the route file so the route
 * and the MCP catalog (`lib/agent-api/catalog/knowledge.ts`) parse against one
 * schema.
 */

import { z } from 'zod'

export const risDocumentQuerySchema = z.object({
  /**
   * A RIS document number (`NOR40217157`) or a `https://www.ris.bka.gv.at/…`
   * URL. Both are accepted because both are what a citation can carry: the
   * norm registry stores document numbers, and a retrieved hit carries the URL.
   */
  reference: z.string().min(1).max(2048),
  /** RIS application code, when a bare document number needs disambiguating. */
  application: z.string().max(32).optional(),
  /**
   * The cited passage, so an over-long document is windowed AROUND it rather
   * than clipped at its head. Published law either way — this is the same text
   * the answer already shows the reader.
   */
  passage: z.string().max(2000).optional(),
})
