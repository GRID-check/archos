/**
 * `GET /api/projects/[id]/document-findings`: its query and its answer, shared
 * by the route, the MCP catalog (`lib/agent-api/catalog/folders.ts`) and the
 * browser (`features/documents/hooks/use-document-findings.ts`).
 */

import { z } from 'zod'
import type { DocumentFinding, IncomingReference, ResolvedReference } from './findings'

export const documentFindingsQuerySchema = z.object({
  documentId: z
    .string()
    .guid()
    .optional()
    .describe(
      "A document id from document-list. With it, `document` carries that document's references resolved to the " +
        "project's documents and the documents that point at it."
    ),
})

export type DocumentFindingsQuery = z.infer<typeof documentFindingsQuerySchema>

/** One document's references, resolved for the reader. */
export interface DocumentLinks {
  references: ResolvedReference[]
  referencedBy: IncomingReference[]
}

export interface DocumentFindingsResponse {
  findings: DocumentFinding[]
  /** How many of the project's documents the findings were read from. */
  documentCount: number
  /** The project holds more documents than one read covers; the findings speak for the newest. */
  truncated: boolean
  /** Present when `documentId` was asked for and the reader may see it. */
  document: DocumentLinks | null
}
