/**
 * Sorting a shelf's root: Piloti proposes a folder for every loose document at
 * the root of a project's Dateien or the Archiv, at any depth of the tree the
 * person built for them. The contract and the steps are in `./root-sort-types`.
 *
 * The same judgement the upload filing uses (`./judge`, `POST /v1/filing-fit`)
 * with the `sort` purpose: it places every document with a plausible home
 * rather than only the obvious ones, and the decision model scores each
 * placement so the review can mark the doubtful ones. What the judgement may
 * read is what the upload filing may read: screened documents ingestion has
 * read, and folders open to every member of the shelf (ADR-0087, ADR-0088).
 *
 * Nothing here moves a document or creates a folder. The person applies what
 * they kept through `…/folders/ensure` and `POST /api/documents/folder-moves`,
 * the services every other move goes through.
 */

import 'server-only'
import { randomUUID } from 'node:crypto'
import { BadRequestError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { getBackendUrl } from '@/lib/backend-proxy'
import type { Document } from '@/lib/db/schema'
import { hasPassedScreening, SCREENED_ONLY } from '@/lib/documents/document-reader'
import { reconcileDocumentStatuses } from '@/lib/documents/reconcile-status'
import type { DocumentShelf } from '@/lib/documents/shelf'
import { requireShelfWrite } from '@/lib/documents/shelf-authz'
import { surfaceStateOf } from '@/lib/documents/surface-state'
import { folderPathKey } from '@/lib/projects/folders'
import { isProjectClosed } from '@/lib/projects/project-status'
import { findProjectInOrg } from '@/lib/projects/repository'
import { z } from 'zod'
import { judgeFiling } from './judge'
import { findRootDocuments, listRootDocuments } from './repository'
import {
  MAX_NEW_FOLDERS,
  MAX_ROOT_SORT_DOCUMENTS,
  type NewFolderProposal,
  type NewFolders,
  type RootSortPlacement,
  type RootSortPlan,
  type RootSortScan,
} from './root-sort-types'
import {
  conventionsFor,
  documentInput,
  REASON_LOCALE,
  shelfDocTypes,
  shelfFolders,
  type ShelfFolders,
} from './service'
import { MAX_JUDGED_FOLDERS, type FilingFolderInput, type FilingMove } from './types'

/** A person waits on the grouping of every leftover document: parallel chunks, then one merge. */
const NEW_FOLDERS_TIMEOUT_MS = 150_000
/** What of a summary the new-folder call reads: it groups by name and type first. */
const NEW_FOLDER_SUMMARY_CHARS = 300

type EnrichedDocument = Document & { tags?: string[]; summary?: string }

const isJudgeable = (row: Document) => hasPassedScreening(row) && surfaceStateOf(row.status) === 'citable'

/** The shelf may be sorted by this person: they may move its documents, and a project is still running. */
async function requireSortable(session: AuthorizedSession, shelf: DocumentShelf): Promise<void> {
  await requireShelfWrite(session, shelf)
  if (shelf.kind !== 'project') return
  const project = await findProjectInOrg(shelf.projectId, session.organizationId)
  if (!project) throw new BadRequestError('Project not found.')
  if (isProjectClosed(project)) throw new BadRequestError('A closed project is not sorted.')
}

const openFoldersOf = (folders: ShelfFolders) => folders.rows.filter((row) => !folders.isRestricted(row.id))

/** The shelf's open folders and the root documents a sort may read. */
export async function scanRoot(session: AuthorizedSession, shelf: DocumentShelf): Promise<RootSortScan> {
  await requireSortable(session, shelf)
  const [folders, rows] = await Promise.all([
    shelfFolders(session, shelf),
    listRootDocuments(session.organizationId, shelf, SCREENED_ONLY, MAX_ROOT_SORT_DOCUMENTS + 1),
  ])
  const listed = rows.slice(0, MAX_ROOT_SORT_DOCUMENTS)
  const readable = listed.filter(isJudgeable)
  return {
    folders: openFoldersOf(folders).map(({ id, parentId, name, path }) => ({ id, parentId, name, path })),
    documents: readable.map((row) => ({ id: row.id, name: row.displayName ?? row.filename })),
    unreadable: listed.length - readable.length,
    truncated: rows.length > MAX_ROOT_SORT_DOCUMENTS,
  }
}

/** These root documents as the judgement may read them, with what ingestion produced about them. */
async function judgeableRootDocuments(
  session: AuthorizedSession,
  shelf: DocumentShelf,
  documentIds: readonly string[]
): Promise<EnrichedDocument[]> {
  const rows = await findRootDocuments(session.organizationId, shelf, SCREENED_ONLY, documentIds)
  const enriched = await reconcileDocumentStatuses(rows, session.organizationId)
  return enriched.filter(isJudgeable)
}

async function folderInputs(session: AuthorizedSession, shelf: DocumentShelf, folders: ShelfFolders) {
  const docTypes = await shelfDocTypes(session.organizationId, shelf, folders)
  return openFoldersOf(folders)
    .slice(0, MAX_JUDGED_FOLDERS)
    .map(
      (row): FilingFolderInput => ({
        path: row.path,
        description: row.description,
        docTypes: docTypes.get(folderPathKey(row.path)) ?? [],
      })
    )
}

/** The judgement's moves as placements: an existing folder by id, a convention by the path that creates it. */
export function placementsOf(moves: readonly FilingMove[], folders: ReadonlyArray<{ id: string; path: string }>): RootSortPlacement[] {
  const idByKey = new Map(folders.map((folder) => [folderPathKey(folder.path), folder.id]))
  return moves.flatMap((move): RootSortPlacement[] => {
    const folderId = idByKey.get(folderPathKey(move.folder)) ?? null
    if (!folderId && !move.newFolder) return []
    return [
      {
        documentId: move.documentId,
        folderId,
        newFolderPath: folderId ? null : move.folder,
        reason: move.reason,
        confidence: move.confidence,
      },
    ]
  })
}

/** Judge one chunk of root documents. A judgement that failed is `error` and no placements. */
export async function planRootChunk(
  session: AuthorizedSession,
  shelf: DocumentShelf,
  documentIds: readonly string[]
): Promise<RootSortPlan> {
  await requireSortable(session, shelf)
  const [folders, documents] = await Promise.all([
    shelfFolders(session, shelf),
    judgeableRootDocuments(session, shelf, documentIds),
  ])
  if (documents.length === 0) return { placements: [], error: null, traceId: null }
  const [inputs, conventions] = await Promise.all([
    folderInputs(session, shelf, folders),
    shelf.kind === 'project'
      ? conventionsFor(session, shelf.projectId, folders.rows.map((row) => row.path), true)
      : Promise.resolve([]),
  ])
  const judgement = await judgeFiling(session.organizationId, {
    basis: 'content',
    purpose: 'sort',
    locale: REASON_LOCALE,
    folders: inputs,
    conventions,
    documents: documents.map((row) => documentInput(row, folders, 'content')),
    trace: {
      batchId: randomUUID(),
      projectId: shelf.kind === 'project' ? shelf.projectId : null,
      shelf: shelf.kind,
    },
  })
  if (judgement.error) return { placements: [], error: judgement.error, traceId: judgement.traceId }
  return { placements: placementsOf(judgement.moves, openFoldersOf(folders)), error: null, traceId: judgement.traceId }
}

const folderProposalsResponseSchema = z.object({
  proposals: z
    .array(
      z.object({
        path: z.string(),
        description: z.string().nullish(),
        ids: z.array(z.string()),
        confidences: z.record(z.string(), z.number().min(0).max(1)).default({}),
      })
    )
    .default([]),
  error: z.string().nullish(),
  trace_id: z.string().nullish(),
})

type RawFolderProposal = z.infer<typeof folderProposalsResponseSchema>['proposals'][number]

/**
 * The proposals the input grounds: a path the shelf does not have, under the
 * root or a folder open to every member, holding at least two documents the request sent
 * and no earlier proposal took. Pure, so the rule is specced without a
 * backend; the route checks the same and this tier trusts nothing it parses.
 */
export function keepNewFolders(
  proposals: readonly RawFolderProposal[],
  shelf: { existingPaths: readonly string[]; openPaths: readonly string[] },
  documentIds: readonly string[]
): NewFolderProposal[] {
  const existing = new Set(shelf.existingPaths.map(folderPathKey))
  const parents = new Set(shelf.openPaths.map(folderPathKey))
  const known = new Set(documentIds)
  const taken = new Set<string>()
  const kept: NewFolderProposal[] = []
  for (const proposal of proposals) {
    const path = proposal.path
      .split('/')
      .map((segment) => segment.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join('/')
    const key = folderPathKey(path)
    const parent = key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : ''
    const name = path.slice(path.lastIndexOf('/') + 1)
    if (!key || existing.has(key) || (parent && !parents.has(parent)) || name.length > 255) continue
    if (kept.some((other) => folderPathKey(other.path) === key)) continue
    const ids = [...new Set(proposal.ids)].filter((id) => known.has(id) && !taken.has(id))
    if (ids.length < 2) continue
    ids.forEach((id) => taken.add(id))
    const confidences = Object.fromEntries(
      ids.flatMap((id) => (id in proposal.confidences ? [[id, proposal.confidences[id]]] : []))
    )
    kept.push({ path, description: proposal.description?.trim().slice(0, 500) || null, documentIds: ids, confidences })
    if (kept.length === MAX_NEW_FOLDERS) break
  }
  return kept
}

/** Propose new folders for the root documents no folder fits. Nothing is created. */
export async function proposeRootFolders(
  session: AuthorizedSession,
  shelf: DocumentShelf,
  documentIds: readonly string[]
): Promise<NewFolders> {
  await requireSortable(session, shelf)
  const [folders, documents] = await Promise.all([
    shelfFolders(session, shelf),
    judgeableRootDocuments(session, shelf, documentIds),
  ])
  if (documents.length < 2) return { proposals: [], error: null, traceId: null }
  const inputs = await folderInputs(session, shelf, folders)
  const body = {
    locale: REASON_LOCALE,
    folders: inputs.map((folder) => ({ path: folder.path, description: folder.description, doc_types: folder.docTypes })),
    documents: documents.map((row) => {
      const input = documentInput(row, folders, 'content')
      return {
        id: input.id,
        file: input.file,
        type: input.type,
        tags: input.tags,
        summary: input.summary?.slice(0, NEW_FOLDER_SUMMARY_CHARS) ?? null,
      }
    }),
    trace: {
      batch_id: randomUUID(),
      project_id: shelf.kind === 'project' ? shelf.projectId : null,
      shelf: shelf.kind,
    },
  }
  try {
    const response = await fetch(`${getBackendUrl()}/v1/folder-proposals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-grid-organization-id': session.organizationId },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(NEW_FOLDERS_TIMEOUT_MS),
    })
    if (!response.ok) return { proposals: [], error: `backend_${response.status}`, traceId: null }
    const parsed = folderProposalsResponseSchema.safeParse(await response.json())
    if (!parsed.success) return { proposals: [], error: 'response_malformed', traceId: null }
    const { proposals, error, trace_id: traceId } = parsed.data
    if (error) return { proposals: [], error, traceId: traceId ?? null }
    const kept = keepNewFolders(
      proposals,
      { existingPaths: folders.rows.map((row) => row.path), openPaths: openFoldersOf(folders).map((row) => row.path) },
      documents.map((row) => row.id)
    )
    return { proposals: kept, error: null, traceId: traceId ?? null }
  } catch {
    return { proposals: [], error: 'backend_unreachable', traceId: null }
  }
}
