/**
 * @vitest-environment node
 */
/**
 * `POST /api/webhooks/posthog-support`: PostHog's poke. The service is
 * stubbed; this pins the route's contract with the PostHog workflow (body,
 * statuses) and the two rate limits, against a real in-process limit store.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/product-feedback/reply-notice', () => ({ notifyFeedbackReplies: vi.fn() }))

import { UpstreamError } from '@/lib/api/errors'
import { createInProcessStore, setLimitStore } from '@/lib/limits'
import { notifyFeedbackReplies } from '@/lib/product-feedback/reply-notice'
import { POST } from './route'

const TICKET = '0B1C2D3E-4F50-4617-8899-AABBCCDDEEFF'

const poke = (body: unknown, raw = false) =>
  POST(
    new Request('https://app.piloti.at/api/webhooks/posthog-support', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: raw ? (body as string) : JSON.stringify(body),
    })
  )

beforeEach(() => {
  vi.clearAllMocks()
  setLimitStore(createInProcessStore())
  vi.mocked(notifyFeedbackReplies).mockResolvedValue({ status: 'notified', replies: 1 })
})

describe('POST /api/webhooks/posthog-support', () => {
  it('answers 202 with no body and hands the ticket id, lower-cased, to the service', async () => {
    const response = await poke({ ticketId: TICKET })
    expect(response.status).toBe(202)
    expect(await response.text()).toBe('')
    expect(notifyFeedbackReplies).toHaveBeenCalledWith(TICKET.toLowerCase())
  })

  it('answers 202 the same way for a ticket no report opened, so it reveals no ticket', async () => {
    vi.mocked(notifyFeedbackReplies).mockResolvedValue({ status: 'unknown-ticket' })
    const response = await poke({ ticketId: TICKET })
    expect(response.status).toBe(202)
    expect(await response.text()).toBe('')
  })

  it.each([
    ['no ticket id', {}],
    ['a ticket id that is no uuid', { ticketId: '42; DROP TABLE' }],
    ['a number', { ticketId: 42 }],
  ])('refuses %s with 400 and asks nobody', async (_name, body) => {
    const response = await poke(body)
    expect(response.status).toBe(400)
    expect(notifyFeedbackReplies).not.toHaveBeenCalled()
  })

  it('refuses a body that is not JSON with 400', async () => {
    expect((await poke('ticketId=1', true)).status).toBe(400)
  })

  it('answers 502 when PostHog cannot be read', async () => {
    vi.mocked(notifyFeedbackReplies).mockRejectedValue(new UpstreamError('PostHog Support could not be read.'))
    expect((await poke({ ticketId: TICKET })).status).toBe(502)
  })

  it('stops re-reading one ticket past its limit, while another ticket still gets through', async () => {
    const statuses: number[] = []
    for (let i = 0; i < 31; i += 1) statuses.push((await poke({ ticketId: TICKET })).status)
    expect(statuses.slice(0, 30).every((status) => status === 202)).toBe(true)
    expect(statuses[30]).toBe(429)
    expect(notifyFeedbackReplies).toHaveBeenCalledTimes(30)

    const other = '1b1c2d3e-4f50-4617-8899-aabbccddeeff'
    expect((await poke({ ticketId: other })).status).toBe(202)
  })

  it('stops a burst of made-up ids before any lookup', async () => {
    const statuses: number[] = []
    for (let i = 0; i < 61; i += 1) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
      statuses.push((await poke({ ticketId: id })).status)
    }
    expect(statuses[60]).toBe(429)
    expect(notifyFeedbackReplies).toHaveBeenCalledTimes(60)
  })
})
