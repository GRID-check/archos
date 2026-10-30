/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/db/tenant-context', () => ({ withTenant: (_scope: unknown, fn: () => unknown) => fn() }))
vi.mock('@/lib/feedback/repository', () => ({ getAnswerTraceId: vi.fn(async (messageId: string) => `trace-of-${messageId}`) }))
vi.mock('./config', () => ({ langfuseApiConfig: () => ({ baseUrl: 'http://langfuse', publicKey: 'pk', secretKey: 'sk' }) }))
vi.mock('./feedback-score', () => ({ upsertScore: vi.fn(async () => undefined) }))

import { getAnswerTraceId } from '@/lib/feedback/repository'
import { upsertScore } from './feedback-score'
import { recordSketchEditScore } from './sketch-score'

const DRAWING_ANSWER = '0d9f8e7c-6b5a-4c3d-9e2f-1a0b9c8d7e6f'
const DRAWN_BY = `${DRAWING_ANSWER}-0123abcd`
const input = { organizationId: 'org_1', documentId: 'doc_1', answerRef: DRAWN_BY, outcome: 'accepted' as const }
const traces = () => vi.mocked(upsertScore).mock.calls.map(([, , request]) => request.traceId)

beforeEach(() => vi.clearAllMocks())

describe('recordSketchEditScore', () => {
  it('scores on the turn that proposed the edit when it is known', async () => {
    await recordSketchEditScore({ ...input, proposingMessageId: 'msg_9' })
    expect(getAnswerTraceId).toHaveBeenCalledWith('msg_9', 'org_1')
    expect(traces()).toEqual(['trace-of-msg_9'])
  })

  it('falls back on the turn that drew the sketch', async () => {
    await recordSketchEditScore({ ...input, proposingMessageId: null })
    expect(getAnswerTraceId).toHaveBeenCalledWith(DRAWING_ANSWER, 'org_1')
    expect(traces()).toEqual([`trace-of-${DRAWING_ANSWER}`])
  })
})
