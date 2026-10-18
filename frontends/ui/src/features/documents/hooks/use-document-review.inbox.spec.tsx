/**
 * Opening a mark in the review reads its news in the inbox: the reader's
 * informational items anchored on that mark, through the inbox's own client.
 * A mark only stepped past (J/K) does not count, and a mark without news (no
 * dot) writes nothing.
 *
 * And the review knows which marks have news before they are opened (their
 * dot): one read per document, again when the inbox changes.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { server } from '@/mocks/server'
import type { CollaborationEvent } from '@/lib/events/types'
import type { InboxClient } from '@/lib/inbox/client'
import type { RoomTransport } from './use-document-room'
import { MARK_NEWS_SETTLE_MS, UNREAD_READ_DELAY_MS, useDocumentReview } from './use-document-review'

/** The tab's live channel, played by the test: what reaches every listener. */
const hub = vi.hoisted(() => ({ listeners: new Set<(event: CollaborationEvent) => void>() }))
vi.mock('@/features/collaboration/lib/event-hub', () => ({
  subscribeToEvents: (listener: (event: CollaborationEvent) => void) => {
    hub.listeners.add(listener)
    return () => hub.listeners.delete(listener)
  },
  subscribeToConnection: (listener: (connected: boolean) => void) => {
    listener(true)
    return () => undefined
  },
}))
const publish = (event: CollaborationEvent) => act(() => hub.listeners.forEach((listener) => listener(event)))

const transport: RoomTransport = {
  connect({ onFrame, onOpen }) {
    onOpen()
    onFrame({ kind: 'welcome', self: { userId: 'user_me', name: 'Miriam Hofer', kind: 'person' } })
    return () => undefined
  },
  post: () => undefined,
}

let reads: unknown[] = []

beforeEach(() => {
  reads = []
  server.use(
    http.get('/api/documents/:id/annotations', () => HttpResponse.json({ annotations: [], canAnnotate: true, pilotiWakes: false })),
    http.get('/api/inbox/unread-anchors', () => HttpResponse.json({ anchorIds: ['mark-1', 'mark-2'] })),
    http.post('/api/inbox/read', async ({ request }) => {
      reads.push(await request.json())
      return HttpResponse.json({ affected: 1, pending: 0 })
    })
  )
})
afterEach(() => vi.useRealTimers())

describe('opening a mark reads its news', () => {
  it('reads the news about the mark that stays open, and not about one stepped past', async () => {
    const { result } = renderHook(() => useDocumentReview('doc-1', { enabled: true, transport }))
    await waitFor(() => expect(result.current.load).toBe('ready'))
    await waitFor(() => expect(result.current.unread.size).toBe(2))

    act(() => result.current.select('mark-1'))
    act(() => result.current.select('mark-2'))

    await waitFor(() => expect(reads).toEqual([{ resourceType: 'document', resourceId: 'doc-1', anchorId: 'mark-2' }]), {
      timeout: MARK_NEWS_SETTLE_MS * 4,
    })
  })

  it('writes nothing for a mark without news: its dot is what says there is something to read', async () => {
    const { result } = renderHook(() => useDocumentReview('doc-1', { enabled: true, transport }))
    await waitFor(() => expect(result.current.unread.size).toBe(2))

    act(() => result.current.select('mark-3'))

    await new Promise((resolve) => setTimeout(resolve, MARK_NEWS_SETTLE_MS * 2))
    expect(reads).toEqual([])
  })
})

describe('which marks have news', () => {
  /** The inbox as the review asks it: the unread marks answered in turn, and what was read. */
  function inboxWith(...answers: string[][]) {
    const unreadMarks = vi.fn<InboxClient['unreadMarks']>(async () => answers.shift() ?? [])
    const markMarkRead = vi.fn<InboxClient['markMarkRead']>(async () => ({ affected: 1, pending: 0 }))
    return { unreadMarks, markMarkRead, client: { unreadMarks, markMarkRead } as Partial<InboxClient> as InboxClient }
  }

  it('reads them once for the document, and drops a mark’s dot once it stays open, reading its news', async () => {
    const inbox = inboxWith(['mark-1', 'mark-3'])
    const { result } = renderHook(() => useDocumentReview('doc-1', { enabled: true, transport, inbox: inbox.client }))
    await waitFor(() => expect([...result.current.unread]).toEqual(['mark-1', 'mark-3']))
    expect(inbox.unreadMarks).toHaveBeenCalledTimes(1)
    expect(inbox.unreadMarks).toHaveBeenCalledWith('doc-1')

    act(() => result.current.select('mark-1'))

    await waitFor(() => expect([...result.current.unread]).toEqual(['mark-3']), { timeout: MARK_NEWS_SETTLE_MS * 4 })
    expect(inbox.markMarkRead).toHaveBeenCalledTimes(1)
    expect(inbox.markMarkRead).toHaveBeenLastCalledWith({ documentId: 'doc-1', annotationId: 'mark-1' })
  })

  it('reads them again once for a burst of inbox changes, and reads news that reaches the open mark', async () => {
    const inbox = inboxWith([], ['mark-2'])
    const { result } = renderHook(() => useDocumentReview('doc-1', { enabled: true, transport, inbox: inbox.client }))
    await waitFor(() => expect(inbox.unreadMarks).toHaveBeenCalledTimes(1))
    act(() => result.current.select('mark-2'))
    // No news on it yet: nothing to read.
    await new Promise((resolve) => setTimeout(resolve, MARK_NEWS_SETTLE_MS * 2))
    expect(inbox.markMarkRead).not.toHaveBeenCalled()

    // A colleague answers in the thread the reader has open: the inbox changes, three nudges in a row.
    for (let index = 0; index < 3; index += 1) publish({ kind: 'inbox.changed', pending: -1 })

    await waitFor(() => expect(inbox.unreadMarks).toHaveBeenCalledTimes(2), { timeout: UNREAD_READ_DELAY_MS * 4 })
    await waitFor(() => expect(inbox.markMarkRead).toHaveBeenCalledTimes(1), { timeout: MARK_NEWS_SETTLE_MS * 4 })
    expect(result.current.unread.has('mark-2')).toBe(false)
    expect(inbox.unreadMarks).toHaveBeenCalledTimes(2)
  })
})
