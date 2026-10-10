/**
 * Which documents on a shelf a set of dropped names would be the next Fassung of
 * (CONTEXT.md, „Fassung"; ADR-0098).
 *
 * The upload dialog asks this before anything is stored, and offers „Als neue
 * Fassung von X ablegen" for every name that continues a document. The grammar
 * is `revision-series.ts`; this module is the part that needs the database and
 * the reader:
 *
 *   - only documents the reader may see (held uploads and closed folders are
 *     not named to them), active, person-uploaded, on THIS shelf;
 *   - a document a person already replaced is not what a new file continues
 *     (`superseded_by` on the backend's row, read by name and never sent on);
 *   - the answer carries the document's id and name for the reader who may open
 *     it, and nothing else about it.
 *
 * The decision itself is not made here. A tick in the dialog is the person's;
 * `uploadToShelf` checks it again before the ingest job writes the link.
 */

import 'server-only'
import type { AuthorizedSession } from '@/lib/auth/types'
import { getHiddenFolderIds } from '@/lib/authz/folder-access'
import { requireProjectAccess } from '@/lib/authz/projects'
import { shelfReaderFor } from '@/lib/upload-screening/quarantine-reviewers'
import { collectionFileRef } from './collection-file-ref'
import type { DocumentReader } from './document-reader'
import { findFassungSeriesRows, type FassungSeriesRow } from './fassung-candidates-repository'
import type { FassungCandidateMatch } from './name-probe-types'
import { readFassungNames } from './reconcile-status'
import { findFassungCandidate, parseRevisionName, revisionSeriesKeyOf } from './revision-series'
import { projectShelf, type DocumentShelf } from './shelf'

/** Series one probe looks up: a folder of two thousand drawings is a handful of series, not two thousand. */
export const FASSUNG_PROBE_MAX_SERIES = 200
/** Words one query ORs together. */
const WORDS_PER_QUERY = 50
/** Shortest word worth narrowing the shelf by: shorter ones match half of it. */
const MIN_WORD_LENGTH = 3

interface DroppedSeries {
  names: string[]
  word: string
}

/**
 * The dropped names that read as part of a series, grouped by series, each with
 * the word the shelf is narrowed by. A name with no index or date, or with no
 * word of three plain characters to narrow by, continues nothing.
 */
function seriesOf(names: readonly string[]): Map<string, DroppedSeries> {
  const series = new Map<string, DroppedSeries>()
  for (const name of new Set(names)) {
    const key = revisionSeriesKeyOf(name)
    const revision = parseRevisionName(name)
    if (!key || !revision) continue
    const known = series.get(key)
    if (known) {
      known.names.push(name)
      continue
    }
    if (series.size >= FASSUNG_PROBE_MAX_SERIES) continue
    // Plain letters and digits only: a word with an umlaut may be stored composed or decomposed.
    const word = (revision.key.match(/[a-z0-9]+/g) ?? []).reduce((longest, run) => (run.length > longest.length ? run : longest), '')
    if (word.length >= MIN_WORD_LENGTH) series.set(key, { names: [name], word })
  }
  return series
}

/** The rows of the shelf that share a word with some dropped series, each document once. */
async function narrowedRows(
  shelf: DocumentShelf,
  organizationId: string,
  words: readonly string[],
  options: { hiddenFolderIds?: readonly string[]; reader: DocumentReader },
): Promise<FassungSeriesRow[]> {
  const byId = new Map<string, FassungSeriesRow>()
  for (let start = 0; start < words.length; start += WORDS_PER_QUERY) {
    for (const row of await findFassungSeriesRows(shelf, organizationId, words.slice(start, start + WORDS_PER_QUERY), options)) {
      byId.set(row.id, row)
    }
  }
  return [...byId.values()]
}

/** Whether a person has already replaced this document with another: it is no longer what a new file continues. */
async function isReplaced(row: FassungSeriesRow): Promise<boolean> {
  const ref = collectionFileRef(row)
  const names = ref ? await readFassungNames(ref) : null
  return Boolean(names?.supersededBy)
}

/**
 * What each of `names` continues on `shelf`, for the names that continue
 * something; the others have no entry.
 */
export async function fassungCandidatesOnShelf(
  shelf: DocumentShelf,
  organizationId: string,
  names: readonly string[],
  options: { hiddenFolderIds?: readonly string[]; reader: DocumentReader },
): Promise<FassungCandidateMatch[]> {
  const series = seriesOf(names)
  if (series.size === 0) return []
  const rows = await narrowedRows(shelf, organizationId, [...new Set([...series.values()].map((entry) => entry.word))], options)

  const bySeries = new Map<string, FassungSeriesRow[]>()
  for (const row of rows) {
    const key = revisionSeriesKeyOf(row.filename)
    if (!key || !series.has(key)) continue
    bySeries.set(key, [...(bySeries.get(key) ?? []), row])
  }

  const matches: FassungCandidateMatch[] = []
  for (const [key, dropped] of series) {
    const members = bySeries.get(key) ?? []
    const replaced = await Promise.all(members.map(isReplaced))
    const current = members
      .filter((_, index) => !replaced[index])
      .map((row) => ({ row, filename: row.filename, createdAt: row.createdAt ? row.createdAt.toISOString() : null }))
    if (current.length === 0) continue
    for (const name of dropped.names) {
      const candidate = findFassungCandidate(name, current)
      if (!candidate) continue
      matches.push({
        name,
        candidates: candidate.candidates.map(({ item, label }) => ({
          id: item.row.id,
          filename: item.row.filename,
          displayName: item.row.displayName,
          label,
        })),
        newer: candidate.newer,
        unambiguous: candidate.unambiguous,
      })
    }
  }
  return matches
}

/**
 * What the dropped names continue on a project's shelf. Same gate as the name
 * probe and the listing: a `project:view` reader is told of documents they can
 * already page through, outside the folders closed to them.
 */
export async function probeProjectFassungCandidates(
  session: AuthorizedSession,
  projectId: string,
  names: readonly string[],
): Promise<FassungCandidateMatch[]> {
  await requireProjectAccess(session, projectId, 'project:view')
  return fassungCandidatesOnShelf(projectShelf(projectId), session.organizationId, names, {
    hiddenFolderIds: await getHiddenFolderIds(session, projectId),
    reader: await shelfReaderFor(session, { scope: 'project', projectId }),
  })
}
