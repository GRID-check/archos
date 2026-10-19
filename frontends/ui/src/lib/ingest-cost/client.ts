/**
 * The typed client for `GET /api/documents/{id}/ingest-cost` (ADR-0055): what one
 * document is expected to cost to ingest, the threshold in force, and whether a
 * person should be asked before the spend.
 *
 * A client module rather than a `fetch` at each call site, for the reason
 * ADR-0055 gives: the path, the verb and the response shape are written once, so
 * the dialog, a later task and any integration that follows are equal clients of
 * one HTTP API rather than three that can quietly disagree. Responses are parsed
 * (`./types`), not cast — a server a deploy ahead is a runtime disagreement, not
 * a compiler one.
 *
 * The fetch is injected so a route spec can drive the real handler through this
 * function; the browser gets the global `fetch`.
 */

import { parseDocumentIngestCost, type DocumentIngestCost } from './types'

export type { DocumentIngestCost }

/** How a request is made; injected so a spec can call the handler instead of the network. */
export type IngestCostFetch = (path: string, init?: RequestInit) => Promise<Response>

const defaultFetch: IngestCostFetch = (path, init) => fetch(path, init)

/** Thrown when the API refuses the read, carrying the status so the caller can tell a 404 from an outage. */
export class IngestCostError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'IngestCostError'
  }
}

export async function readIngestCost(
  documentId: string,
  fetchImpl: IngestCostFetch = defaultFetch
): Promise<DocumentIngestCost> {
  const response = await fetchImpl(`/api/documents/${encodeURIComponent(documentId)}/ingest-cost`)
  if (!response.ok) throw new IngestCostError(response.status, `ingest cost ${response.status}`)
  return parseDocumentIngestCost(await response.json())
}
