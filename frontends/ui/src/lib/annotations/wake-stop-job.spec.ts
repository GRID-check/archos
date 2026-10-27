/**
 * @vitest-environment node
 */
/**
 * The `piloti_wake_stop` job (ADR-0106): a person took the mark back, so the
 * turn its wake started is stopped. Pinned here: it sends `cancel_turn`
 * for the wake's id in the thread of the person whose act woke Piloti, over a
 * socket whose signed envelope names that thread; a turn that already ended is
 * left alone; and a stop that landed nowhere throws, so the queue retries it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db', () => ({ getDb: vi.fn(() => ({ handle: 'db' })) }))
vi.mock('./wake-repository', () => ({ findWake: vi.fn() }))
vi.mock('@/lib/turns/headless-turn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/turns/headless-turn')>()
  return { ...actual, cancelHeadlessTurn: vi.fn(), chatSocketUrl: vi.fn(() => 'ws://aiq-agent:8000/websocket') }
})

import type { PilotiWakeRow } from '@/lib/db/schema'
import type { PilotiWakeStopPayload } from '@/lib/jobs-queue/types'
import { verifyGridRequestContextEnvelope } from '@/lib/request-context'
import { cancelHeadlessTurn, type HeadlessCancelRequest } from '@/lib/turns/headless-turn'
import { runPilotiWakeStop } from './wake-stop-job'
import { documentThreadConversationId, wakeTurnId } from './wake-ids'
import { findWake } from './wake-repository'

const SECRET = 'stop-secret'
const DOC_ID = '11111111-1111-4111-8111-111111111111'
const MARK_ID = '22222222-2222-4222-8222-222222222222'
const WAKE_ID = wakeTurnId('delegation-event')
const THREAD = documentThreadConversationId(DOC_ID, 'user_anna')

const PAYLOAD: PilotiWakeStopPayload = { wakeId: WAKE_ID, documentId: DOC_ID, annotationId: MARK_ID, actorUserId: 'user_anna' }
const NOT_LAST = { last: false }

const wake = (status: PilotiWakeRow['status']): PilotiWakeRow =>
  ({ id: WAKE_ID, organizationId: 'org_1', status }) as PilotiWakeRow

const sentRequest = (): HeadlessCancelRequest => vi.mocked(cancelHeadlessTurn).mock.calls[0][0]

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('GRID_INTERNAL_API_TOKEN', SECRET)
  vi.mocked(findWake).mockResolvedValue(wake('started'))
  vi.mocked(cancelHeadlessTurn).mockResolvedValue({ kind: 'sent' })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('runPilotiWakeStop', () => {
  it('stops the wake’s turn: cancel_turn for the wake id, in the thread of the person whose act woke Piloti', async () => {
    await runPilotiWakeStop('org_1', PAYLOAD, NOT_LAST)

    expect(cancelHeadlessTurn).toHaveBeenCalledTimes(1)
    const request = sentRequest()
    expect(request).toMatchObject({ url: 'ws://aiq-agent:8000/websocket', conversationId: THREAD, turnId: WAKE_ID })
    expect(request.headers['x-grid-mode']).toBe('headless')
    expect(request.headers['x-aiq-mode']).toBe('headless')
    expect(request.headers['x-grid-user-id']).toBe('user_anna')
    expect(request.headers).not.toHaveProperty('authorization')
  })

  it('signs an envelope that names the organization, the person and the thread, and builds no turn context', async () => {
    await runPilotiWakeStop('org_1', PAYLOAD, NOT_LAST)

    const { headers } = sentRequest()
    const envelope = verifyGridRequestContextEnvelope(
      headers['x-grid-request-context'],
      headers['x-grid-request-context-sig'],
      SECRET
    )
    expect(envelope).toMatchObject({ organizationId: 'org_1', userId: 'user_anna', conversationId: THREAD })
  })

  it('leaves a turn that already ended alone, and sends nothing', async () => {
    for (const status of ['answered', 'stopped', 'failed'] as const) {
      vi.mocked(findWake).mockResolvedValue(wake(status))
      await runPilotiWakeStop('org_1', PAYLOAD, NOT_LAST)
    }

    expect(cancelHeadlessTurn).not.toHaveBeenCalled()
  })

  it('still stops the turn of a wake whose row is gone with a deleted mark', async () => {
    vi.mocked(findWake).mockResolvedValue(null)

    await runPilotiWakeStop('org_1', PAYLOAD, NOT_LAST)

    expect(cancelHeadlessTurn).toHaveBeenCalledTimes(1)
  })

  it('takes a turn that is not running as the stop already done', async () => {
    vi.mocked(cancelHeadlessTurn).mockResolvedValue({ kind: 'not_running' })

    await expect(runPilotiWakeStop('org_1', PAYLOAD, NOT_LAST)).resolves.toBeUndefined()
  })

  it('throws when no server took the stop, or one refused it, so the queue retries', async () => {
    vi.mocked(cancelHeadlessTurn).mockResolvedValueOnce({ kind: 'unavailable', reason: 'socket failed' })
    await expect(runPilotiWakeStop('org_1', PAYLOAD, NOT_LAST)).rejects.toThrow(/socket failed/)

    vi.mocked(cancelHeadlessTurn).mockResolvedValueOnce({ kind: 'rejected', code: 'auth_expired', message: null })
    await expect(runPilotiWakeStop('org_1', PAYLOAD, NOT_LAST)).rejects.toThrow(/auth_expired/)
  })

  it('throws, sending nothing, when it cannot sign the envelope', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', '')

    await expect(runPilotiWakeStop('org_1', PAYLOAD, NOT_LAST)).rejects.toThrow(/GRID_INTERNAL_API_TOKEN/)
    expect(cancelHeadlessTurn).not.toHaveBeenCalled()
  })
})
