import type { TextSegment } from '@/lib/text/term-segments'

/** How many characters of a one-line passage may stand before its first match. */
const PASSAGE_LEAD_CHARS = 32

/**
 * A one-line passage from a word or two before its first match, so the match
 * is on the line rather than past its cut: the server's passage is a few
 * sentences, and the palette shows the first forty characters of it. The cut
 * falls on a word boundary. The segments unchanged when the match is already
 * near the start, or there is none.
 */
export function leadUpToMatch(segments: readonly TextSegment[]): readonly TextSegment[] {
  const first = segments.findIndex((segment) => segment.match)
  if (first <= 0) return segments
  const before = segments.slice(0, first).map((segment) => segment.text).join('')
  if (before.length <= PASSAGE_LEAD_CHARS) return segments
  const tail = before.slice(before.length - PASSAGE_LEAD_CHARS)
  const wordStart = tail.indexOf(' ')
  const lead = (wordStart === -1 ? tail : tail.slice(wordStart + 1)).trimStart()
  return [{ text: lead, match: false }, ...segments.slice(first)]
}
