/**
 * The upload batches an import files into (ADR-0085, ADR-0086), so the person
 * who started it gets the same „Was ist angekommen?" summary a dropped folder
 * gets: sent once everything the import filed has been read, saying what was
 * held back by the screening and why. `mail_import.completed` says only that
 * filing ended, which is before any of it was read.
 *
 * **Nothing is stored on the import.** A batch's id is derived from the
 * import's id and a generation number, so every slice, the job a passing
 * failure hands the import on to, and the one the sweep requeues all find the
 * same batch without a column for it. The import's batch is the first
 * generation that is not sealed; a batch is opened when the first slice asks.
 *
 * **Rollover.** A batch announces at most {@link UPLOAD_BATCH_MAX_FILES}. When
 * the open one is full it is sealed and the next generation opened, so a large
 * archive yields one summary per ten thousand files. The upload sweep seals a
 * batch nothing has come into for half an hour (a long backoff); the next
 * slice then finds it sealed and opens the next generation the same way.
 *
 * **Ending.** Completed, failed or cancelled, the open batch is sealed; it
 * then completes as its last document is read.
 *
 * **Two kinds** (D35). The attachments go into the `files` batch, opened with
 * a person's upload effects: the summary, Piloti's placement review, the
 * intake reading. The Fassungen of the E-Mail-Verläufe the import writes go
 * into the `threads` batch (`ARCHIVE_THREAD_RENDER_EFFECTS`): it announces
 * what arrived too, but a Verlauf is correspondence, never the project's
 * facts, so it starts no intake reading and no placement review, and a new
 * Fassung notifies only the people with open marks on it. A batch takes its
 * effects when it is opened, so the two cannot share one.
 */

import 'server-only'
import { v5 as uuidv5 } from 'uuid'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { MailImport } from '@/lib/db/schema'
import { ARCHIVE_THREAD_RENDER_EFFECTS } from '@/lib/inbound-mail/batch-effects'
import {
  findJobUploadBatch,
  openUploadBatch,
  sealJobUploadBatch,
  UPLOAD_BATCH_MAX_FILES,
} from '@/lib/upload-batches/service'

/** The namespace import batch ids are derived in. Fixed: changing it orphans every open import's batch. */
const IMPORT_BATCH_NAMESPACE = '6f1d3c52-8a4e-4b7f-9c21-5e0a7d93b4c8'

/** Generations walked before giving up: ten million files, or a batch id someone else took each time. */
const MAX_GENERATIONS = 1_000

/** What a batch of the import carries: the attachments, or the Verläufe' Fassungen. */
export type ImportBatchKind = 'files' | 'threads'

/** The batch a slice is filing into, and how many documents carry it so far. */
export interface ImportBatch {
  id: string
  kind: ImportBatchKind
  generation: number
  documents: number
}

/** The id of an import's batch of the given kind and generation (`files` keeps the ids imports had before `threads`). */
export function importBatchId(importId: string, generation: number, kind: ImportBatchKind = 'files'): string {
  const name = kind === 'files' ? `${importId}:${generation}` : `${importId}:${kind}:${generation}`
  return uuidv5(name, IMPORT_BATCH_NAMESPACE)
}

type Generation = { generation: number; id: string; documents: number | null }

/**
 * The first generation that is not sealed: open (`documents` set), or not
 * opened yet (`documents` null). A batch with this id that is not the
 * starter's (a browser chooses its own batch id) is stepped over like a sealed one.
 */
async function firstUnsealed(row: MailImport, kind: ImportBatchKind): Promise<Generation> {
  for (let generation = 0; generation < MAX_GENERATIONS; generation += 1) {
    const id = importBatchId(row.id, generation, kind)
    const state = await findJobUploadBatch(row.organizationId, id, row.userId)
    if (state.status === 'open') return { generation, id, documents: state.documents }
    if (state.status === 'missing') return { generation, id, documents: null }
  }
  throw new Error(`no free upload batch for import ${row.id} after ${MAX_GENERATIONS} generations`)
}

/** The import's open batch of `kind`, opened now as the person who started it when there is none. */
export async function openImportBatch(
  session: AuthorizedSession,
  row: MailImport,
  kind: ImportBatchKind = 'files',
): Promise<ImportBatch> {
  const found = await firstUnsealed(row, kind)
  if (found.documents !== null) return { id: found.id, kind, generation: found.generation, documents: found.documents }
  await openUploadBatch(session, {
    id: found.id,
    scope: 'project',
    projectId: row.projectId,
    conversationId: null,
    // Unknown until the import ends; the seal announces what was filed.
    expectedCount: 0,
    // Nothing stopped yet: each mail's name-check stops are added once the
    // mail is done (`recordNameStops`, from `./filing`).
    excluded: [],
    ...(kind === 'threads' ? { effects: ARCHIVE_THREAD_RENDER_EFFECTS } : {}),
  })
  return { id: found.id, kind, generation: found.generation, documents: 0 }
}

/** `current` while it has room for one more document, else the next generation after sealing it. */
export async function importBatchWithRoom(
  session: AuthorizedSession,
  row: MailImport,
  current: ImportBatch,
): Promise<ImportBatch> {
  if (current.documents < UPLOAD_BATCH_MAX_FILES) return current
  await sealJobUploadBatch(row.organizationId, current.id, row.userId)
  return openImportBatch(session, row, current.kind)
}

/**
 * Seal the batches the import left open, of both kinds. Never throws: the
 * import's own ending must not fail on its summary, and the upload sweep seals
 * a batch nothing comes into any more.
 */
export async function sealImportBatch(row: MailImport): Promise<void> {
  for (const kind of ['files', 'threads'] as const) {
    try {
      const found = await firstUnsealed(row, kind)
      if (found.documents !== null) await sealJobUploadBatch(row.organizationId, found.id, row.userId)
    } catch (error) {
      console.error(`[mail-import] could not seal the ${kind} batch of ${row.id}; the upload sweep will:`, error)
    }
  }
}
