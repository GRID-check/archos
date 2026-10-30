import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@/test-utils'

import type { InboxItemView } from '@/lib/inbox/types'

const toastMock = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: toastMock }))

vi.mock('../hooks/use-inbox', () => ({ useInboxList: vi.fn(), useInboxBadge: vi.fn() }))

/** The address the queue is read at: the Postfach, or the page beside the dock. */
const page = vi.hoisted(() => ({ pathname: '/app/inbox', search: '' }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => page.pathname,
  useSearchParams: () => new URLSearchParams(page.search),
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

function hook(items: InboxItemView[]): UseInboxListResult {
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
  }
}

const late = row('late', { resourceId: 'doc-s', subject: 'Schnitt A-A', excerpt: 'Brüstung zu niedrig', variant: 'overdue', dueOn: '2026-10-15', href: '/app/projects/p2/files?doc=doc-s&review=1&mark=mark-late' })
const fresh = row('fresh', { excerpt: 'Türbreite prüfen' })
const news = row('news', { type: 'conversation.activity', resourceType: 'conversation', resourceId: 'c1', actionable: false, excerpt: 'Passt so', answerIn: null, anchorId: null, href: '/app/projects/p1/chat?session=c1' })

let waiting: UseInboxListResult
let unread: UseInboxListResult

/** The two reads the queue asks for: `requests` and `unread`. */
function serve(waitingRows: InboxItemView[], unreadRows: InboxItemView[]): void {
  waiting = hook(waitingRows)
  unread = hook(unreadRows)
  useInboxListMock.mockImplementation((_enabled, filter) => (filter === 'requests' ? waiting : unread))
}

const entries = (): HTMLElement[] => screen.getAllByTestId('inbox-queue-entry')

beforeEach(() => {
  page.pathname = '/app/inbox'
  page.search = ''
  serve([fresh, late], [fresh, news])
})
afterEach(() => vi.clearAllMocks())

describe('InboxQueue — what waits on the reader, and the news', () => {
  test('reads the two questions it answers: the open requests and what is unread', () => {
    render(<InboxQueue />)
    expect(useInboxListMock).toHaveBeenCalledWith(true, 'requests', expect.anything())
    expect(useInboxListMock).toHaveBeenCalledWith(true, 'unread', expect.anything())
  })

  test('puts the late document first, gathers by document, and keeps the news apart', () => {
    render(<InboxQueue />)
    const groups = screen.getAllByTestId('inbox-queue-group')
    expect(groups[0]).toHaveTextContent('Schnitt A-A')
    expect(within(groups[0]).getByTestId('inbox-queue-due')).toHaveTextContent('Overdue')
    // An unread request is waiting, not news.
    expect(within(screen.getByTestId('inbox-queue-news')).getAllByTestId('inbox-queue-entry')).toHaveLength(1)
    expect(screen.getByTestId('inbox-queue-summary')).toHaveTextContent('2 are waiting on you, 1 of them overdue')
  })

  test('says it is done when nothing waits and nothing is new', () => {
    serve([], [])
    render(<InboxQueue />)
    expect(screen.getByText('All caught up')).toBeInTheDocument()
  })

  test('marks the news read from its section', () => {
    render(<InboxQueue />)
    fireEvent.click(screen.getByTestId('inbox-queue-news-read'))
    expect(unread.markAllRead).toHaveBeenCalled()
  })
})

describe('InboxQueue — every entry is a link to its real place', () => {
  test('following an entry reads it; a background tab does not', () => {
    render(<InboxQueue />)
    fireEvent.click(entries()[0], { metaKey: true })
    expect(waiting.markRead).not.toHaveBeenCalled()
    fireEvent.click(entries()[0])
    expect(waiting.markRead).toHaveBeenCalledWith(['late'])
  })

  test('on the Postfach page, a review it opens comes back here; docked, it does not leave', () => {
    const { unmount } = render(<InboxQueue />)
    expect(entries()[0]).toHaveAttribute('href', expect.stringContaining('back=%2Fapp%2Finbox'))
    unmount()
    render(<InboxQueue returnHere={false} />)
    expect(entries()[0]).toHaveAttribute('href', '/app/projects/p2/files?doc=doc-s&review=1&mark=mark-late')
  })

  test('the entry whose place the reader is at is current, read from the address', () => {
    page.pathname = '/app/projects/p1/chat'
    page.search = 'session=c1'
    render(<InboxQueue returnHere={false} />)
    const current = entries().filter((entry) => entry.getAttribute('aria-current') === 'page')
    expect(current).toHaveLength(1)
    expect(current[0]).toHaveAttribute('data-item-id', 'news')
  })

  test('the archive control beside an entry puts it away with an undo', () => {
    render(<InboxQueue />)
    fireEvent.click(screen.getAllByTestId('inbox-queue-archive')[0])
    expect(toastMock).toHaveBeenCalledWith('Archived', expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) }))
    // Held for the undo window: gone from the list, the server not told yet.
    expect(entries().map((entry) => entry.getAttribute('data-item-id'))).not.toContain('late')
    expect(waiting.archive).not.toHaveBeenCalled()
  })

  test('every entry keeps room at its end for the archive control, which a finger always sees', () => {
    render(<InboxQueue />)
    // An entry's own `px-*` once merged the room away and put the text under the button.
    for (const entry of entries()) expect(entry.className.split(' ')).toContain('pr-9')
  })
})

describe('InboxQueue — keys', () => {
  test('j and k move the focus between entries; Enter is then the link’s own', () => {
    render(<InboxQueue />)
    fireEvent.keyDown(window, { key: 'j' })
    expect(entries()[0]).toHaveFocus()
    fireEvent.keyDown(window, { key: 'j' })
    expect(entries()[1]).toHaveFocus()
    fireEvent.keyDown(window, { key: 'k' })
    expect(entries()[0]).toHaveFocus()
  })

  test('e archives the focused entry and hands the focus on; u toggles it read', () => {
    render(<InboxQueue />)
    fireEvent.keyDown(window, { key: 'j' })
    fireEvent.keyDown(window, { key: 'u' })
    expect(waiting.markRead).toHaveBeenCalledWith(['late'])
    fireEvent.keyDown(window, { key: 'e' })
    expect(toastMock).toHaveBeenCalled()
    expect(entries()[0]).toHaveAttribute('data-item-id', 'fresh')
  })

  test('docked beside a page, the keys are the list’s only while the focus is in it', () => {
    render(<InboxQueue keyScope="self" />)
    fireEvent.keyDown(window, { key: 'j' })
    expect(document.body).toHaveFocus()
    entries()[0].focus()
    fireEvent.keyDown(entries()[0], { key: 'j' })
    expect(entries()[1]).toHaveFocus()
  })
})
