/**
 * The ways from the file preview into the Prüfansicht, and what the preview
 * says about the marks on the way.
 *
 * What is pinned: a PDF that carries Anmerkungen opens full screen AS the
 * review (an image keeps the enlarged viewer); the review keeps its address
 * while it is open, so a reload stays in it and Back leaves it; „Anmerken" in
 * the viewer's pill opens it with the point in hand; the rail's section stands
 * while the list loads and when it could not be read; a mark set on an earlier
 * Fassung says so; the phone reader has „Anmerken" at the thumb; and a pin
 * shows its mark when the pointer rests on it.
 *
 * The review itself is stood in for: it is the canvas's own suite's. What this
 * file owns is what the pane hands it and when.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { installLayoutObservers } from '@/test-utils/layout-observers'
import { FAKE_FRAME_WIDTH, fakePdfjsRuntime, type FakePdfState } from '@/test-utils/pdfjs-fake'
import type { AnnotationView } from '@/lib/annotations/types'
import type * as ReviewModule from './review/document-review'
import { FilePreviewPane } from './file-preview-pane'
import { HOVER_QUERY } from './inline-mark-peek'

const pdf = vi.hoisted((): FakePdfState => ({ fail: false, pages: [], destroyed: 0 }))
vi.mock('@/features/knowledge/lib/pdfjs-runtime', () => fakePdfjsRuntime(pdf))

/** The page's address, played by the test: what the pane read, and what it wrote. */
const nav = vi.hoisted(() => ({
  params: new URLSearchParams(),
  push: vi.fn<(href: string) => void>(),
  replace: vi.fn<(href: string) => void>(),
  back: vi.fn<() => void>(),
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace, back: nav.back, refresh: vi.fn() }),
  usePathname: () => '/app/projects/proj-1/files',
  useSearchParams: () => nav.params,
}))

type ReviewModeProps = ComponentProps<typeof ReviewModule.DocumentReviewMode> & {
  popoutHref?: string
  initialTool?: string
}
vi.mock('./review/document-review', async (importOriginal) => {
  const actual = await importOriginal<typeof ReviewModule>()
  return {
    ...actual,
    DocumentReviewMode: (props: ReviewModeProps) =>
      props.open ? (
        <div
          data-testid="review-mode"
          data-tool={props.review.tool}
          data-initial-tool={props.initialTool ?? ''}
          data-popout={props.popoutHref ?? ''}
          data-focus={props.focusRequest?.annotationId ?? ''}
        >
          <button type="button" onClick={() => props.onOpenChange(false)}>
            close review
          </button>
        </div>
      ) : null,
  }
})

const FILE = {
  id: 'doc-1',
  filename: 'plan.pdf',
  displayName: null,
  fileSize: 1048576,
  contentType: 'application/pdf',
  status: 'ready',
  folderId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  errorMessage: null,
  summary: null,
  pageCount: null,
  chunkCount: null,
  contentTypes: null,
  tags: null,
  topics: null,
  capture: null,
}

const mark = (overrides: Partial<AnnotationView> = {}): AnnotationView => ({
  id: 'ann-1',
  documentId: 'doc-1',
  number: 1,
  page: 1,
  shape: 'point',
  x: 0.25,
  y: 0.5,
  w: null,
  h: null,
  kind: 'defect',
  body: 'Tür ohne Feuerwiderstandsklasse',
  basis: null,
  authorKind: 'person',
  status: 'open',
  assigneeUserId: null,
  assigneeName: null,
  dueOn: null,
  revisionNumber: 1,
  onCurrentRevision: true,
  createdBy: 'user_anna',
  createdByName: 'Anna Berger',
  createdAt: '2026-10-01T08:00:00.000Z',
  updatedAt: '2026-10-01T08:00:00.000Z',
  acceptedBy: null,
  acceptedByName: null,
  closedBy: null,
  closedByName: null,
  closedAt: null,
  delegatedBy: null,
  delegatedByName: null,
  delegatedAt: null,
  replies: [],
  canEdit: true,
  canDelete: true,
  ...overrides,
})

const json = (body: unknown, status = 200): Response =>
  ({ ok: status < 400, status, json: async () => body }) as Response

/** The BFF: the preview's link, and the marks (or a failure, or a list that never comes). */
function serve(marks: AnnotationView[] | 'error' | 'pending', { canAnnotate = true } = {}) {
  const calls = { annotations: 0 }
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.endsWith('/annotations')) {
      calls.annotations += 1
      if (marks === 'pending') return new Promise<Response>(() => {})
      if (marks === 'error') return json({ error: 'down' }, 500)
      return json({ annotations: marks, canAnnotate, pilotiWakes: false })
    }
    if (url.endsWith('/preview')) {
      return json(
        FILE.contentType === 'application/pdf' && !url.includes('img-')
          ? { url: 'https://example.test/plan.pdf', contentType: 'application/pdf' }
          : { url: 'https://example.test/diagram.png' }
      )
    }
    return json({}, 404)
  })
  return calls
}

const realMatchMedia = window.matchMedia
/** Answer media queries as a phone, or as a desktop pointer that hovers. */
function media(matches: (query: string) => boolean) {
  window.matchMedia = ((query: string) => ({
    matches: matches(query),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  })) as unknown as typeof window.matchMedia
}

let restoreLayout = () => {}
beforeEach(() => {
  pdf.fail = false
  pdf.pages = [{ items: [] }]
  restoreLayout = installLayoutObservers({ frameWidth: FAKE_FRAME_WIDTH, intersecting: true })
  nav.params = new URLSearchParams('doc=doc-1')
  nav.push.mockReset()
  nav.replace.mockReset()
  nav.back.mockReset()
})
afterEach(() => {
  restoreLayout()
  window.matchMedia = realMatchMedia
  vi.restoreAllMocks()
})

const pane = (props: Partial<ComponentProps<typeof FilePreviewPane>> = {}) => (
  <FilePreviewPane file={FILE} projectId="proj-1" {...props} />
)

describe('into the review from the header', () => {
  it('opens a PDF that carries marks as the review, not as the bare enlarged viewer', async () => {
    serve([])
    render(pane())
    const open = await screen.findByRole('button', { name: 'Open review' })
    expect(screen.queryByRole('button', { name: /open large preview/i })).toBeNull()

    fireEvent.click(open)

    expect(await screen.findByTestId('review-mode')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /open in new tab/i })).toBeNull()
    expect(nav.push).toHaveBeenCalledWith('/app/projects/proj-1/files?doc=doc-1&review=1', { scroll: false })
  })

  it('hands the review a pop-out link to the document on its own shelf', async () => {
    serve([])
    render(pane())
    fireEvent.click(await screen.findByRole('button', { name: 'Open review' }))
    expect(screen.getByTestId('review-mode').dataset.popout).toBe(
      `${window.location.origin}/app/projects/proj-1/files?doc=doc-1&review=1`
    )
  })

  it('takes the inline viewer away while the review is open, and brings it back once it closes', async () => {
    serve([mark()])
    render(pane())
    // The inline viewer: its pill, and the marks drawn over its page.
    expect(await screen.findByTestId('inline-annotate')).toBeInTheDocument()
    expect(await screen.findByTestId('review-layer-1')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Open review' }))
    await screen.findByTestId('review-mode')
    // Under the full-screen review, a second viewer drew the same pages for nobody.
    expect(screen.queryByTestId('inline-annotate')).toBeNull()
    expect(screen.queryByTestId('review-layer-1')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'close review' }))
    expect(await screen.findByTestId('inline-annotate')).toBeInTheDocument()
  })

  it('keeps the enlarged viewer for an image', async () => {
    serve([])
    render(pane({ file: { ...FILE, id: 'img-1', filename: 'diagram.png', contentType: 'image/png' } }))
    fireEvent.click(await screen.findByRole('button', { name: /open large preview/i }))
    expect(await screen.findByRole('link', { name: /open in new tab/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open review' })).toBeNull()
  })
})

describe('the review keeps its address', () => {
  it('opens from a link at its mark and leaves the link in the url, so a reload stays in it', async () => {
    serve([mark()])
    nav.params = new URLSearchParams('doc=doc-1&review=1&mark=ann-1')
    render(pane())

    expect((await screen.findByTestId('review-mode')).dataset.focus).toBe('ann-1')
    await waitFor(() => expect(screen.getAllByTestId('annotations-summary-row')).toHaveLength(1))
    for (const [href] of nav.replace.mock.calls) expect(href).toContain('review=1')
  })

  it('closes on Back, when the url lets go of it', async () => {
    serve([])
    nav.params = new URLSearchParams('doc=doc-1&review=1')
    const { rerender } = render(pane())
    await screen.findByTestId('review-mode')

    nav.params = new URLSearchParams('doc=doc-1')
    rerender(pane())

    await waitFor(() => expect(screen.queryByTestId('review-mode')).toBeNull())
  })

  it('goes Back to the page it was opened from', async () => {
    serve([])
    const { rerender } = render(pane())
    fireEvent.click(await screen.findByRole('button', { name: 'Open review' }))
    nav.params = new URLSearchParams('doc=doc-1&review=1')
    rerender(pane())
    fireEvent.click(screen.getByRole('button', { name: 'close review' }))
    expect(nav.back).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('review-mode')).toBeNull()
  })

  it('takes a link it did not push off with a replace', async () => {
    serve([])
    nav.params = new URLSearchParams('doc=doc-1&review=1&tool=region')
    render(pane())
    fireEvent.click(await screen.findByRole('button', { name: 'close review' }))
    expect(nav.back).not.toHaveBeenCalled()
    expect(nav.replace).toHaveBeenLastCalledWith('/app/projects/proj-1/files?doc=doc-1', { scroll: false })
  })

  it('returns to the page a link came from (Offene Punkte with its filters), not to the bare document', async () => {
    serve([mark()])
    const back = '/app/projects/proj-1/files/open-points?assignee=me'
    nav.params = new URLSearchParams(`doc=doc-1&review=1&mark=ann-1&back=${encodeURIComponent(back)}`)
    render(pane())
    // At the link's mark, its list read, as a reader is before they close: the address has settled.
    expect((await screen.findByTestId('review-mode')).dataset.focus).toBe('ann-1')
    await waitFor(() => expect(screen.getAllByTestId('annotations-summary-row')).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: 'close review' }))
    expect(nav.back).not.toHaveBeenCalled()
    expect(nav.replace).toHaveBeenLastCalledWith(back, { scroll: false })
  })

  /** This tab's history as the Navigation API lists it, the review the last entry. */
  const historyBehind = (...paths: string[]) => {
    const origin = window.location.origin
    const entries = [...paths, `/app/projects/proj-1/files?${nav.params.toString()}`].map((path) => ({ url: `${origin}${path}` }))
    Object.defineProperty(window, 'navigation', {
      configurable: true,
      value: { entries: () => entries, currentEntry: { index: entries.length - 1 } },
    })
  }
  /** The address a link opens: the review at its mark, with where it came from. */
  const openFromLink = (back: string) => {
    nav.params = new URLSearchParams(`doc=doc-1&review=1&mark=ann-1&back=${encodeURIComponent(back)}`)
  }
  /** At the link's mark, its list read, as a reader is before they close: then close. */
  const closeSettled = async () => {
    render(pane())
    expect((await screen.findByTestId('review-mode')).dataset.focus).toBe('ann-1')
    await waitFor(() => expect(screen.getAllByTestId('annotations-summary-row')).toHaveLength(1))
    nav.replace.mockReset()
    fireEvent.click(screen.getByRole('button', { name: 'close review' }))
  }

  describe('a link back to a page that is the entry one step back', () => {
    afterEach(() => {
      Reflect.deleteProperty(window, 'navigation')
    })

    it('goes Back to the Postfach opened from Dateien of the same project, so it is in history once', async () => {
      serve([mark()])
      const back = '/app/inbox?filter=unread'
      // The review's path is Dateien's, as the entry two back: only the query tells them apart.
      openFromLink(back)
      historyBehind('/app/projects/proj-1/files', back)
      await closeSettled()
      expect(nav.back).toHaveBeenCalledTimes(1)
      expect(nav.replace).not.toHaveBeenCalled()
    })

    it('goes Back to Offene Punkte with its filters, opened from Dateien', async () => {
      serve([mark()])
      const back = '/app/projects/proj-1/files/open-points?assignee=me'
      openFromLink(back)
      historyBehind('/app/projects/proj-1/files', back)
      await closeSettled()
      expect(nav.back).toHaveBeenCalledTimes(1)
      expect(nav.replace).not.toHaveBeenCalled()
    })

    it('replaces with the Postfach when the entry behind is the review it was „Übernommen aus“, not the Postfach', async () => {
      serve([mark()])
      const back = '/app/inbox?filter=unread'
      openFromLink(back)
      historyBehind(back, `/app/projects/proj-1/files?doc=doc-0&review=1&mark=ann-0&back=${encodeURIComponent(back)}`)
      await closeSettled()
      expect(nav.back).not.toHaveBeenCalled()
      expect(nav.replace).toHaveBeenLastCalledWith(back, { scroll: false })
    })

    it('replaces when the browser has no Navigation API, whatever is behind', async () => {
      serve([mark()])
      const back = '/app/inbox?filter=unread'
      openFromLink(back)
      window.history.pushState(null, '', window.location.href)
      await closeSettled()
      expect(nav.back).not.toHaveBeenCalled()
      expect(nav.replace).toHaveBeenLastCalledWith(back, { scroll: false })
    })
  })

  it('never follows a return path out of the app', async () => {
    serve([])
    nav.params = new URLSearchParams(`doc=doc-1&review=1&back=${encodeURIComponent('https://evil.example/app/x')}`)
    render(pane())
    fireEvent.click(await screen.findByRole('button', { name: 'close review' }))
    expect(nav.replace).toHaveBeenLastCalledWith('/app/projects/proj-1/files?doc=doc-1', { scroll: false })
  })
})

describe('the row behind the pane says what the review says', () => {
  it('hands the listing the tally the review counts once its list is read, as the server counts it', async () => {
    serve([
      mark({ id: 'ann-1', status: 'open', assigneeUserId: 'user_me' }),
      mark({ id: 'ann-2', number: 2, status: 'open' }),
      mark({ id: 'ann-3', number: 3, status: 'proposed', authorKind: 'piloti' }),
      mark({ id: 'ann-4', number: 4, status: 'resolved' }),
    ])
    const onMarksChanged = vi.fn()
    // The listing was read when all five were open.
    render(pane({ file: { ...FILE, marks: { open: 5, proposed: 0, forYou: 0 } }, viewerUserId: 'user_me', onMarksChanged }))
    await waitFor(() => expect(onMarksChanged).toHaveBeenCalledWith('doc-1', { open: 2, proposed: 1, forYou: 1 }))
  })

  it('says nothing is live with null, as the listing does, and nothing at all when the row already says it', async () => {
    serve([mark({ status: 'resolved' })])
    const onMarksChanged = vi.fn()
    const { rerender } = render(pane({ file: { ...FILE, marks: { open: 5, proposed: 0, forYou: 0 } }, onMarksChanged }))
    await waitFor(() => expect(onMarksChanged).toHaveBeenCalledWith('doc-1', null))

    onMarksChanged.mockReset()
    rerender(pane({ file: { ...FILE, marks: null }, onMarksChanged }))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(onMarksChanged).not.toHaveBeenCalled()
  })

  it('never hands the next document the last one’s tally while its own list is on the way', async () => {
    const pending = new Set(['doc-2'])
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.endsWith('/annotations')) {
        if ([...pending].some((id) => url.includes(id))) return new Promise<Response>(() => {})
        return json({ annotations: [mark()], canAnnotate: true, pilotiWakes: false })
      }
      if (url.endsWith('/preview')) return json({ url: 'https://example.test/plan.pdf', contentType: 'application/pdf' })
      return json({}, 404)
    })
    const onMarksChanged = vi.fn()
    const { rerender } = render(pane({ file: { ...FILE, marks: null }, onMarksChanged }))
    await waitFor(() => expect(onMarksChanged).toHaveBeenCalledWith('doc-1', { open: 1, proposed: 0, forYou: 0 }))

    // The pane is reused for another document, whose listing row says three are open.
    rerender(pane({ file: { ...FILE, id: 'doc-2', marks: { open: 3, proposed: 0, forYou: 0 } }, onMarksChanged }))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(onMarksChanged.mock.calls.filter(([id]) => id === 'doc-2')).toEqual([])
  })
})

describe('„Anmerken"', () => {
  it('in the viewer pill opens the review with the point in hand', async () => {
    serve([])
    render(pane())
    fireEvent.click(await screen.findByTestId('inline-annotate'))

    const review = await screen.findByTestId('review-mode')
    expect(review.dataset.tool).toBe('point')
    expect(review.dataset.initialTool).toBe('point')
    expect(nav.push).toHaveBeenCalledWith('/app/projects/proj-1/files?doc=doc-1&review=1&tool=point', { scroll: false })
  })

  it('is not offered to a reader who may not set marks', async () => {
    serve([], { canAnnotate: false })
    render(pane())
    await screen.findByTestId('annotations-summary-empty')
    expect(screen.queryByTestId('inline-annotate')).toBeNull()
  })
})

describe('the rail section', () => {
  it('stands while the marks load', async () => {
    serve('pending')
    render(pane())
    expect(await screen.findByTestId('annotations-summary-loading')).toBeInTheDocument()
  })

  it('says when the marks could not be read, and reads them again', async () => {
    const calls = serve('error')
    render(pane())
    const failed = await screen.findByTestId('annotations-summary-error')
    const before = calls.annotations
    fireEvent.click(within(failed).getByRole('button', { name: /try again/i }))
    await waitFor(() => expect(calls.annotations).toBe(before + 1))
  })

  it('says where a mark of an earlier Fassung was set', async () => {
    serve([mark({ onCurrentRevision: false, revisionNumber: 2 })])
    render(pane())
    expect(await screen.findByTestId('annotations-summary-earlier')).toHaveTextContent('set on revision 2')
  })
})

describe('the phone reader', () => {
  const phone = (query: string) => query.includes('40rem')

  it('offers „Anmerken" at the thumb, which arms the point', async () => {
    media(phone)
    serve([])
    render(pane({ onClose: () => {} }))
    const bar = screen.getByTestId('file-reader-bar')
    fireEvent.click(await within(bar).findByRole('button', { name: 'Annotate' }))
    expect((await screen.findByTestId('review-mode')).dataset.tool).toBe('point')
  })

  it('says how many marks there are, and opens them', async () => {
    media(phone)
    serve([mark(), mark({ id: 'ann-2', number: 2 })])
    render(pane({ onClose: () => {} }))
    const bar = screen.getByTestId('file-reader-bar')
    const button = await within(bar).findByRole('button', { name: '2 annotations' })
    expect(button).toHaveTextContent('Annotations2')
    fireEvent.click(button)
    expect((await screen.findByTestId('review-mode')).dataset.tool).toBe('select')
  })
})

describe('a pin in the preview', () => {
  it('shows its mark when the pointer rests on it, and opens the review at it', async () => {
    media((query) => query === HOVER_QUERY)
    serve([mark({ replies: [] })])
    render(pane())
    const pin = await screen.findByTestId('review-pin')
    fireEvent.pointerEnter(pin)

    const peek = await screen.findByTestId('inline-mark-peek')
    expect(peek).toHaveTextContent('Tür ohne Feuerwiderstandsklasse')
    expect(peek).toHaveTextContent('Anna Berger')
    fireEvent.click(within(peek).getByRole('button', { name: 'Open in the review' }))
    expect((await screen.findByTestId('review-mode')).dataset.focus).toBe('ann-1')
  })

  it('stays a click on a touch screen', async () => {
    media(() => false)
    serve([mark()])
    render(pane())
    fireEvent.pointerEnter(await screen.findByTestId('review-pin'))
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(screen.queryByTestId('inline-mark-peek')).toBeNull()
  })
})
