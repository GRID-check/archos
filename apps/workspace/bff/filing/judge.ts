/**
 * The filing judgement: one bounded model call per upload batch, through the
 * backend's `POST /v1/filing-fit`, where the platform's model routing and the
 * Langfuse generation live (ADR-0089). This tier has no LLM client of its own.
 *
 * The request carries metadata the caller already decided the uploader and
 * every reader of the folder may see; the answer is checked here again,
 * whatever the route already checked: a document or a folder the request did
 * not name is dropped, and so is a move into the folder a document is in. A
 * failure of any kind is no judgement, and nothing is proposed.
 */

import 'server-only'
import { getBackendUrl } from '@/lib/backend-proxy'
import { folderPathKey } from '@/lib/projects/folders'
import {
  filingFitResponseSchema,
  type FilingJudgement,
  type FilingJudgementInput,
  type FilingMove,
} from './types'

/** The name basis runs while a person looks at the upload; the content basis is background. */
const TIMEOUT_MS = { name: 30_000, content: 60_000 } as const
/** A sort is a person waiting on a chunk that also asks the decision model per document. */
const SORT_TIMEOUT_MS = 90_000

type RawMove = {
  id: string
  folder: string
  reason: string
  new?: boolean
  description?: string | null
  confidence?: number | null
}

/**
 * The moves of a parsed answer that the input grounds, one per document, in
 * the input's own spelling of the folder. Pure, so the rule is specced without
 * a backend.
 */
export function keepKnownMoves(moves: readonly RawMove[], input: FilingJudgementInput): FilingMove[] {
  const documents = new Map(input.documents.map((document) => [document.id, document]))
  const existing = new Map(input.folders.map((folder) => [folderPathKey(folder.path), folder]))
  const conventions = new Map(input.conventions.map((convention) => [folderPathKey(convention.path), convention]))
  const kept: FilingMove[] = []
  const seen = new Set<string>()
  for (const move of moves) {
    const document = documents.get(move.id)
    const key = folderPathKey(move.folder)
    const reason = move.reason.replace(/\s+/g, ' ').trim().slice(0, 300)
    if (!document || seen.has(document.id) || !key || !reason) continue
    if (key === folderPathKey(document.folder)) continue
    const folder = existing.get(key)
    const convention = folder ? undefined : conventions.get(key)
    if (!folder && !convention) continue
    seen.add(document.id)
    kept.push({
      documentId: document.id,
      folder: folder?.path ?? convention?.path ?? move.folder,
      reason,
      newFolder: convention ? { description: convention.description } : null,
      confidence: move.confidence ?? null,
    })
  }
  return kept
}

/** The request body the route reads (snake_case, its pydantic model). */
export function filingFitBody(input: FilingJudgementInput): object {
  return {
    basis: input.basis,
    purpose: input.purpose ?? 'upload',
    locale: input.locale,
    folders: input.folders.map((folder) => ({
      path: folder.path,
      description: folder.description,
      doc_types: folder.docTypes,
    })),
    conventions: input.conventions.map((convention) => ({
      path: convention.path,
      description: convention.description,
      projects: convention.projects,
      doc_types: convention.docTypes,
    })),
    documents: input.documents.map((document) => ({
      id: document.id,
      file: document.file,
      folder: document.folder,
      type: document.type,
      tags: document.tags,
      summary: document.summary,
    })),
    trace: { batch_id: input.trace.batchId, project_id: input.trace.projectId, shelf: input.trace.shelf },
  }
}

/** Ask the model once for the batch. Never throws: a failure is `error` and no moves. */
export async function judgeFiling(organizationId: string, input: FilingJudgementInput): Promise<FilingJudgement> {
  if (input.documents.length === 0 || (input.folders.length === 0 && input.conventions.length === 0)) {
    return { moves: [], traceId: null, error: null }
  }
  try {
    const response = await fetch(`${getBackendUrl()}/v1/filing-fit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-grid-organization-id': organizationId },
      body: JSON.stringify(filingFitBody(input)),
      signal: AbortSignal.timeout(input.purpose === 'sort' ? SORT_TIMEOUT_MS : TIMEOUT_MS[input.basis]),
    })
    if (!response.ok) return { moves: [], traceId: null, error: `backend_${response.status}` }
    const parsed = filingFitResponseSchema.safeParse(await response.json())
    if (!parsed.success) return { moves: [], traceId: null, error: 'response_malformed' }
    const { moves, error, trace_id: traceId } = parsed.data
    if (error) return { moves: [], traceId: traceId ?? null, error }
    return { moves: keepKnownMoves(moves, input), traceId: traceId ?? null, error: null }
  } catch {
    return { moves: [], traceId: null, error: 'backend_unreachable' }
  }
}
