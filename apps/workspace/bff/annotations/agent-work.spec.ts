/**
 * Piloti's work on a mark, read off its newest wake: what each wake status
 * shows, and for how long an end without an answer stays said.
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/realtime/document-channel', () => ({ publishToDocumentRoom: vi.fn(async () => true) }))
vi.mock('./wake-repository', () => ({ listLatestWakes: vi.fn(async () => []) }))

const { FAILED_SHOWN_MS, HELD_SHOWN_MS, WORKING_SHOWN_MS, latestWakesFor, agentWorkOf } = await import('./agent-work')
const { listLatestWakes } = await import('./wake-repository')

const NOW = Date.parse('2026-10-17T12:00:00.000Z')
const at = (msAgo: number) => new Date(NOW - msAgo)
const wake = (patch: Partial<Parameters<typeof agentWorkOf>[0]>): Parameters<typeof agentWorkOf>[0] => ({
  status: 'queued',
  reason: null,
  triggerKind: 'thread_mention',
  actorUserId: 'user_anna',
  createdAt: at(60_000),
  settledAt: null,
  endedAt: null,
  ...patch,
})

describe('agentWorkOf', () => {
  it('says Piloti is on it while queued, and working once its turn started, for whom', () => {
    expect(agentWorkOf(wake({}), 'Anna Berger', NOW)).toMatchObject({
      state: 'queued',
      forUserId: 'user_anna',
      forName: 'Anna Berger',
      reasonKind: null,
    })
    expect(agentWorkOf(wake({ status: 'started', settledAt: at(30_000) }), null, NOW)).toMatchObject({
      state: 'working',
      since: at(30_000).toISOString(),
    })
  })

  it('stops claiming work for a turn that never reported its end', () => {
    expect(agentWorkOf(wake({ status: 'started', settledAt: at(WORKING_SHOWN_MS + 1) }), null, NOW)).toBeNull()
  })

  it('says nothing once it answered or a person stopped it: the thread holds the rest', () => {
    expect(agentWorkOf(wake({ status: 'answered', settledAt: at(5), endedAt: at(1) }), null, NOW)).toBeNull()
    expect(agentWorkOf(wake({ status: 'stopped', settledAt: at(5), endedAt: at(1) }), null, NOW)).toBeNull()
  })

  it('says why it did not answer, as a class, for a while after it ended', () => {
    const failed = wake({ status: 'refused', reason: 'budget: exhausted', settledAt: at(1_000), endedAt: at(1_000) })
    expect(agentWorkOf(failed, null, NOW)).toMatchObject({ state: 'failed', reasonKind: 'budget' })
    expect(agentWorkOf({ ...failed, status: 'failed', reason: 'boom' }, null, NOW)).toMatchObject({ reasonKind: 'error' })
    expect(agentWorkOf({ ...failed, endedAt: at(FAILED_SHOWN_MS + 1) }, null, NOW)).toBeNull()
  })

  it('says briefly that a cap held it', () => {
    const held = wake({ status: 'suppressed', reason: 'cap', settledAt: at(1_000), endedAt: at(1_000), createdAt: at(1_000) })
    expect(agentWorkOf(held, null, NOW)).toMatchObject({ state: 'held' })
    expect(agentWorkOf({ ...held, createdAt: at(HELD_SHOWN_MS + 1) }, null, NOW)).toBeNull()
  })
})

describe('latestWakesFor', () => {
  it('reads one mark’s wakes when it names the mark, and the whole document’s when it does not', async () => {
    await latestWakesFor('org_1', 'doc_1', 'mark_1')
    expect(listLatestWakes).toHaveBeenLastCalledWith('org_1', 'doc_1', 'mark_1')
    await latestWakesFor('org_1', 'doc_1')
    expect(listLatestWakes).toHaveBeenLastCalledWith('org_1', 'doc_1', undefined)
  })
})
