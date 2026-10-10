/**
 * The Fassung proposals of one upload, grouped so that a drop of forty files is
 * ONE decision and not forty (ADR-0098).
 *
 * An ArchiCAD publisher export brings every sheet again with its new index.
 * Nearly all of them continue exactly one document on the shelf; asking about
 * each would be forty checkboxes for one answer. So the proposals split in two:
 *
 *   - `detected`: the match is clear (one current document, the file is newer,
 *     nothing in the drop competes). Decided together by a master box, each row
 *     still overridable.
 *   - `unclear`: several current documents could be meant, or the file is not
 *     newer than what is there. Never ticked for the reader, each with the
 *     candidates to pick from.
 *
 * Both are sorted by the folder the file lands in, then by name, and
 * `groupByFolder` cuts them into one run per folder, so a list of forty reads
 * like the folder tree it came from. A file that is unchanged (same name and
 * same content hash) is not here at all: it is not `new`, so it has no proposal
 * and stays „unverändert, wird übersprungen" in the plan.
 *
 * A file of the SAME name is a new Fassung too (ADR-0054, ADR-0098: the
 * timeline shows both), decided by the dialog's one update box rather than per
 * row. `countNewFassungen` counts both kinds, because the confirm button says
 * how many files come in as a new Fassung, whichever way Piloti recognised it.
 *
 * Pure: no React, no I/O.
 */

import type { PlannedFile, PlannedFassung } from './folder-upload-plan'

/** A planned file known to carry a proposal. */
export type ProposedFile = PlannedFile & { fassungOf: PlannedFassung }

export interface FassungProposals {
  detected: ProposedFile[]
  unclear: ProposedFile[]
  /** The master box over `detected`: all ticked, none, or some. */
  master: 'all' | 'none' | 'some'
  /** How many of `detected` are ticked: the master box says „33 von 34". */
  ticked: number
}

const carriesProposal = (file: PlannedFile): file is ProposedFile => file.fassungOf !== undefined

/** By folder, then by name: the order of the tree the files came from. Code-point order, so it is the same everywhere. */
function byFolderThenName(a: PlannedFile, b: PlannedFile): number {
  if (a.targetPath !== b.targetPath) return a.targetPath < b.targetPath ? -1 : 1
  const left = a.file.name
  const right = b.file.name
  return left < right ? -1 : left > right ? 1 : 0
}

export function groupFassungProposals(files: readonly PlannedFile[]): FassungProposals {
  const proposed = files.filter(carriesProposal)
  const detected = proposed.filter((file) => file.fassungOf.unambiguous).sort(byFolderThenName)
  const unclear = proposed.filter((file) => !file.fassungOf.unambiguous).sort(byFolderThenName)
  const ticked = detected.filter((file) => file.fassungOf.chosen).length
  return {
    detected,
    unclear,
    master: detected.length > 0 && ticked === detected.length ? 'all' : ticked === 0 ? 'none' : 'some',
    ticked,
  }
}

/** One folder's run of proposals; `folder` is the path the files land in, empty for where the reader stands. */
export interface FolderRun {
  folder: string
  files: ProposedFile[]
}

/**
 * Cut a list already sorted by folder (`groupFassungProposals`) into one run per
 * folder, in order. A folder that appears twice in an unsorted list gets two
 * runs: the order is the caller's, never re-decided here.
 */
export function groupByFolder(files: readonly ProposedFile[]): FolderRun[] {
  const runs: FolderRun[] = []
  for (const file of files) {
    const last = runs.at(-1)
    if (last && last.folder === file.targetPath) last.files.push(file)
    else runs.push({ folder: file.targetPath, files: [file] })
  }
  return runs
}

/**
 * How many files of the plan come in as a new Fassung, given the answer to
 * „update the documents of the same name?": every same-name update that is
 * sent, and every new file whose offer is ticked.
 */
export function countNewFassungen(files: readonly PlannedFile[], includeUpdates: boolean): number {
  return files.filter((file) => (file.action === 'update' ? includeUpdates : file.fassungOf?.chosen === true)).length
}

/**
 * The one file of a loose drop that continues a document under another name,
 * or null. Asked in its own words, like the same-name single file, rather than
 * with the apparatus forty files need.
 */
export function soleProposal(files: readonly PlannedFile[]): ProposedFile | null {
  const [only] = files
  return files.length === 1 && carriesProposal(only) ? only : null
}

/**
 * The master box was clicked: tick all unless all are ticked already. A box in
 * between (`some`) ticks all, because that is what a click on a half-filled box
 * is understood to mean.
 */
export function masterTarget(master: FassungProposals['master']): boolean {
  return master !== 'all'
}

/** What the reader did to some proposals: ticked or unticked them, or picked another candidate for them. */
export interface FassungChange {
  files: readonly File[]
  chosen?: boolean
  targetId?: string
}
