/**
 * The Fassung facts of documents, resolved for ONE reader.
 *
 * The backend stores a Fassung link by file name. This is the only place a name
 * becomes a document the browser is told about, and it does so through the same
 * rules a listing applies: the documents of the SAME collection, active, past
 * screening for this reader (`documentVisibleTo`, ADR-0086), and not in a
 * folder this session may not open (ADR-0087; the Papierkorb counts as closed).
 * What fails any of them is dropped with its name (`resolveFassungFacts`).
 *
 * Kept apart from `reconcile-status.ts` on purpose. That module's metadata is
 * spread onto rows several callers hand out, with no reader in sight; a file
 * name there would be one forgotten destructure away from the wire.
 */

import 'server-only'
import type { AuthorizedSession } from '@/lib/auth/types'
import { getHiddenFolderIds } from '@/lib/authz/folder-access'
import { collectionFileRef, type AuthoredDocumentRow } from './collection-file-ref'
import type { DocumentReader } from './document-reader'
import {
  EMPTY_FASSUNG,
  FASSUNG_MAX_HISTORY,
  referencedNames,
  resolveFassungFacts,
  type FassungFacts,
  type FassungHistoryEntry,
  type FassungNames,
  type FassungRef,
} from './fassung'
import { documentNameKey } from './name-match'
import { readFassungNames, refreshCollectionFiles } from './reconcile-status'
import { findFassungCounterparts, type FassungCounterpartRow } from './repository'

/** A document to read the Fassung facts of: the row facts `collectionFileRef` needs, and its id. */
export interface FassungSubject extends AuthoredDocumentRow {
  id: string
}

/** The counterparts the session may open, by name key: the documents one collection's names resolve to. */
async function visibleRefs(
  session: AuthorizedSession,
  collectionName: string,
  filenames: readonly string[],
  reader: DocumentReader,
): Promise<Map<string, VisibleRef>> {
  const rows = await findFassungCounterparts(session.organizationId, collectionName, filenames, reader)
  const hidden = await hiddenFoldersByProject(session, rows)
  const refs = new Map<string, VisibleRef>()
  for (const row of rows) {
    const closed = row.projectId !== null && row.folderId !== null && hidden.get(row.projectId)?.has(row.folderId)
    if (closed) continue
    refs.set(documentNameKey(row.filename), {
      id: row.id,
      filename: row.filename,
      // Coerced at the boundary: a driver handing back a string must not reach `toISOString`.
      createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
    })
  }
  return refs
}

/** A counterpart the reader may open, with the one row fact the history shows. */
interface VisibleRef extends FassungRef {
  createdAt: string | null
}

/** The backend's names of one file of a collection, addressed the way `collectionFileRef` addresses a person's upload. */
const namesOf = (collectionName: string, filename: string): Promise<FassungNames | null> => {
  const ref = collectionFileRef({ collectionName, filename, authoredBy: 'user', publishedVersionId: null })
  return ref ? readFassungNames(ref) : Promise.resolve(null)
}

/**
 * The older Fassungen behind `names`, by the backend's names, newest first: the
 * documents it replaces, then the ones THEY replace, breadth first. Cycle-safe
 * and bounded; the reader's visibility is applied afterwards, like every other
 * name here. Each comes with its own names, for its change line.
 */
async function walkHistory(
  collectionName: string,
  ownName: string,
  names: FassungNames,
): Promise<Array<{ filename: string; names: FassungNames | null }>> {
  const seen = new Set<string>([documentNameKey(ownName)])
  const walked: Array<{ filename: string; names: FassungNames | null }> = []
  let frontier = names.supersedes
  while (frontier.length > 0 && walked.length < FASSUNG_MAX_HISTORY) {
    const next: string[] = []
    for (const filename of frontier) {
      const key = documentNameKey(filename)
      if (seen.has(key) || walked.length >= FASSUNG_MAX_HISTORY) continue
      seen.add(key)
      const own = await namesOf(collectionName, filename)
      walked.push({ filename, names: own })
      next.push(...(own?.supersedes ?? []))
    }
    frontier = next
  }
  return walked
}

/** The folders this session may not open, per project the rows belong to. */
async function hiddenFoldersByProject(
  session: AuthorizedSession,
  rows: readonly FassungCounterpartRow[],
): Promise<Map<string, ReadonlySet<string>>> {
  const projectIds = [
    ...new Set(rows.filter((row) => row.folderId !== null).map((row) => row.projectId)),
  ].filter((id): id is string => id !== null)
  const hidden = await Promise.all(projectIds.map((projectId) => getHiddenFolderIds(session, projectId)))
  return new Map(projectIds.map((projectId, index) => [projectId, new Set(hidden[index])]))
}

/**
 * The Fassung facts of `subjects` for `session`, by document id. A document with
 * nothing to say (or nothing the reader may see) has no entry.
 *
 * `reader` is the one the rows were read with, so a document held from the
 * reader is held here as well. `fresh` reads the backend listing anew, for the
 * answer to a write that the cached listing predates.
 */
export async function loadFassungFacts(
  session: AuthorizedSession,
  subjects: readonly FassungSubject[],
  reader: DocumentReader,
  { fresh = false }: { fresh?: boolean } = {},
): Promise<Map<string, FassungFacts>> {
  const facts = new Map<string, FassungFacts>()
  if (fresh) {
    const collections = new Set<string>()
    for (const subject of subjects) if (collectionFileRef(subject)) collections.add(subject.collectionName)
    await Promise.all([...collections].map((collection) => refreshCollectionFiles(collection)))
  }

  const named: Array<{ subject: FassungSubject; names: FassungNames }> = []
  await Promise.all(
    subjects.map(async (subject) => {
      const ref = collectionFileRef(subject)
      const names = ref ? await readFassungNames(ref) : null
      if (names) named.push({ subject, names })
    }),
  )
  if (named.length === 0) return facts

  const wanted = new Map<string, Set<string>>()
  for (const { subject, names } of named) {
    const set = wanted.get(subject.collectionName) ?? new Set<string>()
    for (const filename of referencedNames(names, subject.filename)) set.add(filename)
    wanted.set(subject.collectionName, set)
  }
  const histories = new Map<string, Array<{ filename: string; names: FassungNames | null }>>()
  await Promise.all(
    named.map(async ({ subject, names }) => {
      if (names.supersedes.length === 0) return
      const walked = await walkHistory(subject.collectionName, subject.filename, names)
      histories.set(subject.id, walked)
      const set = wanted.get(subject.collectionName) ?? new Set<string>()
      for (const step of walked) {
        set.add(step.filename)
        for (const filename of step.names?.supersedes ?? []) set.add(filename)
      }
      wanted.set(subject.collectionName, set)
    }),
  )
  const refsByCollection = new Map<string, Map<string, VisibleRef>>()
  await Promise.all(
    [...wanted].map(async ([collectionName, filenames]) => {
      refsByCollection.set(
        collectionName,
        filenames.size === 0 ? new Map() : await visibleRefs(session, collectionName, [...filenames], reader),
      )
    }),
  )

  for (const { subject, names } of named) {
    const refs = refsByCollection.get(subject.collectionName)
    const lookup = (filename: string): FassungRef | null => {
      const ref = refs?.get(documentNameKey(filename))
      return ref ? { id: ref.id, filename: ref.filename } : null
    }
    const resolved = resolveFassungFacts(names, subject.filename, lookup)
    const history = historyFor(histories.get(subject.id) ?? [], refs, lookup)
    // A hidden direct predecessor leaves the document's own facts empty, while
    // older Fassungen behind it may still be the reader's to see.
    if (history.length > 0) facts.set(subject.id, { ...(resolved ?? EMPTY_FASSUNG), history })
    else if (resolved) facts.set(subject.id, resolved)
  }
  return facts
}

/**
 * The walked history as the reader may see it: a Fassung they may not open is
 * left out with its name, and so is a change line that describes one (the same
 * rule `resolveFassungFacts` applies to the document's own facts).
 */
function historyFor(
  walked: ReadonlyArray<{ filename: string; names: FassungNames | null }>,
  refs: Map<string, VisibleRef> | undefined,
  lookup: (filename: string) => FassungRef | null,
): FassungHistoryEntry[] {
  const entries: FassungHistoryEntry[] = []
  for (const step of walked) {
    const ref = refs?.get(documentNameKey(step.filename))
    if (!ref) continue
    const own = resolveFassungFacts(step.names, step.filename, lookup)
    entries.push({ ...ref, changeSummary: own?.changeSummary?.text ?? null })
  }
  return entries
}
