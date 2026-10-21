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
 * folder that does not count does not count either.
 *
 * ## When it is counted
 *
 * When a turn that asks about filing or finding finds the stored fingerprint
 * stale, it claims the refresh (at most once per {@link REFRESH_MIN_INTERVAL_MS}
 * per organization) and starts it detached, and is answered from the previous
 * count: no turn waits on one backend listing per project. The refresh is not
 * a `bff_job_queue` kind on purpose: it is derived, idempotent and replaced
 * whole, so a refresh lost to a restart costs nothing the next stale read does
 * not redo, and a queue row would add durability nobody needs.
 *
 * `GRID_OFFICE_CONVENTIONS=on` switches it on; off (the default), nothing here
 * runs and the turn context is what it was.
 */

import 'server-only'
import { folderTree, isUnderOwnList } from '@/lib/authz/folder-access-rule'
import { hasPassedScreening } from '@/lib/documents/document-reader'
import { reconcileDocumentStatuses } from '@/lib/documents/reconcile-status'
import { documentTypeOf } from '@/lib/documents/tag-vocabulary'
import { listProjectsFolders, type OfficeFolderRow } from '@/lib/filing/repository'
import { listProjectsInOrg } from '@/lib/projects/repository'
import {
  EXTRACTOR_VERSION,
  extractOfficeConventions,
  type ConventionDocument,
  type ConventionFolder,
  type OfficeConventions,
} from './extract'
import { asksWhereThingsAre, officeConventionsHeader, renderOfficeConventions } from './render'
import {
  claimOfficeConventionsRefresh,
  listConventionDocuments,
  officeSourceFingerprint,
  readOfficeConventions,
  writeOfficeConventions,
} from './repository'

/** How many of the office's most recent projects the conventions are counted from. */
export const MAX_PROJECTS = 30

/** At most one refresh per organization in this window, however often the office changes. */
export const REFRESH_MIN_INTERVAL_MS = 10 * 60 * 1000

/** Whether the deployment learns and shows the office's conventions. Off unless switched on. */
export function officeConventionsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.GRID_OFFICE_CONVENTIONS ?? '').trim().toLowerCase() === 'on'
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

/** Count the office's conventions again and replace its record. What was counted, for the log line. */
export async function refreshOfficeConventions(organizationId: string): Promise<OfficeConventions> {
  // Read before the rows, so a change made during the count leaves the record stale.
  const fingerprint = await officeSourceFingerprint(organizationId)
  const projectIds = (await listProjectsInOrg(organizationId, { limit: MAX_PROJECTS })).map((project) => project.id)
  const [folderRows, rows] = await Promise.all([
    listProjectsFolders(organizationId, projectIds),
    listConventionDocuments(organizationId, projectIds),
  ])
  const folders = openFolders(folderRows)
  const enriched = await reconcileDocumentStatuses(rows, organizationId)
  const documents = enriched
    .filter(hasPassedScreening)
    .map((row) => conventionDocumentOf(row, folders))
    .filter((doc): doc is ConventionDocument => doc !== null)
  const conventions = extractOfficeConventions({ documents, folders: [...folders.values()] })
  await writeOfficeConventions(organizationId, {
    conventions,
    extractorVersion: EXTRACTOR_VERSION,
    sourceFingerprint: fingerprint,
  })
  console.debug(
    `[office-conventions] ${organizationId}: ${conventions.projects} projects, ${documents.length} documents, ` +
      `${conventions.folders.length} folders, ${conventions.filing.length} filing lines`
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
 * The convention lines for a turn, header first, or null: when the switch is
 * off, the question is not about filing or finding, or nothing was learned yet.
 * A stale record is still served while its refresh runs.
 */
export async function officeConventionsForTurn(organizationId: string, query: string | null | undefined) {
  if (!officeConventionsEnabled() || !asksWhereThingsAre(query)) return null
  const [row, fingerprint] = await Promise.all([
    readOfficeConventions(organizationId),
    officeSourceFingerprint(organizationId),
  ])
  if (isStale(row, fingerprint)) await requestOfficeConventionsRefresh(organizationId)
  const conventions = row?.extractorVersion === EXTRACTOR_VERSION ? row.conventions : null
  if (!conventions) return null
  const lines = renderOfficeConventions(conventions)
  return lines.length > 0 ? [officeConventionsHeader(conventions.projects), ...lines] : null
}
