/**
 * The filing judgement's wire contract with `POST /v1/filing-fit`
 * (`frontends/aiq_api/src/aiq_api/routes/filing_fit.py`), and what the BFF
 * keeps of the answer. The request is built here; the answer is parsed here
 * and never trusted: `keepKnownMoves` (`./judge`) drops anything that names a
 * document or a folder the request did not send.
 *
 * No `server-only`: the specs and the preview import it.
 */

import { z } from 'zod'
import type { FilingBasis } from '@/lib/proposals/types'

export type { FilingBasis }

/** Most documents one judgement reads: one batch, one bounded call (`MAX_DOCUMENTS` in the route). */
export const MAX_JUDGED_DOCUMENTS = 60
/** Most folders of a shelf one judgement reads (`MAX_FOLDERS`). */
export const MAX_JUDGED_FOLDERS = 300
/** Most office conventions one judgement reads (`MAX_CONVENTIONS`). */
export const MAX_JUDGED_CONVENTIONS = 80
/** Most Dokumentarten named per folder. */
export const MAX_FOLDER_DOC_TYPES = 3

/** A folder of the shelf, open to every reader of it. */
export interface FilingFolderInput {
  path: string
  description: string | null
  /** The Dokumentarten already filed there, most frequent first. */
  docTypes: string[]
}

/** A folder the office uses in its other projects (or the Austrian default); proposing it creates it. */
export interface FilingConventionInput {
  path: string
  description: string | null
  /** How many of the office's projects use it; 0 for the default. */
  projects: number
  docTypes: string[]
}

/** One document of the batch: what ingestion produced about it, never its bytes. */
export interface FilingDocumentInput {
  id: string
  file: string
  /** The folder it landed in; `''` is the shelf root. */
  folder: string
  /** Its Dokumentart: a person's tag or ingestion's, the type tag of its controlled tags. */
  type: string | null
  /** Its other controlled tags (the OIB disciplines). */
  tags: string[]
  summary: string | null
}

export interface FilingJudgementInput {
  basis: FilingBasis
  locale: string
  folders: FilingFolderInput[]
  conventions: FilingConventionInput[]
  documents: FilingDocumentInput[]
  trace: { batchId: string; projectId: string | null; shelf: 'project' | 'office_shelf' }
}

/** The route's answer, as it is parsed. Anything else is no answer. */
export const filingFitResponseSchema = z.object({
  moves: z
    .array(
      z.object({
        id: z.string(),
        folder: z.string(),
        reason: z.string(),
        new: z.boolean().optional(),
        description: z.string().nullish(),
      })
    )
    .default([]),
  model: z.string().nullish(),
  error: z.string().nullish(),
  trace_id: z.string().nullish(),
})

/** One document Piloti would file elsewhere, checked against the input. */
export interface FilingMove {
  documentId: string
  /** The target as the input spelled it. */
  folder: string
  reason: string
  /** A convention the shelf does not have yet: applying the proposal creates it. */
  newFolder: { description: string | null } | null
}

export interface FilingJudgement {
  moves: FilingMove[]
  /** The generation's trace, for the decision score; null when tracing is off or the call never ran. */
  traceId: string | null
  /** Why there is no judgement (`llm_not_configured`, `backend_502`, …); null when there is one, empty or not. */
  error: string | null
}
