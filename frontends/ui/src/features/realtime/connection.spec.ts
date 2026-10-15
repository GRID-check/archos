/**
 * The tab's live connection: one EventSource for every channel, reopened once
 * when the channel set settles, frames handed to the channel they name, and a
 * channel the server closed not asked for again.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRetryLadder } from '@/shared/utils/backoff'
import { createRealtimeConnection, type ChannelHandlers } from './connection'
import type { PageLifecycle, PageLifecycleListener } from '@/adapters/api/page-lifecycle'

class FakeSource {
  static all: FakeSource[] = []
  onopen: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  closed = false
  constructor(readonly url: string) {
    FakeSource.all.push(this)
  }
  get channels() {
    return new URL(this.url, 'http://localhost').searchParams.getAll('ch')
  }
  open() {
    this.onopen?.(new Event('open'))
  }
  frame(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent<string>)
  }
  close() {
    this.closed = true
  }
}

const recorder = () => {
  const events: unknown[] = []
  const closed: string[] = []
  const statuses: string[] = []
  const handlers: ChannelHandlers = {
    onEvent: (event) => events.push(event),
    onClosed: (reason) => closed.push(reason),
    onStatus: (status) => statuses.push(status),
  }
  return { events, closed, statuses, handlers }
}

const open = () => FakeSource.all.filter((source) => !source.closed)

beforeEach(() => {
  vi.useFakeTimers()
  FakeSource.all = []
})
afterEach(() => {
  vi.useRealTimers()
})

const make = () =>
  createRealtimeConnection({
    createSource: (url) => new FakeSource(url),
    post: vi.fn(),
    ladder: createRetryLadder({ delaysMs: [1_000, 1_000, 1_000] }),
  })

describe('the realtime connection', () => {
  it('opens one stream for every channel joined in one go, and two joins of one channel are one', () => {
    const connection = make()
    const a = recorder()
    connection.join('doc:a', a.handlers)
    connection.join('doc:a', recorder().handlers)
    connection.join('doc:b', recorder().handlers)
    expect(FakeSource.all).toHaveLength(0)

    vi.advanceTimersByTime(250)
    expect(open()).toHaveLength(1)
    expect(open()[0].channels).toEqual(['doc:a', 'doc:b'])

    open()[0].open()
    open()[0].frame({ kind: 'welcome', self: { userId: 'u', name: 'U', kind: 'person' } })
    expect(connection.status('doc:a')).toBe('live')
    expect(a.statuses.at(-1)).toBe('live')
    connection.dispose()
  })

  it('hands each frame to the channel it names, and drops what is not a frame', () => {
    const connection = make()
    const a = recorder()
    const b = recorder()
    connection.join('doc:a', a.handlers)
    connection.join('doc:b', b.handlers)
    vi.advanceTimersByTime(250)
    const source = open()[0]
    source.open()

    source.frame({ kind: 'event', ch: 'doc:b', event: { kind: 'viewport' } })
    source.frame({ kind: 'event', ch: 'doc:zzz', event: { kind: 'viewport' } })
    source.frame({ kind: 'nonsense' })
    source.onmessage?.({ data: 'not json' } as MessageEvent<string>)

    expect(a.events).toEqual([])
    expect(b.events).toEqual([{ kind: 'viewport' }])
    connection.dispose()
  })

  it('reopens with the new set when a channel is left, and closes when the last one is', () => {
    const connection = make()
    const leaveA = connection.join('doc:a', recorder().handlers)
    const leaveB = connection.join('doc:b', recorder().handlers)
    vi.advanceTimersByTime(250)
    open()[0].open()

    leaveA()
    leaveA()
    vi.advanceTimersByTime(250)
    expect(open()).toHaveLength(1)
    expect(open()[0].channels).toEqual(['doc:b'])

    leaveB()
    vi.advanceTimersByTime(250)
    expect(open()).toHaveLength(0)
    connection.dispose()
  })

  it('drops a revoked channel from the stream and does not ask for it again until joined anew', () => {
    const connection = make()
    const a = recorder()
    connection.join('doc:a', a.handlers)
    connection.join('doc:b', recorder().handlers)
    vi.advanceTimersByTime(250)
    open()[0].open()

    open()[0].frame({ kind: 'revoked', ch: 'doc:a' })
    expect(a.closed).toEqual(['revoked'])
    expect(connection.status('doc:a')).toBe('offline')

    // The stream still carries doc:b, so nothing reconnects for the revoke alone.
    vi.advanceTimersByTime(250)
    expect(FakeSource.all).toHaveLength(1)

    // Dropped, and a retry asks only for what is left.
    open()[0].onerror?.(new Event('error'))
    vi.advanceTimersByTime(1_000)
    expect(open()).toHaveLength(1)
    expect(open()[0].channels).toEqual(['doc:b'])
    connection.dispose()
  })

  it('posts what a channel says to the send path', () => {
    const post = vi.fn()
    const connection = createRealtimeConnection({ createSource: (url) => new FakeSource(url), post })
    connection.send('doc:a', { peerId: 'peer_abcdef12', presence: 'here' })
    expect(post).toHaveBeenCalledWith(
      '/api/realtime/send',
      JSON.stringify({ ch: 'doc:a', msg: { peerId: 'peer_abcdef12', presence: 'here' } })
    )
    connection.dispose()
  })
})

describe('a page away', () => {
  const awayPage = () => {
    let listener: PageLifecycleListener | null = null
    const page: PageLifecycle & { visible: boolean; back: () => void } = {
      visible: true,
      online: true,
      subscribe: (next) => {
        listener = next
        return () => {
          listener = null
        }
      },
      back: () => {
        page.visible = true
        listener?.resume('visible')
      },
    }
    return page
  }

  it('tries nothing while the page is hidden, and reopens the moment it is back, without waiting out a rung', () => {
    const page = awayPage()
    const connection = createRealtimeConnection({
      createSource: (url) => new FakeSource(url),
      post: vi.fn(),
      ladder: createRetryLadder({ delaysMs: [30_000] }),
      lifecycle: page,
    })
    connection.join('doc:a', recorder().handlers)
    vi.advanceTimersByTime(250)
    open()[0].open()

    page.visible = false
    open()[0].onerror?.(new Event('error'))
    vi.advanceTimersByTime(10 * 60_000)
    expect(FakeSource.all).toHaveLength(1)

    page.back()
    expect(open()).toHaveLength(1)
    expect(FakeSource.all).toHaveLength(2)
    connection.dispose()
  })

  it('leaves a live stream alone when the page comes back', () => {
    const page = awayPage()
    const connection = createRealtimeConnection({ createSource: (url) => new FakeSource(url), post: vi.fn(), lifecycle: page })
    connection.join('doc:a', recorder().handlers)
    vi.advanceTimersByTime(250)
    open()[0].open()
    page.back()
    expect(FakeSource.all).toHaveLength(1)
    connection.dispose()
  })
})
