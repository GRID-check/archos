import type { CompareRegion, PageSize } from '../types'

/** A box in CSS pixels, relative to the page's top-left corner. */
export interface PixelBox {
  left: number
  top: number
  width: number
  height: number
}

const unit = (value: number): number => (Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 0)

/**
 * Where a region sits on a page drawn at `size`.
 *
 * Regions come from a model, so they are not trusted to stay inside the page: a
 * box that starts at 0.9 and is 0.3 wide is cut at the edge rather than drawn
 * outside the sheet, and a non-finite number draws nothing instead of `NaN`
 * px. The corner is clamped first and the extent second, so a box never moves
 * to make room for its width, it only shrinks.
 */
export function regionToPixels(
  region: Pick<CompareRegion, 'x' | 'y' | 'w' | 'h'>,
  size: PageSize,
): PixelBox {
  const x = unit(region.x)
  const y = unit(region.y)
  const w = Math.min(unit(region.w), 1 - x)
  const h = Math.min(unit(region.h), 1 - y)
  return {
    left: x * size.width,
    top: y * size.height,
    width: w * size.width,
    height: h * size.height,
  }
}

/** A region with the number its tag and its list entry share. */
export interface NumberedRegion {
  number: number
  region: CompareRegion
}

/**
 * Number the regions in the order they were given, across ALL pages.
 *
 * The number belongs to the region, not to its place on the current page: the
 * list beside the sheet shows every region, and "3" must mean the same box
 * whether the reader is on its page or looking at the list from another one.
 */
export function numberRegions(regions: readonly CompareRegion[]): NumberedRegion[] {
  return regions.map((region, index) => ({ number: index + 1, region }))
}

/** The numbered regions that sit on `page`. */
export function regionsOnPage(regions: readonly NumberedRegion[], page: number): NumberedRegion[] {
  return regions.filter((entry) => entry.region.page === page)
}

/** What Piloti answered for one page: its boxes, and its sentences. */
export interface PageAnswer {
  regions: readonly CompareRegion[]
  summary: readonly string[]
}

/**
 * Every answered page's boxes as one list, in the order the pages were asked.
 *
 * Asking about page 2 adds to page 1's boxes instead of replacing them, and the
 * order of asking (not page order) is what keeps a box's number from changing
 * when an earlier page is asked about later. Each region is held to the page it
 * was asked for: a model that names another page does not move a box onto it.
 */
export function mergeAnswers(answers: ReadonlyMap<number, PageAnswer>): CompareRegion[] {
  return [...answers].flatMap(([page, answer]) => answer.regions.map((region) => ({ ...region, page })))
}

/** One row of the change list: a numbered box, and Piloti's sentence for it when one can be paired. */
export interface ChangeRow extends NumberedRegion {
  sentence?: string
}

/** The change list's section for one page. */
export interface ChangeGroup {
  page: number
  rows: ChangeRow[]
  /** Piloti's sentences that could not be paired with a box, shown under the rows. */
  notes: string[]
}

const sameText = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase()

/**
 * The list beside the sheet, one group per page, in page order.
 *
 * Piloti answers a page with boxes and with sentences, and the two are not tied
 * to each other on the wire. They are paired in order only when the counts
 * match (the prompt asks for one sentence per change); otherwise the sentences
 * stand under the rows as notes. A sentence that only repeats a box's label is
 * dropped either way, so the list never says one thing twice. A page with
 * sentences and no boxes (nothing visible changed) still gets its group.
 */
export function groupByPage(
  regions: readonly NumberedRegion[],
  sentences: ReadonlyMap<number, readonly string[]> = new Map(),
): ChangeGroup[] {
  const pages = new Set<number>([...regions.map((entry) => entry.region.page), ...sentences.keys()])
  return [...pages]
    .sort((a, b) => a - b)
    .map((page) => {
      const onPage = regionsOnPage(regions, page).sort((a, b) => a.number - b.number)
      const lines = [...(sentences.get(page) ?? [])]
      const repeats = (line: string): boolean => onPage.some((entry) => sameText(entry.region.label, line))
      if (onPage.length > 0 && lines.length === onPage.length) {
        return {
          page,
          rows: onPage.map((entry, index) => {
            const line = lines[index] ?? ''
            return sameText(line, entry.region.label) ? { ...entry } : { ...entry, sentence: line }
          }),
          notes: [],
        }
      }
      return { page, rows: onPage.map((entry) => ({ ...entry })), notes: lines.filter((line) => !repeats(line)) }
    })
}

interface Rect {
  left: number
  top: number
  width: number
  height: number
}

/**
 * The scroll position that puts `box` in the middle of `frame`, as far as the
 * frame can scroll. Both rects are viewport rects (`getBoundingClientRect`),
 * so the answer does not care how the sheet is padded or centred inside.
 */
export function centeredScroll(
  frame: Rect & { scrollLeft: number; scrollTop: number; scrollWidth: number; scrollHeight: number },
  box: Rect,
): { left: number; top: number } {
  const clamp = (value: number, max: number): number => Math.min(Math.max(value, 0), Math.max(max, 0))
  const left = frame.scrollLeft + (box.left - frame.left) - (frame.width - box.width) / 2
  const top = frame.scrollTop + (box.top - frame.top) - (frame.height - box.height) / 2
  return {
    left: clamp(left, frame.scrollWidth - frame.width),
    top: clamp(top, frame.scrollHeight - frame.height),
  }
}
