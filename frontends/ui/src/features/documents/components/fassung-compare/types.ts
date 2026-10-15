/**
 * The vocabulary of the visual Fassung comparison.
 *
 * Kept apart from the components so the pure `lib/` functions and the specs can
 * speak it without importing React.
 */

/** One document to compare: what the BFF needs to find its bytes, and the name to show. */
export interface CompareFile {
  id: string
  filename: string
}

/**
 * A place on one page that changed: an outlined box with a numbered tag, in
 * page-relative 0..1 coordinates. The ONE definition is the wire contract of the
 * change-marking route, re-exported here so the dialog and the route cannot drift.
 */
export type { CompareRegion } from '@/lib/documents/fassung-compare-types'

/** How the two pages are laid against each other. */
export type CompareMode = 'side' | 'overlay' | 'swipe'

export const COMPARE_MODES: readonly CompareMode[] = ['side', 'overlay', 'swipe']

/** A page's natural size, in the unit its source draws in (PDF points, image pixels). */
export interface PageSize {
  width: number
  height: number
}

/** A paint in flight; `cancel` is how a page that changed under it stops it. */
export interface RenderHandle {
  promise: Promise<void>
  cancel: () => void
}

/**
 * One Fassung opened for drawing, whatever its bytes are.
 *
 * A PDF (or an office file through its PDF rendition) and an image answer the
 * same four questions, so the comparison never branches on the format.
 */
export interface PageSource {
  pageCount: number
  pageSize: (page: number) => Promise<PageSize>
  /**
   * Paint `page` into `canvas` at `scale` CSS pixels per natural unit. With a
   * `region` (CSS pixels of the page at that scale), paint only that part, at
   * `pixelRatio`: the sharp detail over a page whose whole bitmap had to be
   * held under the canvas budget.
   */
  render: (
    page: number,
    canvas: HTMLCanvasElement,
    options: { scale: number; pixelRatio: number; region?: { x: number; y: number; width: number; height: number } },
  ) => RenderHandle
  /** Release the document and its worker. */
  destroy: () => void
}

/**
 * The file cannot be drawn as a picture (a spreadsheet the converter refused, a
 * format no renderer reads). Distinct from a failure: retrying will not help,
 * and the reader should be sent to the text comparison instead.
 */
export class NotComparableError extends Error {
  constructor(message = 'not comparable visually') {
    super(message)
    this.name = 'NotComparableError'
  }
}

/** Opens a Fassung for drawing. Injectable so the dev preview and the specs bring their own pages. */
export type SourceLoader = (file: CompareFile) => Promise<PageSource>
