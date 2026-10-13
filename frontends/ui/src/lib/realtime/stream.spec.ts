/**
 * @vitest-environment node
 */
/**
 * The live channels' stream: who the reader is comes first, a channel the
 * reader may not be in is never opened, a revoked one is dropped on the next
 * re-check, the connection carries at most eight channels, and every exit
 * leaves no listener behind on the hub.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/documents/access', () => ({ getAccessibleDocument: vi.fn() }))

import { BadRequestError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { getAccessibleDocument } from '@/lib/documents/access'
import { __resetGrantsForTests } from './channel'
import { publishAsAgent, publishToDocumentRoom } from './document-channel'
import { __setHubTransportForTests, hubStats, publish } from './hub'
import { channelKeysOf, openRealtimeStream } from './stream'
import type { RealtimeFrame } from './types'

const SESSION = {
  userId: 'user_1',
  organizationId: 'org_1',
  email: 'a@grid.test',
  name: 'Anna Berger',
} as Partial<AuthorizedSession> as AuthorizedSession

const ANNA = { peerId: 'peer_abcdef12', userId: 'user_1', name: 'Anna Berger', kind: 'person' as const }

/** Read frames off an SSE response as they come. */
function reader(response: Response) {
  const body = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const frames: RealtimeFrame[] = []
  let done = false
  const pump = async (): Promise<void> => {
    for (;;) {
      const chunk = await body.read()
      if (chunk.done) {
        done = true
        return
      }
      buffer += decoder.decode(chunk.value)
      let end: number
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        if (block.startsWith('data: ')) frames.push(JSON.parse(block.slice(6)) as RealtimeFrame)
      }
    }
  }
  const pumping = pump()
  return {
    frames,
    get done() {
      return done
    },
    pumping,
    cancel: () => body.cancel(),
  }
}

const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

const request = (query: string, signal?: AbortSignal) => new Request(`http://localhost/api/realtime?${query}`, { signal })

beforeEach(async () => {
  vi.clearAllMocks()
  __resetGrantsForTests()
  await __setHubTransportForTests(null)
  vi.mocked(getAccessibleDocument).mockResolvedValue({} as never)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('channelKeysOf', () => {
  it('takes distinct keys, and refuses none, a malformed one, and more than eight', () => {
    expect(channelKeysOf(request('ch=doc:a&ch=doc:a&ch=doc:b'))).toEqual(['doc:a', 'doc:b'])
    expect(() => channelKeysOf(request(''))).toThrow(BadRequestError)
    expect(() => channelKeysOf(request('ch=doc:a/../b'))).toThrow(BadRequestError)
    const nine = Array.from({ length: 9 }, (_, index) => `ch=doc:d${index}`).join('&')
    expect(() => channelKeysOf(request(nine))).toThrow(/At most 8/)
  })
})

describe('openRealtimeStream', () => {
  it('welcomes the reader as the session says, then carries the room, and only parseable events', async () => {
    const response = await openRealtimeStream(SESSION, ['doc:doc_1'], request('ch=doc:doc_1'))
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const read = reader(response)
    await settle()

    await publishToDocumentRoom('doc_1', { kind: 'viewport', peer: ANNA, viewport: { page: 2, y: 0.5 } })
    await publish('rt:doc:doc_1', { kind: 'cursor', peer: 'forged' })
    await publishToDocumentRoom('doc_2', { kind: 'viewport', peer: ANNA, viewport: { page: 1, y: 0.1 } })
    await settle()

    expect(read.frames).toEqual([
      { kind: 'welcome', self: { userId: 'user_1', name: 'Anna Berger', kind: 'person' } },
      { kind: 'event', ch: 'doc:doc_1', event: { kind: 'viewport', peer: ANNA, viewport: { page: 2, y: 0.5 } } },
    ])
    await read.cancel()
    expect(hubStats()).toEqual({ topics: 0, listeners: 0 })
  })

  it('says unsupported for a kind it does not know and revoked for a document the reader may not read, and opens the rest', async () => {
    vi.mocked(getAccessibleDocument).mockImplementation(async (_session, id) => {
      if (id === 'secret') throw new NotFoundError()
      return {} as never
    })
    const response = await openRealtimeStream(SESSION, ['doc:doc_1', 'doc:secret', 'nope:x'], request(''))
    const read = reader(response)
    await settle()

    expect(read.frames.slice(1)).toEqual(
      expect.arrayContaining([
        { kind: 'revoked', ch: 'doc:secret' },
        { kind: 'unsupported', ch: 'nope:x' },
      ])
    )
    expect(hubStats()).toEqual({ topics: 1, listeners: 1 })
    await read.cancel()
  })

  it('ends at once, holding nothing, when no channel may be opened', async () => {
    vi.mocked(getAccessibleDocument).mockRejectedValue(new NotFoundError())
    const read = reader(await openRealtimeStream(SESSION, ['doc:secret'], request('')))
    await read.pumping

    expect(read.done).toBe(true)
    expect(read.frames.at(-1)).toEqual({ kind: 'revoked', ch: 'doc:secret' })
    expect(hubStats()).toEqual({ topics: 0, listeners: 0 })
  })

  it('fails the request rather than drop a channel when asking for access itself fails', async () => {
    vi.mocked(getAccessibleDocument).mockRejectedValue(new Error('database down'))
    await expect(openRealtimeStream(SESSION, ['doc:doc_1'], request(''))).rejects.toThrow('database down')
  })

  it('revokes a channel on the re-check after access is gone, and ends the stream with its last channel', async () => {
    vi.useFakeTimers()
    const read = reader(await openRealtimeStream(SESSION, ['doc:doc_1'], request('')))
    await vi.advanceTimersByTimeAsync(0)

    vi.mocked(getAccessibleDocument).mockRejectedValue(new NotFoundError())
    await vi.advanceTimersByTimeAsync(30_000)
    await read.pumping

    expect(read.frames.at(-1)).toEqual({ kind: 'revoked', ch: 'doc:doc_1' })
    expect(read.done).toBe(true)
    expect(hubStats()).toEqual({ topics: 0, listeners: 0 })
  })

  it('keeps a channel when the re-check fails for a reason other than access', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const read = reader(await openRealtimeStream(SESSION, ['doc:doc_1'], request('')))
    await vi.advanceTimersByTimeAsync(0)

    vi.mocked(getAccessibleDocument).mockRejectedValue(new Error('database down'))
    await vi.advanceTimersByTimeAsync(30_000)

    expect(read.done).toBe(false)
    expect(hubStats()).toEqual({ topics: 1, listeners: 1 })
    await read.cancel()
    warn.mockRestore()
  })

  it('ends after its maximum age, so the reconnect resolves the session again', async () => {
    vi.useFakeTimers()
    const read = reader(await openRealtimeStream(SESSION, ['doc:doc_1'], request(''), { maxAgeMs: 60_000 }))
    await vi.advanceTimersByTimeAsync(60_000)
    await read.pumping
    expect(read.done).toBe(true)
    expect(hubStats()).toEqual({ topics: 0, listeners: 0 })
  })

  it('tears down when the reader goes away', async () => {
    const abort = new AbortController()
    const read = reader(await openRealtimeStream(SESSION, ['doc:doc_1', 'doc:doc_2'], request('', abort.signal)))
    await settle()
    expect(hubStats()).toEqual({ topics: 2, listeners: 2 })

    abort.abort()
    await read.pumping
    expect(hubStats()).toEqual({ topics: 0, listeners: 0 })
  })

  it('carries what Piloti is reading, as a Piloti peer', async () => {
    const read = reader(await openRealtimeStream(SESSION, ['doc:doc_1'], request('')))
    await settle()

    await publishAsAgent('doc_1', 'org_1', { conversationId: 'conv_42', onBehalfOf: 'user_1' }, {
      op: 'activity',
      box: { page: 1, x: 0.1, y: 0.2, w: 0.3, h: 0.1 },
      label: 'Fluchtweg prüfen',
    })
    await settle()

    expect(read.frames.at(-1)).toEqual({
      kind: 'event',
      ch: 'doc:doc_1',
      event: {
        kind: 'activity',
        peer: { peerId: 'piloti-conv_42', userId: 'user_1', name: 'Piloti', kind: 'piloti' },
        state: 'reading',
        box: { page: 1, x: 0.1, y: 0.2, w: 0.3, h: 0.1 },
        label: 'Fluchtweg prüfen',
      },
    })
    await read.cancel()
  })
})
