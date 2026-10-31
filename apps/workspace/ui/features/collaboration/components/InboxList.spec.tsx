import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, onTestFinished, test, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@/test-utils'

import type { InboxItemView } from '@/lib/inbox/types'

// The undo toast is the contract; sonner is stubbed so its action can be pressed.
const toastMock = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: toastMock }))

// The data hooks are already built and tested; this spec is about the four states
// the list can be in and the controls around them, so the hook is stubbed.
vi.mock('../hooks/use-inbox', () => ({
  useInboxList: vi.fn(),
  useInboxBadge: vi.fn(),
}))

/** The page's address, played by the test: the Postfach's own, with whatever query it carries. */
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

import { useInboxBadge, useInboxList, type UseInboxListResult } from '../hooks/use-inbox'
import { InboxList } from './InboxList'
import { PRODUCT_NAME } from '@/lib/brand'

const useInboxListMock = vi.mocked(useInboxList)
const useInboxBadgeMock = vi.mocked(useInboxBadge)

/**
 * „Für mich“, the default, is the queue (`InboxQueue`, its own spec); the
 * flat list these specs exercise is „Alle“ and „Archiviert“. So the address
 * names „Alle“ unless a spec is about „Für mich“ and clears it.
 */
beforeEach(() => {
  page.search = 'filter=all'
  useInboxBadgeMock.mockReturnValue({ pending: 0, connected: true, refresh: vi.fn() })
})

const refresh = vi.fn()
const markRead = vi.fn(async () => {})
const markUnread = vi.fn(async () => {})
const markAllRead = vi.fn(async () => {})
const archive = vi.fn(async () => {})
const unarchive = vi.fn(async () => true)
const loadMore = vi.fn()
const dismissMutationError = vi.fn()

function result(overrides: Partial<UseInboxListResult> = {}): UseInboxListResult {
  return {
    items: [],
    pending: 0,
    counts: { requests: 0, unread: 0 },
    hasMore: false,
    loadingMore: false,
    loadMoreFailed: false,
    loadMore,
    markUnread,
    unarchive,
    loading: false,
    error: false,
    mutationError: false,
    dismissMutationError,
    mutating: false,
    connected: true,
    refresh,
    markRead,
    markAllRead,
    archive,
    ...overrides,
  }
}

const ITEM: InboxItemView = {
  id: 'i1',
  type: 'mention.requested',
  state: 'unread',
  archived: false,
  read: false,
  actionable: true,
  resourceType: 'conversation',
  resourceId: 'c1',
  anchorId: null,
  actorName: 'Anna Weber',
  actorUserId: 'u-anna',
  count: 1,
  href: '/app/projects/p1/chat?session=c1',
  subject: 'Atrium',
  related: null,
  excerpt: null,
  mentions: [],
  variant: null,
  answerIn: null,
  createdAt: '2026-07-29T09:00:00Z',
  updatedAt: '2026-07-29T09:00:00Z',
}

/** Default locale in an unprovided test tree is `en`. */
describe('InboxList — filters', () => {
  beforeEach(() => {
    useInboxListMock.mockReturnValue(result({ items: [ITEM], pending: 1 }))
  })

  test('defaults to "needs me", which reads what the badge counts: open requests and anything unread', () => {
    page.search = ''
    render(<InboxList />)
    // The queue reads its two questions; the flat list's own read idles.
    expect(useInboxListMock).toHaveBeenCalledWith(true, 'requests', expect.anything())
    expect(useInboxListMock).toHaveBeenCalledWith(true, 'unread', expect.anything())
    expect(useInboxListMock).not.toHaveBeenCalledWith(true, 'pending')
    const needsMe = screen.getByRole('radio', { name: /Needs me/ })
    const all = screen.getByRole('radio', { name: 'All' })
    expect(needsMe).toHaveAttribute('data-state', 'on')
    expect(needsMe).toHaveAttribute('aria-checked', 'true')
    expect(all).toHaveAttribute('data-state', 'off')
    expect(all).toHaveAttribute('aria-checked', 'false')
  })

  test('the toggles are a labelled radiogroup, not two loose buttons', () => {
    render(<InboxList />)
    expect(screen.getByRole('radiogroup', { name: 'Filter inbox' })).toBeInTheDocument()
  })

  test('switching to "all" re-reads everything unarchived', () => {
    render(<InboxList />)
    fireEvent.click(screen.getByRole('radio', { name: 'All' }))
    expect(useInboxListMock).toHaveBeenLastCalledWith(true, 'all')
    const all = screen.getByRole('radio', { name: 'All' })
    expect(all).toHaveAttribute('data-state', 'on')
    expect(all).toHaveAttribute('aria-checked', 'true')
  })

  test('keeps the filter in the address without a server render, so a review closed from a row comes back to it', () => {
    const replaceState = vi.spyOn(window.history, 'replaceState')
    page.search = 'tab=x'
    try {
      render(<InboxList />)
      fireEvent.click(screen.getByRole('radio', { name: 'All' }))
      expect(replaceState).toHaveBeenLastCalledWith(null, '', '/app/inbox?tab=x&filter=all')
      // „Needs me“ is the default, and the address does not say it.
      fireEvent.click(screen.getByRole('radio', { name: /Needs me/ }))
      expect(replaceState).toHaveBeenLastCalledWith(null, '', '/app/inbox?tab=x')
    } finally {
      page.search = ''
      replaceState.mockRestore()
    }
  })

  test('opens on the filter the address names, as the reader left it', () => {
    page.search = 'filter=archived'
    try {
      render(<InboxList />)
      expect(useInboxListMock).toHaveBeenCalledWith(true, 'archived')
      expect(screen.getByRole('radio', { name: 'Archived' })).toHaveAttribute('aria-checked', 'true')
    } finally {
      page.search = ''
    }
  })

  test('passes the disabled flag through, so a gated org issues no request', () => {
    page.search = ''
    render(<InboxList enabled={false} />)
    expect(useInboxListMock).toHaveBeenCalledWith(false, 'pending')
  })

  test('„Archived“ is a filter of its own, reading its own slice; „Unread“ is no tab beside „Needs me“, which holds it', () => {
    render(<InboxList />)
    expect(screen.queryByRole('radio', { name: 'Unread' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: 'Archived' }))
    expect(useInboxListMock).toHaveBeenLastCalledWith(true, 'archived')
  })

  test('an old address naming „unread“ opens on „Needs me“, where those rows now are', () => {
    page.search = 'filter=unread'
    try {
      render(<InboxList />)
      expect(useInboxListMock).toHaveBeenCalledWith(true, 'requests', expect.anything())
    } finally {
      page.search = ''
    }
  })

  test('the selected filter wears a filled thumb', () => {
    page.search = ''
    render(<InboxList />)
    const needsMe = screen.getByRole('radio', { name: /Needs me/ })
    expect(needsMe.querySelector('[data-slot="toggle-pill"]')).toHaveClass('bg-foreground')
  })

  test('„Needs me“ carries the badge’s own number, and no pill at zero', () => {
    // The bell and the tab said different numbers (18 and 8): the tab counted
    // requests alone. It says what the badge says now, whichever filter is open.
    useInboxBadgeMock.mockReturnValue({ pending: 7, connected: true, refresh: vi.fn() })
    page.search = ''
    const { unmount } = render(<InboxList />)
    expect(screen.getByRole('radio', { name: /Needs me/ })).toHaveTextContent('Needs me7')
    expect(screen.getByRole('radio', { name: 'All' }).querySelector('[data-slot="count-pill"]')).toBeNull()
    unmount()
    useInboxBadgeMock.mockReturnValue({ pending: 0, connected: true, refresh: vi.fn() })
    render(<InboxList />)
    expect(screen.getByRole('radio', { name: /Needs me/ }).querySelector('[data-slot="count-pill"]')).toBeNull()
  })
})

describe('InboxList — states', () => {
  test('loading renders a skeleton in the list shape, not a spinner', () => {
    useInboxListMock.mockReturnValue(result({ loading: true }))
    render(<InboxList />)
    expect(screen.getByTestId('inbox-skeleton')).toBeInTheDocument()
    expect(screen.queryByTestId('inbox-item')).not.toBeInTheDocument()
  })

  test('a load failure shows real copy and a retry that re-reads', () => {
    useInboxListMock.mockReturnValue(result({ error: true }))
    render(<InboxList />)

    expect(screen.getByText('Your inbox could not be loaded.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(refresh).toHaveBeenCalled()
  })

  test('the empty state differs by filter', () => {
    useInboxListMock.mockReturnValue(result())
    page.search = ''
    render(<InboxList />)

    expect(screen.getByText('All caught up')).toBeInTheDocument()
    expect(screen.getByText('What is new or waiting on you appears here. What you have already read is under “All”.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('radio', { name: 'All' }))
    expect(screen.getByText('Your inbox is empty')).toBeInTheDocument()
    expect(screen.getByText(`News from your team and from ${PRODUCT_NAME} appears here.`)).toBeInTheDocument()
    expect(screen.queryByText('All caught up')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('radio', { name: 'Archived' }))
    expect(screen.getByText('Nothing archived')).toBeInTheDocument()
  })

  test('renders one row per item, driven by the type registry', () => {
    useInboxListMock.mockReturnValue(result({ items: [ITEM], pending: 1 }))
    render(<InboxList />)
    expect(screen.getAllByTestId('inbox-item')).toHaveLength(1)
    expect(screen.getByText('Anna Weber asked for your input')).toBeInTheDocument()
  })

  test('announces the count politely, without reading the list aloud (NF-3)', () => {
    useInboxListMock.mockReturnValue(result({ items: [ITEM], pending: 1 }))
    render(<InboxList />)
    // The live region is a small status node. It used to be the list container,
    // so every filter change and every archive re-announced all fifty rows.
    expect(screen.getByTestId('inbox-list')).not.toHaveAttribute('aria-live')
    const status = screen.getByRole('status')
    expect(status).toHaveAttribute('aria-live', 'polite')
    expect(status).toHaveTextContent('1 item needs your attention')
    expect(status).not.toHaveTextContent('Anna Weber')
  })

  test('says nothing when nothing needs the reader', () => {
    // The region is re-read on every filter change and every archive, so an empty
    // queue used to interrupt with "0 items need your attention" — an
    // announcement about nothing, repeated.
    useInboxListMock.mockReturnValue(result({ items: [], pending: 0 }))
    render(<InboxList />)
    expect(screen.getByRole('status')).toHaveTextContent('')
    expect(screen.queryByText(/0 items/)).not.toBeInTheDocument()
  })

  test('a refused action is reported beside the list, not instead of it', () => {
    // Archiving a row a second tab already archived used to replace every row
    // with "Your inbox could not be loaded." — which had not happened.
    useInboxListMock.mockReturnValue(result({ items: [ITEM], pending: 1, mutationError: true }))
    render(<InboxList />)
    expect(screen.getAllByTestId('inbox-item')).toHaveLength(1)
    expect(screen.getByText(/That action could not be completed/)).toBeInTheDocument()
    expect(screen.queryByText('Your inbox could not be loaded.')).not.toBeInTheDocument()
    // The refusal path does not re-read the list, so the alert must not claim it
    // did: the rows on screen are the ones that were already there.
    expect(refresh).not.toHaveBeenCalled()
    expect(screen.getByText(/Your inbox is unchanged\./)).toBeInTheDocument()
  })

  test('the bulk action stands down while it is in flight', () => {
    useInboxListMock.mockReturnValue(
      result({ items: [ITEM], pending: 1, mutating: true }),
    )
    render(<InboxList />)
    expect(screen.getByRole('button', { name: 'Mark all as read' })).toBeDisabled()
  })
})

describe('InboxList — actions', () => {
  test('mark-all-read is not offered on an empty list, nor under „Archived“', () => {
    useInboxListMock.mockReturnValue(result())
    render(<InboxList />)
    expect(screen.queryByRole('button', { name: 'Mark all as read' })).not.toBeInTheDocument()

    useInboxListMock.mockReturnValue(result({ items: [{ ...ITEM, state: 'archived' }] }))
    fireEvent.click(screen.getByRole('radio', { name: 'Archived' }))
    expect(screen.queryByRole('button', { name: 'Mark all as read' })).not.toBeInTheDocument()
  })

  test('says there are older items, and loads them on request', () => {
    useInboxListMock.mockReturnValue(result({ items: [ITEM], pending: 1, hasMore: true }))
    render(<InboxList />)
    fireEvent.click(screen.getByRole('button', { name: 'Load older items' }))
    expect(loadMore).toHaveBeenCalled()
  })

  test('says nothing about older items when there are none', () => {
    useInboxListMock.mockReturnValue(result({ items: [ITEM], pending: 1, hasMore: false }))
    render(<InboxList />)
    expect(screen.queryByRole('button', { name: 'Load older items' })).not.toBeInTheDocument()
  })

  test('mark-all-read is disabled while nothing is unread', () => {
    useInboxListMock.mockReturnValue(result({ items: [{ ...ITEM, state: 'read', read: true }] }))
    render(<InboxList />)
    expect(screen.getByRole('button', { name: 'Mark all as read' })).toBeDisabled()
  })

  test('mark-all-read is enabled and wired when something is unread', () => {
    useInboxListMock.mockReturnValue(result({ items: [ITEM], pending: 1 }))
    render(<InboxList />)

    const button = screen.getByRole('button', { name: 'Mark all as read' })
    expect(button).toBeEnabled()
    fireEvent.click(button)
    expect(markAllRead).toHaveBeenCalled()
  })

  describe('archiving', () => {
    beforeEach(() => {
      toastMock.mockClear()
      vi.useFakeTimers()
    })
    afterEach(() => vi.useRealTimers())

    test('hides the row at once and tells the server only when the undo window closes', () => {
      useInboxListMock.mockReturnValue(result({ items: [ITEM], pending: 1 }))
      render(<InboxList />)
      fireEvent.click(screen.getByRole('button', { name: 'Archive' }))

      expect(screen.queryByTestId('inbox-item')).not.toBeInTheDocument()
      expect(toastMock).toHaveBeenCalledWith(
        'Archived',
        expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) }),
      )
      expect(archive).not.toHaveBeenCalled()

      act(() => {
        vi.advanceTimersByTime(5000)
      })
      expect(archive).toHaveBeenCalledWith('i1')
    })

    test('Undo brings the row back and sends nothing', () => {
      useInboxListMock.mockReturnValue(result({ items: [ITEM], pending: 1 }))
      render(<InboxList />)
      fireEvent.click(screen.getByRole('button', { name: 'Archive' }))

      const options = toastMock.mock.calls[0][1] as { action: { onClick: () => void } }
      act(() => options.action.onClick())
      expect(screen.getByTestId('inbox-item')).toBeInTheDocument()

      act(() => {
        vi.advanceTimersByTime(10000)
      })
      expect(archive).not.toHaveBeenCalled()
    })

    test('leaving the list sends an archive that is still waiting', () => {
      useInboxListMock.mockReturnValue(result({ items: [ITEM], pending: 1 }))
      const { unmount } = render(<InboxList />)
      fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
      unmount()
      expect(archive).toHaveBeenCalledWith('i1')
    })
  })

  test('opening an unread row marks just that item read', () => {
    useInboxListMock.mockReturnValue(result({ items: [ITEM], pending: 1 }))
    render(<InboxList />)
    fireEvent.click(screen.getByRole('link'))
    expect(markRead).toHaveBeenCalledWith(['i1'])
  })

  test('opening an already-read row does not re-mark it', () => {
    useInboxListMock.mockReturnValue(result({ items: [{ ...ITEM, state: 'read', read: true }] }))
    render(<InboxList />)
    fireEvent.click(screen.getByRole('link'))
    expect(markRead).not.toHaveBeenCalled()
  })
})

describe('InboxList — keyboard triage', () => {
  const SECOND: InboxItemView = { ...ITEM, id: 'i2', state: 'read', read: true, actorName: 'Markus Hofer', actorUserId: 'u-markus' }

  beforeEach(() => {
    toastMock.mockClear()
    markRead.mockClear()
    markUnread.mockClear()
    useInboxListMock.mockReturnValue(result({ items: [ITEM, SECOND], pending: 1 }))
  })

  const focusedRow = () => document.querySelector('[data-focused="true"]')?.getAttribute('data-item-id') ?? null

  test('j and k move between rows', () => {
    render(<InboxList />)
    fireEvent.keyDown(document.body, { key: 'j' })
    expect(focusedRow()).toBe('i1')
    fireEvent.keyDown(document.body, { key: 'j' })
    expect(focusedRow()).toBe('i2')
    fireEvent.keyDown(document.body, { key: 'j' })
    expect(focusedRow()).toBe('i2')
    fireEvent.keyDown(document.body, { key: 'k' })
    expect(focusedRow()).toBe('i1')
  })

  test('Enter opens the row, which marks it read', () => {
    render(<InboxList />)
    fireEvent.keyDown(document.body, { key: 'j' })
    fireEvent.keyDown(document.body, { key: 'Enter' })
    expect(markRead).toHaveBeenCalledWith(['i1'])
  })

  test('u toggles read, and e archives with the same undo as the button', () => {
    vi.useFakeTimers()
    try {
      render(<InboxList />)
      fireEvent.keyDown(document.body, { key: 'j' })
      fireEvent.keyDown(document.body, { key: 'u' })
      expect(markRead).toHaveBeenCalledWith(['i1'])
      fireEvent.keyDown(document.body, { key: 'j' })
      fireEvent.keyDown(document.body, { key: 'u' })
      expect(markUnread).toHaveBeenCalledWith(['i2'])
      fireEvent.keyDown(document.body, { key: 'e' })
      expect(toastMock).toHaveBeenCalledWith('Archived', expect.objectContaining({ action: expect.anything() }))
      act(() => {
        vi.advanceTimersByTime(5000)
      })
      expect(archive).toHaveBeenCalledWith('i2')
    } finally {
      vi.useRealTimers()
    }
  })

  test('after e, the keyboard focus moves to the next row, in the DOM as well', () => {
    vi.useFakeTimers()
    try {
      render(<InboxList />)
      fireEvent.keyDown(document.body, { key: 'j' })
      fireEvent.keyDown(document.body, { key: 'e' })
      expect(document.activeElement?.getAttribute('data-item-id')).toBe('i2')
    } finally {
      vi.useRealTimers()
    }
  })

  test('typing in a field never triages', () => {
    render(
      <>
        <input aria-label="Elsewhere" />
        <InboxList />
      </>,
    )
    const field = screen.getByLabelText('Elsewhere')
    fireEvent.keyDown(field, { key: 'j' })
    fireEvent.keyDown(field, { key: 'e' })
    expect(focusedRow()).toBeNull()
    expect(toastMock).not.toHaveBeenCalled()
  })
})

describe('InboxList — the focus when a refresh drops its row', () => {
  const SECOND: InboxItemView = { ...ITEM, id: 'i2', actorName: 'Markus Hofer', actorUserId: 'u-markus' }
  const THIRD: InboxItemView = { ...ITEM, id: 'i3', actorName: 'Lena Berger', actorUserId: 'u-lena' }
  const rowOf = (id: string) => document.querySelector<HTMLElement>(`[data-item-id="${id}"]`)
  /** The row's own control holds the focus, as the outcome line does after „Erledigen“. */
  const focusIn = (id: string) => {
    const control = rowOf(id)?.querySelector<HTMLElement>('a, button') ?? rowOf(id)
    act(() => control?.focus())
    expect(rowOf(id)).toContainElement(document.activeElement as HTMLElement)
  }

  test('goes to the row now at its place, when the re-read under „For me“ no longer lists it', async () => {
    useInboxListMock.mockReturnValue(result({ items: [ITEM, SECOND, THIRD], pending: 3 }))
    const { rerender } = render(<InboxList />)
    focusIn('i2')
    // The mark was resolved: the next read of open requests leaves its row out.
    useInboxListMock.mockReturnValue(result({ items: [ITEM, THIRD], pending: 2 }))
    rerender(<InboxList />)
    await waitFor(() => expect(document.activeElement).toBe(rowOf('i3')))
    expect(rowOf('i3')).toHaveAttribute('data-focused', 'true')
  })

  test('hands the focus on without scrolling: the reader stays where they read', async () => {
    const scroll = vi.fn()
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = scroll
    onTestFinished(() => {
      Element.prototype.scrollIntoView = original
    })
    useInboxListMock.mockReturnValue(result({ items: [ITEM, SECOND, THIRD], pending: 3 }))
    const { rerender } = render(<InboxList />)
    focusIn('i2')
    scroll.mockClear()
    useInboxListMock.mockReturnValue(result({ items: [ITEM, THIRD], pending: 2 }))
    rerender(<InboxList />)
    await waitFor(() => expect(document.activeElement).toBe(rowOf('i3')))
    expect(scroll).not.toHaveBeenCalled()
  })

  test('goes to the row before it when it was the last', async () => {
    useInboxListMock.mockReturnValue(result({ items: [ITEM, SECOND], pending: 2 }))
    const { rerender } = render(<InboxList />)
    focusIn('i2')
    useInboxListMock.mockReturnValue(result({ items: [ITEM], pending: 1 }))
    rerender(<InboxList />)
    await waitFor(() => expect(document.activeElement).toBe(rowOf('i1')))
  })

  test('goes to the list when no row is left', async () => {
    useInboxListMock.mockReturnValue(result({ items: [ITEM], pending: 1 }))
    const { rerender } = render(<InboxList />)
    focusIn('i1')
    useInboxListMock.mockReturnValue(result({ items: [], pending: 0 }))
    rerender(<InboxList />)
    await waitFor(() => expect(screen.getByTestId('inbox-list')).toHaveFocus())
  })

  test('leaves the focus where the reader put it since', async () => {
    useInboxListMock.mockReturnValue(result({ items: [ITEM, SECOND], pending: 2 }))
    const { rerender } = render(<InboxList />)
    focusIn('i2')
    const filter = screen.getByRole('radio', { name: /All/ })
    act(() => filter.focus())
    useInboxListMock.mockReturnValue(result({ items: [ITEM], pending: 1 }))
    rerender(<InboxList />)
    await act(async () => {})
    expect(filter).toHaveFocus()
  })
})

describe('InboxList — the archive', () => {
  beforeEach(() => {
    toastMock.mockClear()
    unarchive.mockClear()
    archive.mockClear()
  })

  test('restores an archived row from its menu, and says so once it is true', async () => {
    const userEvent = (await import('@testing-library/user-event')).default
    const user = userEvent.setup()
    useInboxListMock.mockReturnValue(result({ items: [{ ...ITEM, state: 'archived', archived: true }] }))
    render(<InboxList initialFilter="archived" />)
    await user.click(screen.getByRole('button', { name: 'More actions' }))
    await user.click(await screen.findByTestId('inbox-unarchive'))
    expect(unarchive).toHaveBeenCalledWith('i1')
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith('Restored'))
  })

  test('says nothing when the restore was refused', async () => {
    unarchive.mockResolvedValueOnce(false)
    useInboxListMock.mockReturnValue(result({ items: [{ ...ITEM, state: 'archived', archived: true }] }))
    render(<InboxList initialFilter="archived" />)
    fireEvent.keyDown(document.body, { key: 'j' })
    fireEvent.keyDown(document.body, { key: 'e' })
    await waitFor(() => expect(unarchive).toHaveBeenCalled())
    await Promise.resolve()
    expect(toastMock).not.toHaveBeenCalledWith('Restored')
  })

  test('e restores an archived row whose target went away, instead of archiving it again', () => {
    useInboxListMock.mockReturnValue(result({ items: [{ ...ITEM, state: 'inert', archived: true, href: null }] }))
    render(<InboxList initialFilter="archived" />)
    fireEvent.keyDown(document.body, { key: 'j' })
    fireEvent.keyDown(document.body, { key: 'e' })
    expect(unarchive).toHaveBeenCalledWith('i1')
    expect(toastMock).not.toHaveBeenCalledWith('Archived', expect.anything())
  })
})
