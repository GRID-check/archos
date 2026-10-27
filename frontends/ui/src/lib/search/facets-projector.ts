/**
 * Write the search rows of documents whose reading is known (ADR-0136): the
 * one door into `document_search_facets`. Called where a document settles
 * (`reconcileDocumentStatuses`) and by the shelf's backstop refresh
 * (`./shelf-projection.ts`). A reading the listing did not carry writes
 * nothing, so a degraded listing never blanks a row.
 */

import 'server-only'
import type { DocumentMetadata } from '@/lib/documents/reconcile-status'
import { toSearchFacets } from './facets'
import { upsertSearchFacets } from './facets-repository'

/** One document's reading, as the caller already holds it. */
export interface DocumentReading {
  documentId: string
  metadata: DocumentMetadata | null
  superseded: boolean
}

/** Project `readings` into their search rows; how many rows changed. */
export async function projectReadings(organizationId: string, readings: readonly DocumentReading[]): Promise<number> {
  const rows = readings.flatMap((reading) => {
    const row = toSearchFacets(
      { documentId: reading.documentId, organizationId, superseded: reading.superseded },
      reading.metadata
    )
    return row ? [row] : []
  })
  return upsertSearchFacets(organizationId, rows)
}
