import type { SearchHit, SearchKind, SearchResponse, SearchSection } from '@/lib/search/search-wire'

/** One kind's results as the surface shows them: the first page and every page read after it. */
export interface SectionView<T extends SearchHit = SearchHit> {
  hits: T[]
  total: number
  totalIsLowerBound: boolean
  nextCursor: string | null
  loadingMore: boolean
  loadMoreFailed: boolean
}

/** A section as it arrived, with no further page read yet. */
export function sectionView(section: SearchSection): SectionView {
  return { ...section, loadingMore: false, loadMoreFailed: false }
}

/**
 * Whether the kind tabs show their counts: all of them or none, by the rule
 * that a count shows only once it is known. A kind the question did not
 * search (a folder without words) has no count, and „Dokumente 0“ beside
 * bare tabs reads as if those found something uncounted. A kind set aside by
 * a filter is greyed out and says why, so it does not hold the others back.
 */
export function kindCountsKnown(response: Pick<SearchResponse, 'sections' | 'setAside'> | null, kinds: readonly SearchKind[]): boolean {
  if (!response) return false
  return kinds.every((kind) => response.setAside[kind] !== undefined || response.sections[kind] !== undefined)
}
