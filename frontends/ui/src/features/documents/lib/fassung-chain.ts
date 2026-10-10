/**
 * A document and its Fassungen, as the workspace shows them: ONE entry.
 *
 * Across different file names a Fassung is stored as a link between two
 * documents (ADR-0097), but a person sees one document with a history. So the
 * listing shows the current Fassung only, counts how many it has, and leaves
 * the older ones out unless asked for them; opening the document lists them in
 * its timeline (`document-fassungen.tsx`). Same-name versions (ADR-0054) never were
 * separate entries; they are counted on the document itself (`versionCount`).
 *
 * Pure: no React, no I/O. Reads only what the listing carries
 * (`FileItem.fassung`, resolved for this reader by the BFF).
 */

import type { FileItem } from '../file-types'

/**
 * Whether the listing leaves `file` out by default: a person confirmed a newer
 * Fassung of it, and that newer one is in the same listing. When the newer one
 * is not there (a folder the reader may not open, a filter, the drain's page
 * ceiling), the older stays visible, or it would vanish without a trace.
 */
export function isOlderFassung(file: FileItem, listedIds: ReadonlySet<string>): boolean {
  const newer = file.fassung?.supersededBy
  return newer != null && listedIds.has(newer.id)
}

/** The files a listing shows: every current Fassung, and the older ones only when asked for. */
export function withoutOlderFassungen(files: readonly FileItem[], showOlder: boolean): readonly FileItem[] {
  if (showOlder) return files
  const ids = new Set(files.map((file) => file.id))
  return files.filter((file) => !isOlderFassung(file, ids))
}

/**
 * How many Fassungen a document has under different names, itself included, or
 * 1 when it has none: the number the entry's badge shows. Read from the history
 * the BFF walked (every older Fassung the reader may open), or from the direct
 * links when a surface has no history.
 */
export function fassungCount(file: FileItem): number {
  const facts = file.fassung
  if (!facts) return 1
  const older = facts.history?.length ?? facts.supersedes.length
  return older + 1
}
