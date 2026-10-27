/**
 * A text cut where the words of a query occur, so a surface can set the
 * matched words apart (a search result's passage, a picker's row).
 *
 * Every word of two or more characters counts, case-insensitively, wherever it
 * occurs; the longest word wins where two overlap. The segments joined are the
 * text again, character for character.
 */

export interface TextSegment {
  text: string
  match: boolean
}

const MIN_TERM_LENGTH = 2

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function termSegments(text: string, query: string): TextSegment[] {
  const terms = [...new Set(query.split(/\s+/).map((term) => term.trim()).filter((term) => term.length >= MIN_TERM_LENGTH))]
  if (text === '' || terms.length === 0) return text === '' ? [] : [{ text, match: false }]
  const pattern = new RegExp(`(${terms.sort((a, b) => b.length - a.length).map(escapeRegExp).join('|')})`, 'giu')
  const segments: TextSegment[] = []
  let last = 0
  for (const found of text.matchAll(pattern)) {
    const at = found.index ?? 0
    if (at > last) segments.push({ text: text.slice(last, at), match: false })
    segments.push({ text: found[0], match: true })
    last = at + found[0].length
  }
  if (last < text.length) segments.push({ text: text.slice(last), match: false })
  return segments
}
