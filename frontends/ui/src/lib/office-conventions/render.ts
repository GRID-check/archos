/**
 * The office's conventions as the agent reads them (ADR-0129): a few bounded
 * lines in the WORKSPACE block, each with the count behind it, under a header
 * that carries the restraint. English, because the agent reads it; folder
 * names and Dokumentarten are the office's own domain data.
 *
 * Pure. `asksWhereThingsAre` decides whether a question is about filing or
 * finding, the only questions the lines are sent with.
 */

import type { OfficeConventions, RevisionStyle, Support } from './extract'

/** Most convention lines the block carries. */
export const MAX_CONVENTION_LINES = 6

/** Longest convention line. */
export const MAX_CONVENTION_LINE_CHARS = 220

/** Most skeleton folders named on the one folders line. */
const MAX_FOLDERS_NAMED = 8

/** The first line of the section; says what the lines are and how far they bind. */
export function officeConventionsHeader(projects: number): string {
  return (
    `office conventions (counted from ${projects} of the office's projects; usually, not always: ` +
    "this project's own folders and a person's choice win; propose, never move on a convention alone):"
  )
}

const REVISION_WORDS: Record<RevisionStyle, string> = {
  letter: 'letters (A, B, C)',
  number: 'numbers (1, 2, 3)',
  padded_number: 'two-digit numbers (01, 02, 03)',
  letter_number: 'a letter and a number (A1, A2)',
}

const of = (support: Support): string => `${support.projects} of ${support.of} projects`

const clip = (line: string): string =>
  line.length > MAX_CONVENTION_LINE_CHARS ? `${line.slice(0, MAX_CONVENTION_LINE_CHARS - 1)}…` : line

/** The convention lines, without the header, most useful first; empty when nothing was learned. */
export function renderOfficeConventions(conventions: OfficeConventions): string[] {
  const lines: string[] = []
  for (const entry of conventions.filing) {
    lines.push(`- ${entry.docType} usually filed under ${entry.path} (${of(entry)} that file one in a folder)`)
  }
  if (conventions.folders.length > 0) {
    const named = conventions.folders.slice(0, MAX_FOLDERS_NAMED).map((entry) => `${entry.path} (${entry.projects}/${entry.of})`)
    lines.push(`- folders most projects keep: ${named.join(', ')}`)
  }
  if (conventions.documentNumber) {
    const { shape } = conventions.documentNumber
    lines.push(`- Plannummer usually shaped ${shape} (A = letters, 0 = a digit; title blocks of ${of(conventions.documentNumber)})`)
  }
  if (conventions.revisionStyle) {
    lines.push(`- Index usually ${REVISION_WORDS[conventions.revisionStyle.style]} (${of(conventions.revisionStyle)})`)
  }
  if (conventions.fileDate) {
    lines.push(`- file names usually write a date as ${conventions.fileDate.format} (${of(conventions.fileDate)})`)
  }
  return prioritised(lines).map(clip)
}

/**
 * At most {@link MAX_CONVENTION_LINES}, keeping the naming lines (folders,
 * Plannummer, Index, date) and dropping filing lines past the budget first:
 * those are the ones a project has many of.
 */
function prioritised(lines: string[]): string[] {
  if (lines.length <= MAX_CONVENTION_LINES) return lines
  const filing = lines.filter((line) => line.includes(' usually filed under '))
  const rest = lines.filter((line) => !line.includes(' usually filed under '))
  return [...filing.slice(0, Math.max(0, MAX_CONVENTION_LINES - rest.length)), ...rest].slice(0, MAX_CONVENTION_LINES)
}

/**
 * Words that make a question one about filing or finding: where something is
 * or belongs, a folder, a name, a Plannummer or Index. German first, because
 * the office asks in German; a stem matches its inflections.
 */
const FILING_OR_FINDING =
  /\b(wo|wohin|woher|where|ablage|ablegen|abgelegt|abzulegen|einordnen|eingeordnet|einsortier\w*|verschieb\w*|ordner\w*|folder\w*|verzeichnis\w*|find\w*|such\w*|liegt|liegen|plannummer\w*|plannr|index|indizes|benenn\w*|bezeichn\w*|dateiname\w*|filename\w*|naming|namen?skonvention\w*|konvention\w*|convention\w*|struktur\w*|nummerier\w*)\b/iu

/** Whether the question is about where things are kept or what they are called. */
export function asksWhereThingsAre(query: string | null | undefined): boolean {
  return Boolean(query && FILING_OR_FINDING.test(query.normalize('NFC')))
}
