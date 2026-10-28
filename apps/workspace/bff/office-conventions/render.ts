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
import { conventionLines, linesForAgent, resolveLines, type StoredDecision } from './lines'
import type { ConventionLine, ConventionLineView } from './office-conventions-wire'

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

const CONFIRMED = 'confirmed by the office'

/** The count behind a line: confirmed by a person, with its count when it still has one. */
function backing(view: ConventionLineView, count: string): string {
  if (view.decision !== 'confirmed') return count
  return view.counted ? `${CONFIRMED}; ${count}` : CONFIRMED
}

const folderEntry = (view: ConventionLineView & { line: ConventionLine & { kind: 'folder' } }): string =>
  view.decision === 'confirmed' && !view.counted
    ? `${view.line.path} (${CONFIRMED})`
    : `${view.line.path} (${view.line.projects}/${view.line.of})`

/**
 * The convention lines, without the header, most useful first; empty when
 * nothing was learned. A declined line is left out and a confirmed one is
 * always in, counted or not (`./lines`).
 */
export function renderOfficeConventions(conventions: OfficeConventions, decisions: readonly StoredDecision[] = []): string[] {
  const views = linesForAgent(resolveLines(conventionLines(conventions), decisions))
  // Confirmed filing lines first: the budget below drops from the end.
  const filing: string[] = []
  const naming: string[] = []
  const folders: string[] = []
  for (const view of views) {
    const { line } = view
    if (line.kind === 'filing') {
      const text = `- ${line.docType} usually filed under ${line.path} (${backing(view, `${of(line)} that file one in a folder`)})`
      if (view.decision === 'confirmed') filing.unshift(text)
      else filing.push(text)
    } else if (line.kind === 'folder') {
      folders.push(folderEntry(view as Parameters<typeof folderEntry>[0]))
    } else if (line.kind === 'document_number') {
      naming.push(`- Plannummer usually shaped ${line.shape} (A = letters, 0 = a digit; ${backing(view, `title blocks of ${of(line)}`)})`)
    } else if (line.kind === 'revision_style') {
      naming.push(`- Index usually ${REVISION_WORDS[line.style]} (${backing(view, of(line))})`)
    } else {
      naming.push(`- file names usually write a date as ${line.format} (${backing(view, of(line))})`)
    }
  }
  const rest = [...(folders.length > 0 ? [`- folders most projects keep: ${folders.slice(0, MAX_FOLDERS_NAMED).join(', ')}`] : []), ...naming]
  return [...filing.slice(0, Math.max(0, MAX_CONVENTION_LINES - rest.length)), ...rest].slice(0, MAX_CONVENTION_LINES).map(clip)
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
