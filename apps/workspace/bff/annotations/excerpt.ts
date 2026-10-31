/** How an inbox row quotes a mark or a reply: one line, at most {@link EXCERPT_LENGTH} characters. */

/** Longest question quoted in a row. */
const EXCERPT_LENGTH = 160

export function excerptOf(text: string | null | undefined): string | null {
  const trimmed = text?.replace(/\s+/g, ' ').trim()
  if (!trimmed) return null
  return trimmed.length > EXCERPT_LENGTH ? `${trimmed.slice(0, EXCERPT_LENGTH - 1)}…` : trimmed
}
