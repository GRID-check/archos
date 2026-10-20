/**
 * A workspace kept current over its shelf's live channel, against a scripted
 * link: a burst of hints is one re-read, the folder flag survives the burst,
 * and the channel coming up (first, or after a drop) reads everything again.
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChannelFrame, ChannelLink } from '@/features/realtime/use-channel'
import { shelfChannelKey } from '@/lib/documents/shelf-live-events'
import { LIVE_HINT_COALESCE_MS, LIVE_HINT_JITTER_MS } from '@/features/realtime/use-live-hints'
import { useShelfLive } from './use-shelf-live'

function scriptedLink() {
  let handlers: { onFrame: (frame: ChannelFrame) => void; onOpen: () => void; onDrop: () => void } | null = null
  const link: ChannelLink = {
    connect(next) {
      handlers = next
      return () => {
        handlers = null
      }
    },
    post: () => undefined,
  }
  return {
    link,
    open: () => act(() => handlers?.onOpen()),
    drop: () => act(() => handlers?.onDrop()),
    hint: (event: unknown) => act(() => handlers?.onFrame({ kind: 'event', event })),
    welcome: () => act(() => handlers?.onFrame({ kind: 'welcome', self: { userId: 'user_me', name: 'Miriam Hofer', kind: 'person' } })),
  }
}

const SHELF = { kind: 'project', projectId: 'proj-1' } as const
const settle = () => act(() => vi.advanceTimersByTime(LIVE_HINT_COALESCE_MS + LIVE_HINT_JITTER_MS))

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('useShelfLive', () => {
  it('names the shelf’s channel', () => {
    expect(shelfChannelKey(SHELF)).toBe('shelf:project-proj-1')
    expect(shelfChannelKey({ kind: 'office_shelf' })).toBe('shelf:archiv')
  })

  it('reads everything once when the channel comes up, to close the gap since the last read', () => {
    const scripted = scriptedLink()
    const onChange = vi.fn()
    renderHook(() => useShelfLive(SHELF, onChange, { link: scripted.link }))
    expect(onChange).not.toHaveBeenCalled()

    scripted.open()
    settle()
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenLastCalledWith({ folders: true })
  })

  it('folds a burst of hints into one re-read, and keeps the folder flag of any of them', () => {
    const scripted = scriptedLink()
    const onChange = vi.fn()
    renderHook(() => useShelfLive(SHELF, onChange, { link: scripted.link }))
    scripted.open()
    settle()
    onChange.mockClear()

    scripted.hint({ kind: 'shelf.changed', folders: false })
    scripted.hint({ kind: 'shelf.changed', folders: true })
    scripted.hint({ kind: 'shelf.changed', folders: false })
    expect(onChange).not.toHaveBeenCalled()
    settle()
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenLastCalledWith({ folders: true })

    scripted.hint({ kind: 'shelf.changed', folders: false })
    settle()
    expect(onChange).toHaveBeenLastCalledWith({ folders: false })
  })

  it('drops what is not its vocabulary', () => {
    const scripted = scriptedLink()
    const onChange = vi.fn()
    renderHook(() => useShelfLive(SHELF, onChange, { link: scripted.link }))
    scripted.open()
    settle()
    onChange.mockClear()

    scripted.hint({ kind: 'annotations.changed' })
    scripted.hint({ kind: 'shelf.changed' })
    settle()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('reads everything again when the channel comes back after a drop: the hints it missed are not lost', () => {
    const scripted = scriptedLink()
    const onChange = vi.fn()
    renderHook(() => useShelfLive(SHELF, onChange, { link: scripted.link }))
    scripted.open()
    settle()
    onChange.mockClear()

    scripted.drop()
    settle()
    expect(onChange).not.toHaveBeenCalled()
    scripted.open()
    settle()
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenLastCalledWith({ folders: true })
  })

  it('reads everything again on a welcome that comes without a drop (the connection reopened for another channel)', () => {
    const scripted = scriptedLink()
    const onChange = vi.fn()
    renderHook(() => useShelfLive(SHELF, onChange, { link: scripted.link }))
    scripted.open()
    scripted.welcome()
    settle()
    onChange.mockClear()

    scripted.welcome()
    settle()
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenLastCalledWith({ folders: true })
  })

  it('holds a burst while the workspace is busy, and keeps a folder hint that came before a document one', () => {
    const scripted = scriptedLink()
    const onChange = vi.fn()
    let moving = true
    renderHook(() => useShelfLive(SHELF, onChange, { link: scripted.link, holdWhile: () => moving, holdMs: 500 }))
    moving = false
    scripted.open()
    settle()
    onChange.mockClear()
    moving = true

    scripted.hint({ kind: 'shelf.changed', folders: true })
    settle()
    scripted.hint({ kind: 'shelf.changed', folders: false })
    act(() => vi.advanceTimersByTime(2_000))
    expect(onChange).not.toHaveBeenCalled()

    moving = false
    act(() => vi.advanceTimersByTime(500))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenLastCalledWith({ folders: true })
  })

  it('calls nothing after the workspace is gone', () => {
    const scripted = scriptedLink()
    const onChange = vi.fn()
    const { unmount } = renderHook(() => useShelfLive(SHELF, onChange, { link: scripted.link }))
    scripted.open()
    unmount()
    settle()
    expect(onChange).not.toHaveBeenCalled()
  })
})
