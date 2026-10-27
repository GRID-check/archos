import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { JSX } from 'react'
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@/test-utils'
import { installLayoutObservers } from '@/test-utils/layout-observers'
import type { UseRevisionVisualChanges } from '../../hooks/use-revision-visual-changes'
import { RevisionCompare } from './revision-compare'
import { useRevisionCompare } from './use-revision-compare'
import { regionToPixels } from './lib/regions'
import { NotComparableError, type CompareRegion, type PageSource, type SourceLoader } from './types'

/**
 * The comparison is asserted through what it decides: which mode is on, which
 * page, what it says when it cannot draw. Painting itself needs a canvas, which
 * happy-dom does not have, so the sources here record the pages they were asked
 * for instead of drawing them.
 */

const visual = vi.hoisted(() => ({
  current: null as unknown as UseRevisionVisualChanges,
  run: vi.fn(async () => {}),
  ids: [] as Array<[string | null | undefined, string | null | undefined]>,
}))

vi.mock('../../hooks/use-revision-visual-changes', () => ({
  useRevisionVisualChanges: (newerId: string | null | undefined, olderId: string | null | undefined) => {
    visual.ids.push([newerId, olderId])
    return visual.current
  },
}))

const idleVisual = (over: Partial<UseRevisionVisualChanges> = {}): UseRevisionVisualChanges => ({
  state: 'idle',
  regions: [],
  summary: [],
  errorStatus: null,
  run: visual.run,
  ...over,
})

const SIZE = { width: 800, height: 400 }

const source = (pageCount: number, painted: Array<[string, number]>, name: string): PageSource => ({
  pageCount,
  pageSize: async () => SIZE,
  render: (page) => {
    painted.push([name, page])
    return { promise: Promise.resolve(), cancel: () => {} }
  },
  destroy: vi.fn(),
})

interface Setup {
  painted: Array<[string, number]>
  loader: SourceLoader
  onClose: Mock<() => void>
}

const setup = (olderPages: number, newerPages: number): Setup => {
  const painted: Array<[string, number]> = []
  const loader: SourceLoader = async (file) =>
    source(file.id === 'older' ? olderPages : newerPages, painted, file.id)
  return { painted, loader, onClose: vi.fn<() => void>() }
}

const OLDER = { id: 'older', filename: 'Grundriss_B.pdf' }
const NEWER = { id: 'newer', filename: 'Grundriss_C.pdf' }

const region = (over: Partial<CompareRegion> = {}): CompareRegion => ({
  page: 1,
  x: 0.25,
  y: 0.5,
  w: 0.5,
  h: 0.25,
  label: 'Trennwand versetzt',
  ...over,
})

const open = async (
  environment: Setup,
  props: Partial<Parameters<typeof RevisionCompare>[0]> = {},
): Promise<void> => {
  render(
    <RevisionCompare
      older={OLDER}
      newer={NEWER}
      onClose={environment.onClose}
      loadSource={environment.loader}
      {...props}
    />,
  )
  await screen.findByTestId(
    props.initialMode === 'swipe' ? 'stage-swipe' : 'stage-side',
    undefined,
    { timeout: 10_000 },
  )
}

/** The screen the spec pretends to be: a desktop wide enough for the list beside the sheet, unless a test says phone. */
const screen_ = { wide: true, phone: false }

let restoreObservers: () => void
beforeEach(() => {
  visual.current = idleVisual()
  visual.ids = []
  restoreObservers = installLayoutObservers({ frameWidth: 1000 })
  screen_.wide = true
  screen_.phone = false
  window.matchMedia = ((query: string) => ({
    matches: query === '(min-width: 1024px)' ? screen_.wide : query.includes('40rem') ? screen_.phone : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia
})
afterEach(() => restoreObservers())

describe('RevisionCompare modes', () => {
  it('opens side by side, one pane per Fassung, each named', async () => {
    await open(setup(2, 2))
    expect(screen.getByRole('region', { name: /Older revision: Grundriss_B\.pdf/ })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: /Newer revision: Grundriss_C\.pdf/ })).toBeInTheDocument()
    expect(screen.getAllByTestId('compare-page')).toHaveLength(2)
  })

  it('switches to overlay and swipe from the toggle', async () => {
    await open(setup(1, 1))
    fireEvent.click(screen.getByTestId('mode-overlay'))
    expect(screen.getByTestId('stage-overlay')).toBeInTheDocument()
    expect(screen.getByTestId('compare-opacity')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('mode-swipe'))
    expect(screen.getByTestId('stage-swipe')).toBeInTheDocument()
    expect(screen.getByTestId('swipe-divider')).toBeInTheDocument()
    expect(screen.queryByTestId('compare-opacity')).not.toBeInTheDocument()
  })

  it('draws both Fassungen on one sheet in the overlay, the newer one multiplied', async () => {
    await open(setup(1, 1))
    fireEvent.click(screen.getByTestId('mode-overlay'))
    const pages = screen.getAllByTestId('compare-page')
    expect(pages).toHaveLength(2)
    expect(pages[1]?.parentElement?.className).toContain('mix-blend-multiply')
    fireEvent.change(screen.getByTestId('compare-opacity'), { target: { value: '40' } })
    expect(pages[1]?.parentElement).toHaveStyle({ opacity: '0.4' })
  })

  it('moves the swipe divider with the arrows and clips the newer sheet to it', async () => {
    await open(setup(1, 1), { initialMode: 'swipe' })
    const divider = await screen.findByTestId('swipe-divider')
    expect(divider).toHaveAttribute('aria-valuenow', '50')
    fireEvent.keyDown(divider, { key: 'ArrowRight' })
    expect(divider).toHaveAttribute('aria-valuenow', '52')
    fireEvent.keyDown(divider, { key: 'End' })
    expect(divider).toHaveAttribute('aria-valuenow', '100')
    const newerSheet = screen.getAllByTestId('compare-page')[1]?.parentElement
    expect(newerSheet).toHaveStyle({ clipPath: 'inset(0 0 0 100%)' })
  })

  it('tells the reader what the colours mean in the overlay, naming each colour', async () => {
    await open(setup(1, 1))
    fireEvent.click(screen.getByTestId('mode-overlay'))
    const legend = screen.getByRole('list', { name: 'Color key' })
    expect(within(legend).getByText('Older (cyan)')).toBeInTheDocument()
    expect(within(legend).getByText('Newer (orange)')).toBeInTheDocument()
    expect(within(legend).getByText('Unchanged (dark)')).toBeInTheDocument()
  })

  it('shows the colour key only in the overlay, where colours mean something', async () => {
    await open(setup(1, 1))
    expect(screen.queryByRole('list', { name: 'Color key' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('mode-swipe'))
    expect(screen.queryByRole('list', { name: 'Color key' })).not.toBeInTheDocument()
  })

  it('tags both sides of the swipe sheet, each clipped with its half', async () => {
    await open(setup(1, 1), { initialMode: 'swipe' })
    expect(screen.getByTestId('sheet-tag-left')).toHaveTextContent('Older')
    expect(screen.getByTestId('sheet-tag-left')).toHaveTextContent('Grundriss_B.pdf')
    expect(screen.getByTestId('sheet-tag-right')).toHaveTextContent('Newer')
    fireEvent.keyDown(screen.getByTestId('swipe-divider'), { key: 'End' })
    expect(screen.getByTestId('sheet-tag-right').parentElement).toHaveStyle({ clipPath: 'inset(0 0 0 100%)' })
  })

  it('keeps the stage bar in every view, so switching views never moves the sheet', async () => {
    await open(setup(1, 1))
    expect(screen.getByTestId('compare-stage-bar')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('mode-overlay'))
    expect(screen.getByTestId('compare-stage-bar')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('mode-swipe'))
    expect(screen.getByTestId('compare-stage-bar')).toBeInTheDocument()
  })

  it('says „Fit" at the fit and a percentage of it otherwise, and fits again on press', async () => {
    await open(setup(1, 1))
    const zoom = screen.getByTestId('compare-zoom')
    expect(zoom).toHaveTextContent('Fit')
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(zoom).toHaveTextContent('150%')
    fireEvent.click(zoom)
    expect(zoom).toHaveTextContent('Fit')
  })
})

describe('RevisionCompare pages', () => {
  it('keeps both sheets on the same page and repaints both when it turns', async () => {
    const environment = setup(3, 3)
    await open(environment)
    expect(screen.getByTestId('compare-page-of')).toHaveTextContent('Page 1 of 3')
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    expect(screen.getByTestId('compare-page-of')).toHaveTextContent('Page 2 of 3')
    await waitFor(() => {
      expect(environment.painted).toContainEqual(['older', 2])
      expect(environment.painted).toContainEqual(['newer', 2])
    })
  })

  it('offers no page controls for single-page documents', async () => {
    await open(setup(1, 1))
    expect(screen.queryByTestId('compare-page-of')).not.toBeInTheDocument()
    expect(screen.queryByTestId('compare-page-count-note')).not.toBeInTheDocument()
  })

  it('says so when the page counts differ, and names the missing page on the shorter side', async () => {
    await open(setup(1, 2))
    expect(screen.getByTestId('compare-page-count-note')).toHaveTextContent('1 against 2')
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    await waitFor(() => expect(screen.getByTestId('missing-older')).toHaveTextContent('no page 2'))
    expect(screen.getAllByTestId('compare-page')).toHaveLength(1)
  })

  it('stops at the first and last page', async () => {
    await open(setup(2, 2))
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled()
  })
})

describe('RevisionCompare keyboard', () => {
  const dialog = (): HTMLElement => screen.getByTestId('revision-compare')

  it('turns pages with the arrow keys', async () => {
    await open(setup(3, 3))
    fireEvent.keyDown(dialog(), { key: 'ArrowRight' })
    expect(screen.getByTestId('compare-page-of')).toHaveTextContent('Page 2 of 3')
    fireEvent.keyDown(dialog(), { key: 'ArrowRight' })
    fireEvent.keyDown(dialog(), { key: 'ArrowRight' })
    expect(screen.getByTestId('compare-page-of')).toHaveTextContent('Page 3 of 3')
    fireEvent.keyDown(dialog(), { key: 'ArrowLeft' })
    expect(screen.getByTestId('compare-page-of')).toHaveTextContent('Page 2 of 3')
  })

  it('switches mode with 1, 2 and 3', async () => {
    await open(setup(1, 1))
    fireEvent.keyDown(dialog(), { key: '2' })
    expect(screen.getByTestId('stage-overlay')).toBeInTheDocument()
    fireEvent.keyDown(dialog(), { key: '3' })
    expect(screen.getByTestId('stage-swipe')).toBeInTheDocument()
    fireEvent.keyDown(dialog(), { key: '1' })
    expect(screen.getByTestId('stage-side')).toBeInTheDocument()
  })

  it('leaves the arrows to the opacity slider and the swipe divider', async () => {
    await open(setup(3, 3))
    fireEvent.keyDown(dialog(), { key: '2' })
    fireEvent.keyDown(screen.getByTestId('compare-opacity'), { key: 'ArrowRight' })
    expect(screen.getByTestId('compare-page-of')).toHaveTextContent('Page 1 of 3')
    fireEvent.keyDown(dialog(), { key: '3' })
    fireEvent.keyDown(screen.getByTestId('swipe-divider'), { key: 'ArrowRight' })
    expect(screen.getByTestId('compare-page-of')).toHaveTextContent('Page 1 of 3')
  })

  it('closes on Escape', async () => {
    const environment = setup(1, 1)
    await open(environment)
    fireEvent.keyDown(dialog(), { key: 'Escape' })
    await waitFor(() => expect(environment.onClose).toHaveBeenCalled())
  })
})

describe('RevisionCompare overlays', () => {
  it('draws each region of the current page where regionToPixels puts it, numbered across pages', async () => {
    const overlays = [region(), region({ page: 2, label: 'Treppe' }), region({ x: 0.1, y: 0.1, w: 0.2, h: 0.2, label: 'Fenster' })]
    await open(setup(2, 2), { overlays })
    const boxes = screen.getAllByTestId('compare-region')
    expect(boxes.map((box) => box.dataset.region)).toEqual(['1', '3'])
    const expected = regionToPixels(overlays[0] as CompareRegion, SIZE)
    // 1000 px area, minus the two panes' gutter, at fit-to-width: scale is the same for both axes.
    const scale = parseFloat(boxes[0]?.style.width ?? '0') / expected.width
    expect(scale).toBeGreaterThan(0)
    expect(parseFloat(boxes[0]?.style.left ?? '0')).toBeCloseTo(expected.left * scale)
    expect(parseFloat(boxes[0]?.style.top ?? '0')).toBeCloseTo(expected.top * scale)
    expect(parseFloat(boxes[0]?.style.height ?? '0')).toBeCloseTo(expected.height * scale)
  })

  it('draws the boxes on the newer sheet only', async () => {
    await open(setup(1, 1), { overlays: [region()] })
    expect(within(screen.getByTestId('pane-newer')).getAllByTestId('compare-region')).toHaveLength(1)
    expect(within(screen.getByTestId('pane-older')).queryAllByTestId('compare-region')).toHaveLength(0)
  })

  it('lists every label and jumps to its page', async () => {
    await open(setup(2, 2), { overlays: [region(), region({ page: 2, label: 'Treppe' })] })
    const list = screen.getByTestId('compare-changes')
    expect(within(list).getByText('Trennwand versetzt')).toBeInTheDocument()
    fireEvent.click(within(list).getByRole('button', { name: /Treppe/ }))
    expect(screen.getByTestId('compare-page-of')).toHaveTextContent('Page 2 of 2')
    expect(within(list).getByRole('button', { name: /Treppe/ })).toHaveAttribute('aria-current', 'true')
  })

  it('lists nothing without overlays', async () => {
    await open(setup(1, 1))
    expect(screen.queryAllByTestId('compare-change')).toHaveLength(0)
  })
})

describe('RevisionCompare states', () => {
  it('says the files cannot be compared visually and points to the text comparison', async () => {
    const loader: SourceLoader = async () => {
      throw new NotComparableError()
    }
    render(<RevisionCompare older={OLDER} newer={NEWER} onClose={() => {}} loadSource={loader} />)
    const notice = await screen.findByTestId('compare-not-comparable', undefined, { timeout: 10_000 })
    expect(notice).toHaveTextContent('cannot be compared visually')
    expect(notice).toHaveTextContent('text comparison')
    expect(screen.queryByTestId('mode-overlay')).not.toBeInTheDocument()
  })

  it('names a load failure separately from a file that cannot be compared', async () => {
    const loader: SourceLoader = async () => {
      throw new Error('boom')
    }
    render(<RevisionCompare older={OLDER} newer={NEWER} onClose={() => {}} loadSource={loader} />)
    expect(await screen.findByTestId('compare-failed', undefined, { timeout: 10_000 })).toHaveTextContent('could not be loaded')
  })

  it('shows loading while the pages are on their way', () => {
    const loader: SourceLoader = () => new Promise(() => {})
    render(<RevisionCompare older={OLDER} newer={NEWER} onClose={() => {}} loadSource={loader} />)
    expect(screen.getByTestId('compare-loading')).toBeInTheDocument()
  })

  it('releases both documents when the comparison closes', async () => {
    const destroyed: string[] = []
    const loader: SourceLoader = async (file) => ({
      ...source(1, [], file.id),
      destroy: () => destroyed.push(file.id),
    })
    const { unmount } = render(<RevisionCompare older={OLDER} newer={NEWER} onClose={() => {}} loadSource={loader} />)
    await screen.findByTestId('stage-side', undefined, { timeout: 10_000 })
    unmount()
    expect(destroyed.sort()).toEqual(['newer', 'older'])
  })
})

describe('RevisionCompare: Piloti marks the changes', () => {
  const mark = (): HTMLElement => screen.getByTestId('compare-mark')

  it('asks for the changes of the newer document against the older one', async () => {
    await open(setup(1, 1))
    expect(visual.ids.at(-1)).toEqual(['newer', 'older'])
  })

  it('runs for the page the reader is on', async () => {
    await open(setup(3, 3))
    fireEvent.keyDown(screen.getByTestId('revision-compare'), { key: 'ArrowRight' })
    fireEvent.click(mark())
    expect(visual.run).toHaveBeenCalledWith(2)
  })

  it('names the page it would mark', async () => {
    await open(setup(3, 3))
    expect(mark()).toHaveTextContent('Compare page 1 with Piloti')
    fireEvent.keyDown(screen.getByTestId('revision-compare'), { key: 'ArrowRight' })
    expect(mark()).toHaveTextContent('Compare page 2 with Piloti')
  })

  it('shows a busy button naming the page while Piloti is comparing, and skeleton rows', async () => {
    await open(setup(1, 1))
    visual.current = idleVisual({ state: 'loading' })
    fireEvent.click(mark())
    expect(mark()).toHaveAttribute('aria-disabled', 'true')
    expect(mark()).toHaveAttribute('aria-busy', 'true')
    expect(mark()).toHaveTextContent('Piloti is comparing page 1')
    expect(screen.getByTestId('compare-mark-loading')).toBeInTheDocument()
  })

  it('draws Piloti\'s boxes in place of the overlays, with each sentence under its box\'s row, once', async () => {
    visual.current = idleVisual({
      state: 'done',
      regions: [region({ label: 'Wand versetzt' })],
      summary: ['Eine Trennwand ist verschoben.'],
    })
    await open(setup(1, 1), { overlays: [region({ label: 'Alt' })] })
    fireEvent.click(mark())
    const list = screen.getByTestId('compare-changes')
    const row = await within(list).findByRole('button', { name: /Wand versetzt/ })
    expect(row).toHaveTextContent('Eine Trennwand ist verschoben.')
    expect(screen.getAllByText('Eine Trennwand ist verschoben.')).toHaveLength(1)
    expect(list).toHaveTextContent('Check dimensions in the document')
    expect(screen.getAllByTestId('compare-region')).toHaveLength(1)
    expect(screen.queryByText('Alt')).not.toBeInTheDocument()
    expect(mark()).toHaveTextContent('Page 1 is marked')
    expect(mark()).toBeDisabled()
  })

  it.each([
    [409, 'still being read', false],
    [503, 'not reachable right now', true],
    [502, 'not reachable right now', true],
    [0, 'comparison failed', true],
    [500, 'comparison failed', true],
  ])('says what a %s means and offers a retry where one can help', async (errorStatus, text, retryable) => {
    await open(setup(1, 1))
    visual.current = idleVisual({ state: 'error', errorStatus })
    fireEvent.click(mark())
    expect(screen.getByTestId('compare-mark-error')).toHaveTextContent(text)
    expect(mark()).not.toBeDisabled()
    expect(screen.queryByTestId('compare-mark-retry') !== null).toBe(retryable)
  })

  it('leaves a refusal behind on its page when the reader turns to another', async () => {
    await open(setup(2, 2))
    visual.current = idleVisual({ state: 'error', errorStatus: 503 })
    fireEvent.click(mark())
    expect(screen.getByTestId('compare-mark-error')).toBeInTheDocument()
    fireEvent.keyDown(screen.getByTestId('revision-compare'), { key: 'ArrowRight' })
    expect(screen.queryByTestId('compare-mark-error')).not.toBeInTheDocument()
  })

  it('cannot run on a page one of the Fassungen does not have, and says so', async () => {
    await open(setup(1, 2))
    expect(mark()).not.toBeDisabled()
    fireEvent.keyDown(screen.getByTestId('revision-compare'), { key: 'ArrowRight' })
    expect(mark()).toBeDisabled()
    expect(mark()).toHaveTextContent('Only one revision has page 2')
  })

  it('keeps page 1\'s boxes when page 2 is marked, and lists them grouped by page', async () => {
    const answerFor = (page: number): UseRevisionVisualChanges => ({
      ...idleVisual(),
      state: 'done',
      regions: page === 1 ? [region({ label: 'Wand' }), region({ label: 'Tür', x: 0.1 })] : [region({ page: 2, label: 'Treppe' })],
      summary: [],
      run: async (next: number) => {
        visual.current = answerFor(next)
      },
    })
    visual.current = { ...idleVisual(), run: async (next: number) => { visual.current = answerFor(next) } }
    await open(setup(2, 2))
    fireEvent.click(mark())
    expect(await screen.findAllByTestId('compare-region')).toHaveLength(2)
    fireEvent.keyDown(screen.getByTestId('revision-compare'), { key: 'ArrowRight' })
    fireEvent.click(mark())
    await waitFor(() => expect(screen.getAllByTestId('compare-change')).toHaveLength(3))
    const groups = screen.getAllByTestId('compare-page-group')
    expect(groups.map((group) => group.dataset.page)).toEqual(['1', '2'])
    expect(within(groups[0] as HTMLElement).getAllByTestId('compare-change')).toHaveLength(2)
    expect(screen.getAllByTestId('compare-region').map((box) => box.dataset.region)).toEqual(['3'])
    fireEvent.keyDown(screen.getByTestId('revision-compare'), { key: 'ArrowLeft' })
    await waitFor(() =>
      expect(screen.getAllByTestId('compare-region').map((box) => box.dataset.region)).toEqual(['1', '2']),
    )
    expect(mark()).toHaveTextContent('Page 1 is marked')
  })
})

describe('RevisionCompare: one active change across sheet and list', () => {
  const overlays = [region({ label: 'Wand' }), region({ page: 2, label: 'Treppe' }), region({ label: 'Fenster', x: 0.05, y: 0.05, w: 0.1, h: 0.1 })]
  const row = (name: RegExp): HTMLElement => within(screen.getByTestId('compare-changes')).getByRole('button', { name })
  const box = (number: number): HTMLElement =>
    screen.getAllByTestId('compare-region').find((candidate) => candidate.dataset.region === String(number)) as HTMLElement

  it('lights the box while its row is hovered or focused, and dims the others', async () => {
    await open(setup(2, 2), { overlays })
    fireEvent.pointerEnter(row(/Wand/))
    expect(box(1)).toHaveAttribute('data-active', 'true')
    expect(box(3).className).toContain('opacity-60')
    fireEvent.pointerLeave(row(/Wand/))
    expect(box(1)).not.toHaveAttribute('data-active')
    fireEvent.focus(row(/Fenster/))
    expect(box(3)).toHaveAttribute('data-active', 'true')
  })

  it('lights the row while its box is hovered, and pins it on a click', async () => {
    await open(setup(2, 2), { overlays })
    fireEvent.pointerEnter(box(3))
    expect(row(/Fenster/)).toHaveAttribute('data-active', 'true')
    expect(row(/Fenster/)).not.toHaveAttribute('aria-current')
    fireEvent.click(box(3))
    fireEvent.pointerLeave(box(3))
    expect(row(/Fenster/)).toHaveAttribute('aria-current', 'true')
    expect(row(/Fenster/)).toHaveAttribute('data-active', 'true')
    expect(box(3)).toHaveAttribute('aria-pressed', 'true')
  })

  it('marks only the one pinned row as current, not every row on the page', async () => {
    await open(setup(2, 2), { overlays })
    expect(screen.queryAllByRole('button', { current: true })).toHaveLength(0)
    fireEvent.click(row(/Wand/))
    const current = within(screen.getByTestId('compare-changes')).getAllByRole('button').filter((button) => button.getAttribute('aria-current') === 'true')
    expect(current).toHaveLength(1)
  })

  it('names each box for a tooltip and a screen reader', async () => {
    await open(setup(2, 2), { overlays })
    expect(box(1)).toHaveAccessibleName('Change 1: Wand')
    expect(row(/Wand/)).toHaveAccessibleName('Change 1: Wand. Show on the page.')
  })

  it('turns to the change\'s page and scrolls its box into the middle of the sheet\'s frame', async () => {
    const scrollTo = vi.fn()
    const original = HTMLElement.prototype.scrollTo
    HTMLElement.prototype.scrollTo = scrollTo as unknown as typeof HTMLElement.prototype.scrollTo
    try {
      await open(setup(2, 2), { overlays })
      fireEvent.click(row(/Treppe/))
      expect(screen.getByTestId('compare-page-of')).toHaveTextContent('Page 2 of 2')
      await waitFor(() => expect(scrollTo).toHaveBeenCalled())
      const frame = scrollTo.mock.contexts.at(-1) as HTMLElement
      expect(frame.hasAttribute('data-compare-frame')).toBe(true)
      expect(within(frame).getByTestId('compare-region')).toHaveAttribute('data-region', '2')
    } finally {
      HTMLElement.prototype.scrollTo = original
    }
  })
})

describe('RevisionCompare focus', () => {
  function Host(): JSX.Element {
    const { openRevisionCompare, compareElement } = useRevisionCompare(setup(1, 1).loader)
    return (
      <>
        <button type="button" onClick={() => openRevisionCompare(OLDER, NEWER)}>
          Vergleichen
        </button>
        {compareElement}
      </>
    )
  }

  it('opens on a visible control, the active view, so the arrows work from the first key', async () => {
    await open(setup(2, 2))
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('mode-side')))
  })

  it('reads the keys once on open, through the dialog\'s description', async () => {
    await open(setup(1, 1))
    const dialog = screen.getByTestId('revision-compare')
    const described = (dialog.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ')
    expect(described).toContain('Grundriss_B.pdf')
    expect(described).toContain('Arrow keys change the page')
  })

  it('gives focus back to the button that opened it when it closes', async () => {
    render(<Host />)
    const opener = screen.getByRole('button', { name: 'Vergleichen' })
    opener.focus()
    fireEvent.click(opener)
    await screen.findByTestId('stage-side', undefined, { timeout: 10_000 })
    fireEvent.keyDown(screen.getByTestId('revision-compare'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('revision-compare')).not.toBeInTheDocument())
    await waitFor(() => expect(document.activeElement).toBe(opener))
  })

  it('moves focus to the retry when the pages fail, and retrying loads again', async () => {
    let calls = 0
    const loader: SourceLoader = async (file) => {
      calls += 1
      if (calls <= 2) throw new Error('boom')
      return source(1, [], file.id)
    }
    render(<RevisionCompare older={OLDER} newer={NEWER} onClose={() => {}} loadSource={loader} />)
    const retry = await screen.findByTestId('compare-retry', undefined, { timeout: 10_000 })
    await waitFor(() => expect(document.activeElement).toBe(retry))
    await act(async () => {
      fireEvent.click(retry)
    })
    await screen.findByTestId('stage-side', undefined, { timeout: 10_000 })
  })
})

describe('RevisionCompare on a phone', () => {
  beforeEach(() => {
    screen_.wide = false
    screen_.phone = true
  })

  it('opens in Wischen, where one sheet gets the whole height', async () => {
    render(<RevisionCompare older={OLDER} newer={NEWER} onClose={vi.fn()} loadSource={setup(1, 1).loader} />)
    expect(await screen.findByTestId('stage-swipe', undefined, { timeout: 10_000 })).toBeInTheDocument()
    expect(screen.getByTestId('mode-swipe')).toHaveAttribute('data-state', 'on')
  })

  it('keeps the change list off the stage, one tap away in a sheet with its count', async () => {
    await open(setup(2, 2), { initialMode: 'swipe', overlays: [region(), region({ page: 2, label: 'Treppe' })] })
    expect(screen.queryByTestId('compare-changes')).not.toBeInTheDocument()
    const opener = screen.getByTestId('compare-changes-open')
    expect(opener).toHaveTextContent('2')
    fireEvent.click(opener)
    const list = await screen.findByTestId('compare-changes')
    // Picking a change closes the sheet and turns to the change's page.
    fireEvent.click(within(list).getByRole('button', { name: /Treppe/ }))
    expect(screen.getByTestId('compare-page-of')).toHaveTextContent('Page 2 of 2')
    await waitFor(() => expect(screen.queryByTestId('compare-changes')).not.toBeInTheDocument())
  })

  it('still opens side by side when the caller asks for it', async () => {
    await open(setup(1, 1), { initialMode: 'side' })
    expect(screen.getByTestId('stage-side')).toBeInTheDocument()
  })
})

describe('closing a comparison from elsewhere (a viewer action’s „Zurücknehmen“, ADR-0144)', () => {
  const older = { id: 'old', filename: 'EG_VE.pdf' }
  const newer = { id: 'new', filename: 'EG.pdf' }

  it('shuts only the pair it opened, and says whether it did', () => {
    const { result } = renderHook(() => useRevisionCompare())
    act(() => result.current.openRevisionCompare(older, newer))

    let shut = true
    act(() => {
      shut = result.current.closeRevisionCompare({ id: 'other', filename: 'x.pdf' }, newer)
    })
    expect(shut).toBe(false)
    expect(result.current.compareElement).not.toBeNull()

    act(() => {
      shut = result.current.closeRevisionCompare(older, newer)
    })
    expect(shut).toBe(true)
    expect(result.current.compareElement).toBeNull()
  })
})
