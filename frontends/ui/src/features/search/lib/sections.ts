import type { SearchHit, SearchSection } from '@/lib/search/search-wire'

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
