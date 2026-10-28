/**
 * The office's conventions as lines a person decides on (ADR-0129), and what
 * their decisions do to the lines the agent reads. Pure.
 *
 * A line's key is stable across recounts: it names the kind and the value (the
 * Dokumentart and its folder, one folder of the skeleton, a Plannummer shape),
 * never the counts. So a decision about "Gutachten are filed under Behörde"
 * survives the next count, and a new count that finds another folder is
 * another line.
 *
 * Confirmed beats counted: a confirmed line is kept with the snapshot taken
 * when it was confirmed, even if the next count no longer clears the threshold.
 * Declined beats everything: it never reaches the agent.
 */

import { conventionPathKey, type OfficeConventions } from './extract'
import type { ConventionDecision, ConventionLine, ConventionLineView } from './office-conventions-wire'

/** A person's decision on one line, with the line as it was when decided. */
export interface StoredDecision {
  lineKey: string
  decision: ConventionDecision
  line: ConventionLine
  decidedBy: string
  decidedAt: Date
}

const KEY_MAX = 300
const keyOf = (kind: ConventionLine['kind'], value: string): string => `${kind}:${value}`.slice(0, KEY_MAX)

/** Every line the count shows, most useful first (filing, folders, then the naming lines). */
export function conventionLines(conventions: OfficeConventions): ConventionLine[] {
  const lines: ConventionLine[] = []
  for (const entry of conventions.filing) {
    const value = `${entry.docType.normalize('NFC').toLowerCase()}>${conventionPathKey(entry.path)}`
    lines.push({ kind: 'filing', key: keyOf('filing', value), docType: entry.docType, path: entry.path, projects: entry.projects, of: entry.of })
  }
  for (const entry of conventions.folders) {
    lines.push({ kind: 'folder', key: keyOf('folder', conventionPathKey(entry.path)), path: entry.path, projects: entry.projects, of: entry.of })
  }
  const number = conventions.documentNumber
  if (number) lines.push({ kind: 'document_number', key: keyOf('document_number', number.shape), shape: number.shape, projects: number.projects, of: number.of })
  const revision = conventions.revisionStyle
  if (revision) lines.push({ kind: 'revision_style', key: keyOf('revision_style', revision.style), style: revision.style, projects: revision.projects, of: revision.of })
  const date = conventions.fileDate
  if (date) lines.push({ kind: 'file_date', key: keyOf('file_date', date.format), format: date.format, projects: date.projects, of: date.of })
  return lines
}

/**
 * The counted lines with the decisions laid over them, plus every decided line
 * the count no longer shows (so a confirmed one is kept and a declined one can
 * be taken back). Counted lines come first in their order.
 */
export function resolveLines(counted: readonly ConventionLine[], decisions: readonly StoredDecision[]): ConventionLineView[] {
  const decided = new Map(decisions.map((entry) => [entry.lineKey, entry]))
  const view = (line: ConventionLine, isCounted: boolean): ConventionLineView => {
    const entry = decided.get(line.key)
    return {
      line,
      decision: entry?.decision ?? null,
      counted: isCounted,
      decidedBy: entry?.decidedBy ?? null,
      decidedAt: entry?.decidedAt.toISOString() ?? null,
    }
  }
  const countedKeys = new Set(counted.map((line) => line.key))
  const kept = decisions.filter((entry) => !countedKeys.has(entry.lineKey)).map((entry) => view(entry.line, false))
  return [...counted.map((line) => view(line, true)), ...kept]
}

/**
 * The lines the agent may read: declined ones removed, confirmed ones kept
 * (counted or not), and a counted filing line dropped when the office
 * confirmed another folder for the same Dokumentart.
 */
export function linesForAgent(views: readonly ConventionLineView[]): ConventionLineView[] {
  const confirmedTypes = new Set(
    views.flatMap((view) => (view.decision === 'confirmed' && view.line.kind === 'filing' ? [view.line.docType.toLowerCase()] : []))
  )
  return views.filter((view) => {
    if (view.decision === 'declined') return false
    if (view.decision === 'confirmed') return true
    return !(view.line.kind === 'filing' && confirmedTypes.has(view.line.docType.toLowerCase()))
  })
}
