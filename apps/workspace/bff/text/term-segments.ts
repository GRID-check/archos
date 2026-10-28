/**
 * A text cut where the words of a query occur, so a surface can set the
 * matched words apart (a search result's passage, a picker's row).
 *
 * Every word of two or more characters counts, case-insensitively, wherever it
 * occurs, so a word inside a German compound is found where it stands
 * („Fluchtweg“ in „Fluchtweglänge“), and only that part is set apart. The
 * longest word wins where two overlap, and two matches that touch („Brand“
 * and „schutz“ in „Brandschutz“) are one segment, so the compound reads as one
 * word and not as two halves.
 *
 * What the search itself forgives, this forgives too, or the reader sees a hit
 * with nothing set apart in it:
 * - an inflected word finds its stem: the content search stems German, so
 *   „Fluchtwege“ finds a passage that says „Fluchtweg“ (`stemOf`);
 * - a soft hyphen a PDF left inside a word („Flucht­weg“) does not cut it;
 * - an umlaut composed or decomposed is the same letter: text and query are
 *   compared in NFC, and the segments are cut from the NFC text.
 *
 * The segments joined are the text in NFC, character for character.
 *
 * No regex: the terms are what a person typed, so they are matched as literal
 * strings over a folded copy of the text (lower case, soft hyphens dropped)
 * and mapped back, rather than compiled into a pattern (Semgrep
 * `detect-non-literal-regexp`; the precedent is
 * `features/layout/lib/file-reference-markers.ts`).
 */

export interface TextSegment {
  text: string
  match: boolean
}

const MIN_TERM_LENGTH = 2
/** A stem shorter than this finds too much to be worth setting apart. */
const MIN_STEM_LENGTH = 4
/** German inflection endings, longest first: Fluchtweg-e, Gebäude-n, Plan-es, Geschoss-en. */
const INFLECTION_ENDINGS = ['ern', 'en', 'er', 'es', 'em', 'e', 'n', 's'] as const
const SOFT_HYPHEN = '­'

/** The word without one inflection ending, or null when it has none or too little would be left. */
export function stemOf(term: string): string | null {
  const lower = term.toLocaleLowerCase('de')
  for (const ending of INFLECTION_ENDINGS) {
    if (lower.endsWith(ending) && term.length - ending.length >= MIN_STEM_LENGTH) return term.slice(0, term.length - ending.length)
  }
  return null
}

/** One character folded for comparison: lower case, unless that changes its length. */
function foldChar(char: string): string {
  const lower = char.toLocaleLowerCase('de')
  return lower.length === char.length ? lower : char
}

/**
 * The text folded for comparison, without soft hyphens, and for each folded
 * UTF-16 unit the `[start, end)` of the character it came from in the text.
 */
function foldText(text: string): { folded: string; from: number[]; to: number[] } {
  let folded = ''
  const from: number[] = []
  const to: number[] = []
  let at = 0
  for (const char of text) {
    const end = at + char.length
    if (char !== SOFT_HYPHEN) {
      const unit = foldChar(char)
      folded += unit
      for (let i = 0; i < unit.length; i += 1) {
        from.push(at)
        to.push(end)
      }
    }
    at = end
  }
  return { folded, from, to }
}

const foldTerm = (term: string): string => [...term].map(foldChar).join('')

function queryTerms(query: string): string[] {
  const words = query
    .normalize('NFC')
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= MIN_TERM_LENGTH)
  const stems = words.map(stemOf).filter((stem): stem is string => stem !== null)
  return [...new Set([...words, ...stems])].sort((a, b) => b.length - a.length)
}

function push(segments: TextSegment[], text: string, match: boolean): void {
  const last = segments.at(-1)
  if (last && last.match === match) last.text += text
  else segments.push({ text, match })
}

export function termSegments(text: string, query: string): TextSegment[] {
  const normalized = text.normalize('NFC')
  const terms = queryTerms(query).map(foldTerm)
  if (normalized === '') return []
  if (terms.length === 0) return [{ text: normalized, match: false }]
  const { folded, from, to } = foldText(normalized)
  const segments: TextSegment[] = []
  let last = 0
  let index = 0
  while (index < folded.length) {
    // Longest term first, as `queryTerms` sorts them: the leftmost match, and at it the longest.
    const term = terms.find((candidate) => folded.startsWith(candidate, index))
    if (!term) {
      index += 1
      continue
    }
    const start = from[index]
    const end = to[index + term.length - 1]
    if (start > last) push(segments, normalized.slice(last, start), false)
    push(segments, normalized.slice(start, end), true)
    last = end
    index += term.length
  }
  if (last < normalized.length) push(segments, normalized.slice(last), false)
  return segments
}
