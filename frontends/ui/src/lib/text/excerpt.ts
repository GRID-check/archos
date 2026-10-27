/**
 * A short passage of a longer text around where a search term occurs, for a
 * result line: the term in view, as much of its surroundings as fits, and an
 * ellipsis where the text was cut. Whitespace runs collapse to one space first,
 * so a reply's line breaks do not spend the budget.
 */

const ELLIPSIS = '…'

/**
 * At most `max` characters of `text` around the first case-insensitive
 * occurrence of `term`, or its start when there is none (or no term). Pure.
 */
export function excerptAround(text: string, term: string | null, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  const at = term
    ? flat.toLocaleLowerCase().indexOf(term.trim().replace(/\s+/g, ' ').toLocaleLowerCase())
    : -1
  if (at < 0) return `${flat.slice(0, max - 1).trimEnd()}${ELLIPSIS}`
  // Two characters for the ellipses either side; the term sits a third of the way in.
  const room = max - 2
  const start = Math.max(0, Math.min(at - Math.floor(room / 3), flat.length - room))
  const end = Math.min(flat.length, start + room)
  const head = start > 0 ? ELLIPSIS : ''
  const tail = end < flat.length ? ELLIPSIS : ''
  return `${head}${flat.slice(start, end).trim()}${tail}`
}
