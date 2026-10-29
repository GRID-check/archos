import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@/test-utils'

import type { InboxItemView } from '@/lib/inbox/types'
import type { AnnotationView } from '@/lib/annotations/types'

const toastMock = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: toastMock }))

vi.mock('../hooks/use-inbox', () => ({ useInboxList: vi.fn(), useInboxBadge: vi.fn() }))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/app/inbox',
  useSearchParams: () => new URLSearchParams(''),
}))

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

import { useInboxList, type UseInboxListResult } from '../hooks/use-inbox'
import { InboxQueue } from './InboxQueue'

const useInboxListMock = vi.mocked(useInboxList)

const row = (id: string, overrides: Partial<InboxItemView> = {}): InboxItemView => ({
  id,
  type: 'annotation.assigned_to_you',
  state: 'unread',
  archived: false,
  actionable: true,
  resourceType: 'document',
  resourceId: 'doc-eg',
  anchorId: `mark-${id}`,
  actorName: 'Anna Weber',
  actorUserId: 'u-anna',
  count: 1,
  href: `/app/projects/p1/files?doc=doc-eg&review=1&mark=mark-${id}`,
  subject: 'Grundriss EG',
  projectName: 'Wohnanlage Linzer Straße',
  related: '4',
  excerpt: `Anmerkung ${id}`,
  mentions: [],
  variant: null,
  answerIn: 'row',
  createdAt: '2026-10-29T08:00:00Z',
  updatedAt: '2026-10-29T08:00:00Z',
  ...overrides,
})

function hook(items: InboxItemView[], overrides: Partial<UseInboxListResult> = {}): UseInboxListResult {
  return {
    items,
    pending: items.length,
    counts: { requests: 0, unread: 0 },
    loading: false,
    error: false,
    mutationError: false,
    dismissMutationError: vi.fn(),
    mutating: false,
    connected: true,
    refresh: vi.fn(),
    hasMore: false,
    loadingMore: false,
    loadMoreFailed: false,
    loadMore: vi.fn(),
    markRead: vi.fn(async () => {}),
    markUnread: vi.fn(async () => {}),
    markAllRead: vi.fn(async () => {}),
    archive: vi.fn(async () => {}),
    unarchive: vi.fn(async () => true),
    ...overrides,
  }
}

const late = row('late', { resourceId: 'doc-s', subject: 'Schnitt A-A', excerpt: 'Brüstung zu niedrig', variant: 'overdue', dueOn: '2026-10-15' })
const fresh = row('fresh', { excerpt: 'Türbreite prüfen' })
const news = row('news', { type: 'annotation.activity', actionable: false, excerpt: 'Passt so', answerIn: null })

let waiting: UseInboxListResult
let unread: UseInboxListResult

/** The two reads the queue asks for: `requests` and `unread`. */
function serve(waitingRows: InboxItemView[], unreadRows: InboxItemView[]): void {
  waiting = hook(waitingRows)
  unread = hook(unreadRows)
  useInboxListMock.mockImplementation((_enabled, filter) => (filter === 'requests' ? waiting : unread))
}

const readMark = vi.fn(async (documentId: string, annotationId: string) => ({ id: annotationId, documentId, body: 'x', replies: [], mentions: [] }) as unknown as AnnotationView)

/** Where the detail sits beside the list (from `lg`): the pane is displayed, so it has an offset parent. */
function besideTheList(): void {
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', { configurable: true, get: () => document.body })
}

beforeEach(() => serve([fresh, late], [fresh, news]))
afterEach(() => {
  Reflect.deleteProperty(HTMLElement.prototype, 'offsetParent')
  vi.clearAllMocks()
})

describe('InboxQueue — what waits on the reader, and the news', () => {
  test('reads the two questions it answers: the open requests and what is unread', () => {
    render(<InboxQueue readMark={readMark} />)
    expect(useInboxListMock).toHaveBeenCalledWith(true, 'requests', expect.anything())
    expect(useInboxListMock).toHaveBeenCalledWith(true, 'unread', expect.anything())
  })

  test('puts the late document first, gathers by document, and keeps the news apart', () => {
    render(<InboxQueue readMark={readMark} />)
    const groups = screen.getAllByTestId('inbox-queue-group')
    expect(groups.map((group) => within(group).getAllByTestId('inbox-queue-entry').length)).toEqual([1, 1])
    expect(groups[0]).toHaveTextContent('Schnitt A-A')
    expect(within(groups[0]).getByTestId('inbox-queue-due')).toHaveTextContent('Overdue')
    // An unread request is waiting, not news.
    expect(within(screen.getByTestId('inbox-queue-news')).getAllByTestId('inbox-queue-entry')).toHaveLength(1)
    expect(screen.getByTestId('inbox-queue-summary')).toHaveTextContent('2 are waiting on you, 1 of them overdue')
  })

  test('says it is done when nothing waits and nothing is new', () => {
    serve([], [])
    render(<InboxQueue readMark={readMark} />)
    expect(screen.getByText('All caught up')).toBeInTheDocument()
    expect(screen.queryByTestId('inbox-queue-group')).not.toBeInTheDocument()
  })

  test('marks the news read from its section', () => {
    render(<InboxQueue readMark={readMark} />)
    fireEvent.click(screen.getByTestId('inbox-queue-news-read'))
    expect(unread.markAllRead).toHaveBeenCalled()
  })
})

describe('InboxQueue — an entry is its link, or a selection beside the list', () => {
  test('without the detail on screen, an entry is a link, and following it reads it', () => {
    render(<InboxQueue readMark={readMark} />)
    const entry = screen.getAllByTestId('inbox-queue-entry')[0]
    expect(entry).toHaveAttribute('href', expect.stringContaining('mark=mark-late'))
    expect(entry).toHaveAttribute('href', expect.stringContaining('back='))
    // Nothing stands selected on a list that shows no detail.
    expect(entry).not.toHaveAttribute('aria-current')
    expect(fireEvent.click(entry)).toBe(true)
    expect(waiting.markRead).toHaveBeenCalledWith(['late'])
  })

  test('beside the list, a click shows the entry there instead of leaving, and reads it', () => {
    besideTheList()
    render(<InboxQueue readMark={readMark} />)
    // The most urgent entry stands selected before the reader picks one, and is not read for it.
    expect(screen.getByTestId('inbox-detail')).toHaveTextContent('Brüstung zu niedrig')
    expect(waiting.markRead).not.toHaveBeenCalled()
    const second = screen.getAllByTestId('inbox-queue-entry')[1]
    expect(fireEvent.click(second)).toBe(false)
    expect(screen.getByTestId('inbox-detail')).toHaveTextContent('Türbreite prüfen')
    expect(second).toHaveAttribute('aria-current', 'true')
    expect(waiting.markRead).toHaveBeenCalledWith(['fresh'])
  })

  test('j and k walk the queue, then the news; e archives with an undo', () => {
    besideTheList()
    render(<InboxQueue readMark={readMark} />)
    fireEvent.keyDown(window, { key: 'j' })
    expect(screen.getByTestId('inbox-detail')).toHaveTextContent('Türbreite prüfen')
    fireEvent.keyDown(window, { key: 'j' })
    expect(screen.getByTestId('inbox-detail')).toHaveTextContent('Passt so')
    fireEvent.keyDown(window, { key: 'k' })
    fireEvent.keyDown(window, { key: 'e' })
    expect(toastMock).toHaveBeenCalledWith('Archived', expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) }))
    // Held for the undo window: the row is gone from the list, the server not told yet.
    expect(screen.queryByText('Türbreite prüfen', { selector: 'span' })).not.toBeInTheDocument()
    expect(waiting.archive).not.toHaveBeenCalled()
  })
})
