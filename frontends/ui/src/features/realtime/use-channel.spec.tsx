/**
 * One channel in a component: what goes up says whether it is motion, and a
 * channel that closed says nothing more under its peer, whoever still holds
 * its `send`.
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpstreamBase } from '@/lib/realtime/types'
import type { ChannelPostOptions } from './connection'
import { useChannel, type ChannelLink } from './use-channel'

type Event = { kind: string; peer?: { peerId: string; userId: string; name: string; kind: 'person' | 'piloti' } }

function scriptedLink() {
  const posts: Array<{ msg: UpstreamBase & Record<string, unknown>; options?: ChannelPostOptions }> = []
  const link: ChannelLink = {
    connect({ onOpen }) {
      onOpen()
      return () => undefined
    },
    post: (msg, options) => posts.push({ msg: msg as UpstreamBase & Record<string, unknown>, options }),
  }
  return { link, posts }
}

const PRESENCE = { refreshMs: 10_000, initial: () => undefined, reduce: () => undefined }
const parse = (event: unknown) => event as Event

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('useChannel', () => {
  it('marks a throttled lane as motion and an unthrottled message as a claim', () => {
    const { link, posts } = scriptedLink()
    const { result, unmount } = renderHook(() => useChannel<Event>('doc:a', { enabled: true, link, parse }))

    act(() => result.current.send({ cursor: 1 }, { throttleMs: 80, lane: 'cursor' }))
    act(() => result.current.send({ selected: 'ann_1' }))
    expect(posts.map((post) => [Object.keys(post.msg).sort().join(','), post.options?.motion])).toEqual([
      ['cursor,peerId', true],
      ['peerId,selected', false],
    ])
    unmount()
  })

  it('says nothing more once the channel closed: a late send would bring the peer back as a ghost', () => {
    const { link, posts } = scriptedLink()
    const { result, unmount } = renderHook(() =>
      useChannel<Event, undefined>('doc:a', { enabled: true, link, parse, presence: PRESENCE })
    )
    const { send } = result.current

    unmount()
    expect(posts.at(-1)?.msg.presence).toBe('gone')
    const said = posts.length

    // A timer that outlived the component (the cursor chat's linger) still holds `send`.
    send({ cursor: null, chat: null })
    send({ selected: null })
    vi.advanceTimersByTime(30_000)
    expect(posts).toHaveLength(said)
  })
})
