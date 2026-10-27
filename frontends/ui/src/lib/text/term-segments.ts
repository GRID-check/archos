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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The word without one inflection ending, or null when it has none or too little would be left. */
export function stemOf(term: string): string | null {
  const lower = term.toLocaleLowerCase('de')
  for (const ending of INFLECTION_ENDINGS) {
    if (lower.endsWith(ending) && term.length - ending.length >= MIN_STEM_LENGTH) return term.slice(0, term.length - ending.length)
  }
  return null
}

/** The term as a pattern that lets a soft hyphen sit between any two of its characters. */
function termPattern(term: string): string {
  return [...term].map(escapeRegExp).join(`${SOFT_HYPHEN}?`)
}

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
  const terms = queryTerms(query)
  if (normalized === '') return []
  if (terms.length === 0) return [{ text: normalized, match: false }]
  const pattern = new RegExp(`(${terms.map(termPattern).join('|')})`, 'giu')
  const segments: TextSegment[] = []
  let last = 0
  for (const found of normalized.matchAll(pattern)) {
    const at = found.index ?? 0
    if (at > last) push(segments, normalized.slice(last, at), false)
    push(segments, found[0], true)
    last = at + found[0].length
  }
  if (last < normalized.length) push(segments, normalized.slice(last), false)
  return segments
}
