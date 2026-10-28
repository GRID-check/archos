/**
 * @vitest-environment node
 */
/**
 * When an event on an Anmerkung wakes Piloti, and what enqueuing it writes
 * (ADR-0106): the closed rule list, the caps, and the one wake per event. The
 * queue and the wake record are mocked here; that the two commit or roll back
 * with the reply is held against a real database in
 * `repository.integration.spec.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/jobs-queue/enqueue', () => ({ enqueueJob: vi.fn() }))
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: vi.fn() }))
vi.mock('./wake-repository', () => ({ countWakes: vi.fn(), insertWake: vi.fn() }))

import { enqueueJob } from '@/lib/jobs-queue/enqueue'
import type { DbTransaction } from '@/lib/db/executor'
import { countWakes, insertWake } from './wake-repository'
import { enqueueWake, replyTrigger, wakeLimits, type WakeEvent } from './wake'
import { wakeTurnId } from './wake-ids'

const TX = { tx: true } as unknown as DbTransaction

const EVENT: WakeEvent = {
  organizationId: 'org_1',
  documentId: '11111111-1111-4111-8111-111111111111',
  annotationId: '22222222-2222-4222-8222-222222222222',
  trigger: 'thread_mention',
  eventId: '33333333-3333-4333-8333-333333333333',
  actor: { userId: 'user_anna', email: 'anna@example.at' },
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(countWakes).mockResolvedValue(0)
  vi.mocked(insertWake).mockResolvedValue(true)
  vi.mocked(enqueueJob).mockResolvedValue({ jobId: wakeTurnId(EVENT.eventId) })
})

describe('what wakes Piloti', () => {
  type Mark = Parameters<typeof replyTrigger>[0]
  const personsMark: Mark = { authorKind: 'person', kind: 'defect', status: 'open' }
  const pilotisQuestion: Mark = { authorKind: 'piloti', kind: 'question', status: 'proposed' }

  it('a reply that addresses Piloti, by the flag the composer sets', () => {
    expect(replyTrigger(personsMark, { authorKind: 'person', addressesPiloti: true })).toBe('thread_mention')
  })

  it('a reply on Piloti’s own question while it is proposed or open, addressed or not', () => {
    expect(replyTrigger(pilotisQuestion, { authorKind: 'person', addressesPiloti: false })).toBe('thread_reply')
    expect(replyTrigger({ ...pilotisQuestion, status: 'open' }, { authorKind: 'person', addressesPiloti: false })).toBe(
      'thread_reply'
    )
  })

  it('nothing for a reply to people on a person’s mark, or on Piloti’s closed or non-question mark', () => {
    expect(replyTrigger(personsMark, { authorKind: 'person', addressesPiloti: false })).toBeNull()
    expect(replyTrigger({ ...pilotisQuestion, status: 'resolved' }, { authorKind: 'person', addressesPiloti: false })).toBeNull()
    expect(replyTrigger({ ...pilotisQuestion, kind: 'defect' }, { authorKind: 'person', addressesPiloti: false })).toBeNull()
  })

  it('never Piloti’s own reply: no Piloti-wakes-Piloti, even on its open question', () => {
    expect(replyTrigger(pilotisQuestion, { authorKind: 'piloti', addressesPiloti: true })).toBeNull()
  })
})

describe('the caps', () => {
  it('default to six wakes per mark an hour and fifty per person a day, and read the environment', () => {
    expect(wakeLimits({})).toEqual({ perMarkHour: 6, perPersonDay: 50 })
    expect(wakeLimits({ WAKE_MAX_PER_MARK_HOUR: '2', WAKE_MAX_PER_PERSON_DAY: '10' })).toEqual({
      perMarkHour: 2,
      perPersonDay: 10,
    })
    expect(wakeLimits({ WAKE_MAX_PER_MARK_HOUR: 'viele' }).perMarkHour).toBe(6)
  })
})

describe('enqueueWake', () => {
  const now = new Date('2026-10-13T10:00:00Z')

  it('records the wake and enqueues ONE job in the event’s transaction, under the id of the event', async () => {
    const wakeId = wakeTurnId(EVENT.eventId)

    await expect(enqueueWake(TX, EVENT, { now, limits: { perMarkHour: 6, perPersonDay: 50 } })).resolves.toEqual({
      outcome: 'queued',
      wakeId,
    })

    expect(insertWake).toHaveBeenCalledWith(TX, expect.objectContaining({ id: wakeId, status: 'queued', eventId: EVENT.eventId }))
    expect(enqueueJob).toHaveBeenCalledTimes(1)
    expect(enqueueJob).toHaveBeenCalledWith(
      {
        kind: 'piloti_wake',
        organizationId: 'org_1',
        jobId: wakeId,
        priority: 0,
        payload: {
          wakeId,
          trigger: 'thread_mention',
          eventId: EVENT.eventId,
          documentId: EVENT.documentId,
          annotationId: EVENT.annotationId,
          actor: EVENT.actor,
          waits: 0,
        },
      },
      TX
    )
  })

  it('enqueues nothing a second time for the same event', async () => {
    vi.mocked(insertWake).mockResolvedValue(false)

    await expect(enqueueWake(TX, EVENT, { now })).resolves.toEqual({ outcome: 'queued', wakeId: wakeTurnId(EVENT.eventId) })
    expect(enqueueJob).not.toHaveBeenCalled()
  })

  it('holds a wake past the mark’s hourly cap: recorded as suppressed, no job', async () => {
    vi.mocked(countWakes).mockImplementation(async (_tx, query) => (query.annotationId ? 6 : 0))

    await expect(enqueueWake(TX, EVENT, { now, limits: { perMarkHour: 6, perPersonDay: 50 } })).resolves.toMatchObject({
      outcome: 'suppressed',
      reason: 'cap:mark-hour',
    })
    expect(insertWake).toHaveBeenCalledWith(TX, expect.objectContaining({ status: 'suppressed', reason: 'cap:mark-hour' }))
    expect(enqueueJob).not.toHaveBeenCalled()
    // The window is the last hour, counted in the same transaction.
    expect(countWakes).toHaveBeenCalledWith(
      TX,
      expect.objectContaining({ annotationId: EVENT.annotationId, since: new Date('2026-10-13T09:00:00Z') })
    )
  })

  it('holds a wake past the person’s daily cap', async () => {
    vi.mocked(countWakes).mockImplementation(async (_tx, query) => (query.actorUserId ? 50 : 0))

    await expect(enqueueWake(TX, EVENT, { now, limits: { perMarkHour: 6, perPersonDay: 50 } })).resolves.toMatchObject({
      outcome: 'suppressed',
      reason: 'cap:person-day',
    })
    expect(countWakes).toHaveBeenCalledWith(
      TX,
      expect.objectContaining({ actorUserId: 'user_anna', since: new Date('2026-10-12T10:00:00Z') })
    )
    expect(enqueueJob).not.toHaveBeenCalled()
  })
})
