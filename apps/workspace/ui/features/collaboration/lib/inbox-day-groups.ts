/**
 * The inbox's sections: its rows, in the order the server sent them (newest
 * change first), cut where the day they last changed moves into another of
 * four spans. A list of forty rows with one timestamp each made the reader do
 * the arithmetic; a heading per span does it once.
 *
 * Pure, and `now` is a parameter, so the spans are testable without a clock.
 * Days are the reader's local calendar days, as the relative time beside each
 * row reads them.
 */

export type InboxDayGroup = 'today' | 'yesterday' | 'week' | 'older'

export interface InboxSection<T> {
  group: InboxDayGroup
  items: T[]
}

const DAY_MS = 86_400_000

function startOfDay(at: Date): number {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime()
}

/** Which span a moment falls in, seen from `now`. A moment in the future (a skewed clock) is today. */
export function dayGroupOf(iso: string, now: Date): InboxDayGroup {
  const today = startOfDay(now)
  const at = Date.parse(iso)
  if (Number.isNaN(at) || at >= today) return 'today'
  if (at >= today - DAY_MS) return 'yesterday'
  if (at >= today - 6 * DAY_MS) return 'week'
  return 'older'
}

/**
 * The rows cut into consecutive sections. Order is kept as given: a row that
 * sorts out of its span (it should not) opens a section of its own rather than
 * being moved, so the keyboard's j/k order and the drawn order stay one order.
 */
export function inboxSections<T extends { updatedAt: string }>(items: readonly T[], now: Date): InboxSection<T>[] {
  const sections: InboxSection<T>[] = []
  for (const item of items) {
    const group = dayGroupOf(item.updatedAt, now)
    const last = sections.at(-1)
    if (last && last.group === group) last.items.push(item)
    else sections.push({ group, items: [item] })
  }
  return sections
}
