/**
 * Where a Skizze's page lies in the base's newer Fassung (S6, ADR-0150): pure,
 * so the plan, the move and the specs read one rule.
 *
 *   - **By its label, when it names one page.** A PDF that labels its sheets
 *     (`A-101`) is matched by that label, compared as written, when it occurs
 *     exactly once in each Fassung.
 *   - **Two pages with that label** in the newer Fassung: the person chooses
 *     (`ambiguous`, with the pages), because the first of two is a guess.
 *   - **The label gone**: the page number, and the dialog says the label was not
 *     found (`labelGone`), because the same number most likely is another sheet.
 *   - **No labels**: the page number.
 *   - **A page the person chose** stands, when the newer Fassung has it.
 *
 * Page counts come from the backend apart from the labels, which stop at its
 * `MAX_LABELS`: a page past the labels is still a page.
 */

export interface PageLabelsOf {
  labels: readonly (string | null)[]
  pageCount: number
}

export type PageMatch =
  | { kind: 'page'; page: number; matchedBy: 'label' | 'index' | 'chosen'; labelGone: boolean }
  | { kind: 'ambiguous'; label: string; pages: number[] }
  | { kind: 'gone'; pageCount: number }

const occurrences = (labels: readonly (string | null)[], label: string) =>
  labels.flatMap((candidate, index) => (candidate === label ? [index + 1] : []))

export function matchUnderlayPage(from: PageLabelsOf, to: PageLabelsOf, page: number, chosen?: number): PageMatch {
  if (chosen !== undefined) {
    return chosen >= 1 && chosen <= to.pageCount ? { kind: 'page', page: chosen, matchedBy: 'chosen', labelGone: false } : { kind: 'gone', pageCount: to.pageCount }
  }
  const label = from.labels[page - 1] ?? null
  const fromIsUnique = label !== null && occurrences(from.labels, label).length === 1
  const there = label !== null ? occurrences(to.labels, label) : []
  if (label !== null && there.length > 1) return { kind: 'ambiguous', label, pages: there }
  if (fromIsUnique && there.length === 1) return { kind: 'page', page: there[0], matchedBy: 'label', labelGone: false }
  if (page > to.pageCount) return { kind: 'gone', pageCount: to.pageCount }
  return { kind: 'page', page, matchedBy: 'index', labelGone: label !== null && there.length === 0 }
}
