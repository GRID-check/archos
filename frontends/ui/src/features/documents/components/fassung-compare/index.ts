/**
 * The visual comparison of two Fassungen.
 *
 * Mount it with `useFassungCompare()`; the component is exported for a surface
 * that wants to own the open state itself. Everything else in this folder is
 * private to it.
 */

export { FassungCompare, type FassungCompareProps } from './fassung-compare'
export { useFassungCompare, type FassungCompareHandle } from './use-fassung-compare'
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
