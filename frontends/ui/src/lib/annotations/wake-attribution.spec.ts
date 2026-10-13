/**
 * @vitest-environment node
 */
/**
 * Which Piloti replies a wake wrote: the same person's wake on the same mark
 * that began before the reply and had not ended before it.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('./wake-repository', () => ({ listAnsweringWakes: vi.fn() }))

import { wakeOfReply, wakeSpansFor, type WakeSpan } from './wake-attribution'
import { listAnsweringWakes } from './wake-repository'

const at = (time: string) => new Date(`2026-10-01T${time}:00.000Z`)

const wake = (overrides: Partial<WakeSpan> = {}): WakeSpan => ({
  annotationId: 'ann_1',
  actorUserId: 'user_anna',
  triggerKind: 'thread_mention',
  createdAt: at('09:00'),
  endedAt: at('09:05'),
  ...overrides,
})

const reply = (overrides: Partial<Parameters<typeof wakeOfReply>[0]> = {}) => ({
  annotationId: 'ann_1',
  authorKind: 'piloti' as const,
  createdBy: 'user_anna',
  createdAt: at('09:02'),
  ...overrides,
})

describe('wakeOfReply', () => {
  it('names the trigger of the wake whose window holds the reply', () => {
    expect(wakeOfReply(reply(), [wake()])).toBe('thread_mention')
  })

  it('holds a reply of a turn that is still running: no end yet', () => {
    expect(wakeOfReply(reply(), [wake({ endedAt: null, triggerKind: 'assigned' })])).toBe('assigned')
  })

  it('is null for a person’s reply, however well a wake fits', () => {
    expect(wakeOfReply(reply({ authorKind: 'person' }), [wake()])).toBeNull()
  })

  it('is null before the wake began and after it ended', () => {
    expect(wakeOfReply(reply({ createdAt: at('08:59') }), [wake()])).toBeNull()
    expect(wakeOfReply(reply({ createdAt: at('09:06') }), [wake()])).toBeNull()
  })

  it('is null for another mark or another person’s wake', () => {
    expect(wakeOfReply(reply({ annotationId: 'ann_2' }), [wake()])).toBeNull()
    expect(wakeOfReply(reply({ createdBy: 'user_ben' }), [wake()])).toBeNull()
  })

  it('takes the newest wake when two windows hold the reply', () => {
    const spans = [
      wake({ triggerKind: 'thread_reply', createdAt: at('09:01'), endedAt: null }),
      wake({ triggerKind: 'assigned', createdAt: at('09:00'), endedAt: at('09:30') }),
    ]
    expect(wakeOfReply(reply(), spans)).toBe('thread_reply')
  })
})

describe('wakeSpansFor', () => {
  it('reads nothing while no mark carries a Piloti reply', async () => {
    vi.mocked(listAnsweringWakes).mockClear()
    const spans = await wakeSpansFor('org_1', 'doc_1', [{ replies: [{ authorKind: 'person' }] } as never])
    expect(spans).toEqual([])
    expect(listAnsweringWakes).not.toHaveBeenCalled()
  })

  it('reads the document’s wakes once a Piloti reply is there, and survives a failed read', async () => {
    vi.mocked(listAnsweringWakes).mockResolvedValueOnce([wake()])
    const records = [{ replies: [{ authorKind: 'piloti' }] } as never]
    expect(await wakeSpansFor('org_1', 'doc_1', records)).toEqual([wake()])
    vi.mocked(listAnsweringWakes).mockRejectedValueOnce(new Error('db'))
    expect(await wakeSpansFor('org_1', 'doc_1', records)).toEqual([])
  })
})
