/**
 * Knowledge API client
 *
 * Typed fetch client for the base corpus (`/api/knowledge-base`) and the
 * reading copy of a law or regulation cited from it (`/api/ris/document`).
 * Same-origin BFF routes. The corpus status type is the service's own
 * (`lib/knowledge/service.ts`); the query is shaped by the route's zod schema in
 * `lib/ris/document-wire.ts`.
 *
 * A non-OK answer throws {@link ApiRequestError} carrying the HTTP status. The
 * caller decides what a status means: the reading copy shows a 429 as "busy" and
 * every other failure as unavailable.
 */

import type { KnowledgeBaseStatus } from '@/lib/knowledge/service'
import { ApiRequestError } from './api-error'

// ============================================================
// Types
// ============================================================

export type { KnowledgeBaseStatus }

/** A reading copy of one cited document, as `/api/ris/document` answers it. */
export interface LoadedDocument {
  url: string
  title: string
  text: string
  truncated: boolean
}

const KNOWLEDGE_BASE_PATH = '/api/knowledge-base'
const RIS_DOCUMENT_PATH = '/api/ris/document'

const failure = (context: string, status: number): ApiRequestError =>
  new ApiRequestError(`${context}: ${status}`, status)

// ============================================================
// Knowledge base
// ============================================================

/** The base corpus: its collection, its summary and every file in it. */
export const getKnowledgeBase = async (): Promise<KnowledgeBaseStatus> => {
  const response = await fetch(KNOWLEDGE_BASE_PATH)
  if (!response.ok) throw failure('Failed to load knowledge base', response.status)
  return (await response.json()) as KnowledgeBaseStatus
}

// ============================================================
// RIS reading copy
// ============================================================

/**
 * The reading copy of a cited document. `passage` travels with the request, so
 * the server picks the window of a long text where the citation points; the
 * caller trims it to the length the route accepts.
 */
export const getRisDocument = async (reference: string, passage?: string): Promise<LoadedDocument> => {
  const query = new URLSearchParams({ reference })
  if (passage) query.set('passage', passage)
  const response = await fetch(`${RIS_DOCUMENT_PATH}?${query.toString()}`)
  if (!response.ok) throw failure('Failed to load legal document', response.status)
  return (await response.json()) as LoadedDocument
}
