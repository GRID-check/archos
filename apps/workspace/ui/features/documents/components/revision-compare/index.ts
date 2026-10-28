/**
 * The visual comparison of two Fassungen.
 *
 * Mount it with `useRevisionCompare()`; the component is exported for a surface
 * that wants to own the open state itself. Everything else in this folder is
 * private to it.
 */

export { RevisionCompare, type RevisionCompareProps } from './revision-compare'
export { useRevisionCompare, type RevisionCompareHandle } from './use-revision-compare'
export { compareKindOf, type CompareKind } from './lib/compare-kind'
export { regionToPixels, type PixelBox } from './lib/regions'
export {
  NotComparableError,
  type CompareFile,
  type CompareMode,
  type CompareRegion,
  type PageSize,
  type PageSource,
  type RenderHandle,
  type SourceLoader,
} from './types'
