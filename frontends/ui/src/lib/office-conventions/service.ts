/**
 * The office's conventions (ADR-0129): counted from its projects by
 * `./extract`, kept on one row per organization, and handed to a turn that
 * asks about filing or finding.
 *
 * ## What counts
 *
 * The office's {@link MAX_PROJECTS} most recent projects; their living folders,
 * except one under an own access list and everything below it (ADR-0087,
 * ADR-0088); their ingested documents that passed screening (ADR-0086), with
 * the Dokumentart and the title-block facts the backend read. A document in a
 * folder that does not count does not count either. A move a person accepted (an applied `file_operation`
 * proposal) counts for its Dokumentart's line. The office's decisions (`./lines`)
 * apply when the lines are read: declined lines never reach the agent,
 * confirmed ones always do.
 *
 * ## When it is counted
 *
 * When a turn that asks about filing or finding finds the stored fingerprint
 * stale (the office's fingerprint is read at most once a minute per process), it claims the refresh (at most once per {@link REFRESH_MIN_INTERVAL_MS}
 * per organization) and starts it detached, and is answered from the previous
 * count: no turn waits on one backend listing per project. The refresh is not
 * a `bff_job_queue` kind on purpose: it is derived, idempotent and replaced
 * whole, so a refresh lost to a restart costs nothing the next stale read does
 * not redo, and a queue row would add durability nobody needs.
 *
 * The `office-conventions` WorkOS flag switches it on per organization (an
 * entitlement, off until an operator targets the organization); off, nothing
 * here runs and the turn context is what it was.
 */

import 'server-only'
import { NotFoundError } from '@/lib/api/errors'
import { folderTree, isUnderOwnList } from '@/lib/authz/folder-access-rule'
import { FEATURE_FLAGS } from '@/lib/authz/feature-flags'
import { isOrgFeatureEnabled } from '@/lib/workos/feature-flags'
import { hasPassedScreening } from '@/lib/documents/document-reader'
import { reconcileDocumentStatuses } from '@/lib/documents/reconcile-status'
import { documentTypeOf } from '@/lib/documents/tag-vocabulary'
import { listProjectsFolders, type OfficeFolderRow } from '@/lib/filing/repository'
import { listProjectsInOrg } from '@/lib/projects/repository'
import {
  EXTRACTOR_VERSION,
  conventionPathKey,
  extractOfficeConventions,
  type ConventionDocument,
  type ConventionFolder,
  type ConventionMove,
  type OfficeConventions,
} from './extract'
import { conventionLines, resolveLines } from './lines'
import type { OfficeConventionsView } from './office-conventions-wire'
import { asksWhereThingsAre, officeConventionsHeader, renderOfficeConventions } from './render'
import {
  claimOfficeConventionsRefresh,
  deleteConventionDecision,
  listAcceptedMoves,
  listConventionDecisions,
  listConventionDocuments,
  officeSourceFingerprint,
  readOfficeConventions,
  saveConventionDecision,
  writeOfficeConventions,
  type AcceptedMove,
} from './repository'

/** How many of the office's most recent projects the conventions are counted from. */
export const MAX_PROJECTS = 30

/** At most one refresh per organization in this window, however often the office changes. */
export const REFRESH_MIN_INTERVAL_MS = 10 * 60 * 1000

/** How long a turn reuses an organization's fingerprint before it reads the two aggregates again. */
export const FINGERPRINT_TTL_MS = 60 * 1000
/** Organizations whose fingerprint one process keeps; past it the oldest is forgotten. */
const FINGERPRINT_CACHE_MAX = 1000

/**
 * The fingerprint per organization, for {@link FINGERPRINT_TTL_MS}, in this
 * process. The question that asks for conventions is broad („wo", „such…"), so
 * without it every such turn ran a `count(*)` and a `max(updated_at)` over all
 * of the office's documents and folders. A minute late is nothing for a record
 * whose refresh is rate-limited to {@link REFRESH_MIN_INTERVAL_MS} anyway.
 * Holds only a hash-like string per organization id, no tenant content.
 */
const fingerprints = new Map<string, { value: string; readAt: number }>()

async function cachedFingerprint(organizationId: string, now: number = Date.now()): Promise<string> {
  const held = fingerprints.get(organizationId)
  if (held && now - held.readAt < FINGERPRINT_TTL_MS) return held.value
  const value = await officeSourceFingerprint(organizationId)
  fingerprints.delete(organizationId)
  fingerprints.set(organizationId, { value, readAt: now })
  if (fingerprints.size > FINGERPRINT_CACHE_MAX) fingerprints.delete(fingerprints.keys().next().value as string)
  return value
}

/** Forget every cached fingerprint (tests). */
export function forgetOfficeFingerprints(): void {
  fingerprints.clear()
}

/** Whether this organization learns and shows its conventions: the `office-conventions` flag. */
export async function officeConventionsEnabled(organizationId: string): Promise<boolean> {
  return isOrgFeatureEnabled(FEATURE_FLAGS.officeConventions, organizationId)
}

/** The folders that count, by id: living, and not under an own access list. */
export function openFolders(rows: readonly OfficeFolderRow[]): Map<string, ConventionFolder> {
  const byProject = new Map<string, OfficeFolderRow[]>()
  for (const row of rows) byProject.set(row.projectId, [...(byProject.get(row.projectId) ?? []), row])
  const open = new Map<string, ConventionFolder>()
  for (const projectRows of byProject.values()) {
    const tree = folderTree(
      projectRows.map((row) => ({ id: row.id, parentId: row.parentId, accessMode: row.accessMode, everyoneReads: false }))
    )
    for (const row of projectRows) {
      if (!isUnderOwnList(tree, row.id)) open.set(row.id, { projectId: row.projectId, path: row.path })
    }
  }
  return open
}

/** The facts of one document the extractor reads, or null when it does not count. */
export function conventionDocumentOf(
  row: {
    projectId: string | null
    folderId: string | null
    filename: string
    displayName: string | null
    createdAt: Date | string
    tags?: string[] | null
    revisionFacts?: { documentNumber?: string; revision?: string }
  },
  folders: ReadonlyMap<string, ConventionFolder>
): ConventionDocument | null {
  if (!row.projectId) return null
  const folder = row.folderId ? folders.get(row.folderId) : undefined
  if (row.folderId && !folder) return null
  const docType = documentTypeOf(row.tags)
  return {
    projectId: row.projectId,
    folderPath: folder?.path ?? '',
    filename: row.displayName || row.filename,
    docType: docType && docType !== 'Sonstiges' ? docType : null,
    documentNumber: row.revisionFacts?.documentNumber ?? null,
    revision: row.revisionFacts?.revision ?? null,
    uploadedAt: new Date(row.createdAt),
  }
}

/**
 * The accepted moves that teach: the moved document is found in its project by
 * name and has a Dokumentart, and the target is a folder that counts (living,
 * not under an own access list). A move that cannot be placed teaches nothing.
 */
export function conventionMovesOf(
  accepted: readonly AcceptedMove[],
  documents: ReadonlyArray<{ projectId: string; filename: string; docType: string | null }>,
  folders: ReadonlyMap<string, ConventionFolder>
): ConventionMove[] {
  const typeByName = new Map<string, string>()
  for (const doc of documents) {
    if (doc.docType) typeByName.set(`${doc.projectId}\u0000${doc.filename.normalize('NFC').toLowerCase()}`, doc.docType)
  }
  const open = new Set([...folders.values()].map((folder) => `${folder.projectId}\u0000${conventionPathKey(folder.path)}`))
  return accepted.flatMap((move) => {
    const docType = typeByName.get(`${move.projectId}\u0000${move.document.normalize('NFC').toLowerCase()}`)
    if (!docType || !open.has(`${move.projectId}\u0000${conventionPathKey(move.folderPath)}`)) return []
    return [{ projectId: move.projectId, docType, folderPath: move.folderPath }]
  })
}

/** Count the office's conventions again and replace its record. What was counted, for the log line. */
export async function refreshOfficeConventions(organizationId: string): Promise<OfficeConventions> {
  // Read before the rows, so a change made during the count leaves the record stale.
  const fingerprint = await officeSourceFingerprint(organizationId)
  const projectIds = (await listProjectsInOrg(organizationId, { limit: MAX_PROJECTS })).map((project) => project.id)
  const [folderRows, rows, accepted] = await Promise.all([
    listProjectsFolders(organizationId, projectIds),
    listConventionDocuments(organizationId, projectIds),
    listAcceptedMoves(organizationId, projectIds),
  ])
  const folders = openFolders(folderRows)
  const enriched = await reconcileDocumentStatuses(rows, organizationId)
  const documents = enriched
    .filter(hasPassedScreening)
    .map((row) => conventionDocumentOf(row, folders))
    .filter((doc): doc is ConventionDocument => doc !== null)
  const moves = conventionMovesOf(accepted, documents, folders)
  const conventions = extractOfficeConventions({ documents, folders: [...folders.values()], moves })
  await writeOfficeConventions(organizationId, {
    conventions,
    extractorVersion: EXTRACTOR_VERSION,
    sourceFingerprint: fingerprint,
  })
  console.debug(
    `[office-conventions] ${organizationId}: ${conventions.projects} projects, ${documents.length} documents, ` +
      `${conventions.folders.length} folders, ${conventions.filing.length} filing lines, ${moves.length} accepted moves`
  )
  return conventions
}

/** Claim and start a refresh, detached. Whether one was started. Never throws. */
export async function requestOfficeConventionsRefresh(organizationId: string): Promise<boolean> {
  try {
    if (!(await claimOfficeConventionsRefresh(organizationId, REFRESH_MIN_INTERVAL_MS))) return false
    void refreshOfficeConventions(organizationId).catch((error: unknown) => {
      console.warn(`[office-conventions] refreshing ${organizationId} failed; the previous count stays:`, error)
    })
    return true
  } catch (error) {
    console.warn(`[office-conventions] claiming a refresh of ${organizationId} failed:`, error)
    return false
  }
}

/** Whether the stored record no longer describes the office. */
export function isStale(
  row: { conventions: unknown; extractorVersion: number | null; sourceFingerprint: string | null } | null,
  fingerprint: string
): boolean {
  return !row || !row.conventions || row.extractorVersion !== EXTRACTOR_VERSION || row.sourceFingerprint !== fingerprint
}

/**
 * The convention lines for a turn, header first, or null: when the flag is
 * off for the organization, the question is not about filing or finding, or nothing was learned yet.
 * A stale record is still served while its refresh runs. The office's
 * decisions apply: a declined line is not sent, a confirmed one always is.
 */
export async function officeConventionsForTurn(organizationId: string, query: string | null | undefined) {
  if (!asksWhereThingsAre(query) || !(await officeConventionsEnabled(organizationId))) return null
  const [row, fingerprint, decisions] = await Promise.all([
    readOfficeConventions(organizationId),
    cachedFingerprint(organizationId),
    listConventionDecisions(organizationId),
  ])
  if (isStale(row, fingerprint)) await requestOfficeConventionsRefresh(organizationId)
  const conventions = row?.extractorVersion === EXTRACTOR_VERSION ? row.conventions : null
  if (!conventions) return null
  const lines = renderOfficeConventions(conventions, decisions)
  return lines.length > 0 ? [officeConventionsHeader(conventions.projects), ...lines] : null
}

/**
 * What the office's conventions are, for a person: every counted line with its
 * counts and decision, and the decided lines the count no longer shows. Asks
 * for a refresh when the record is stale, like a turn does.
 */
export async function listOfficeConventions(organizationId: string): Promise<OfficeConventionsView> {
  const [enabled, row, decisions] = await Promise.all([
    officeConventionsEnabled(organizationId),
    readOfficeConventions(organizationId),
    listConventionDecisions(organizationId),
  ])
  if (enabled && isStale(row, await cachedFingerprint(organizationId))) await requestOfficeConventionsRefresh(organizationId)
  const conventions = row?.extractorVersion === EXTRACTOR_VERSION ? row.conventions : null
  return {
    enabled,
    projects: conventions?.projects ?? 0,
    computedAt: row?.computedAt ? new Date(row.computedAt).toISOString() : null,
    lines: resolveLines(conventions ? conventionLines(conventions) : [], decisions),
  }
}

/** Why a decision was refused: the key names no line the office has or had. */
export class UnknownConventionLineError extends NotFoundError {
  constructor(readonly lineKey: string) {
    super(`No convention line has the key ${lineKey}; list the lines first.`)
  }
}

/**
 * Confirm or decline a line, or take the decision back. The line must be one
 * the latest count shows or one already decided; its snapshot is kept with the
 * decision so a confirmed line outlives a recount.
 */
export async function decideOfficeConvention(
  organizationId: string,
  userId: string,
  input: { lineKey: string; decision: 'confirmed' | 'declined' | 'undecided' }
): Promise<void> {
  if (input.decision === 'undecided') return deleteConventionDecision(organizationId, input.lineKey)
  const view = (await listOfficeConventions(organizationId)).lines.find((entry) => entry.line.key === input.lineKey)
  if (!view) throw new UnknownConventionLineError(input.lineKey)
  await saveConventionDecision(organizationId, { lineKey: input.lineKey, decision: input.decision, line: view.line, decidedBy: userId })
}
