// @vitest-environment node
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import {
  countFeedbackTicketsByStatus,
  getSupportTicket,
  listFeedbackTickets,
  openFeedbackTicket,
  resetWidgetTokenCacheForTests,
  updateSupportTicketStatus,
} from './client'
import {
  PosthogSupportUnavailableError,
  SUPPORT_TICKET_STATUSES,
  type PosthogSupportConfig,
} from './types'

const config: PosthogSupportConfig = {
  appHost: 'https://eu.posthog.com',
  ingestHost: 'https://eu.i.posthog.com',
  projectId: '269895',
  projectToken: 'phc_public',
  personalApiKey: 'phx_secret', // pragma: allowlist secret
  appOrigin: 'https://app.piloti.at',
}

const TICKETS = 'https://eu.posthog.com/api/projects/269895/conversations/tickets/'

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const row = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: '0b6c3b1e-1111-4000-8000-000000000001',
  ticket_number: 42,
  status: 'new',
  tags: ['piloti-feedback', 'kind:bug'],
  created_at: '2026-10-20T08:00:00Z',
  updated_at: '2026-10-20T09:00:00Z',
  channel_source: 'widget',
  ...overrides,
})

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

/** A fetch that answers by route and records every call. */
function fakeFetch(route: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = []
  const impl = vi.fn<typeof fetch>(async (input, init) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    }
    calls.push(call)
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    return route(call)
  })
  return { impl, calls }
}

describe('listFeedbackTickets', () => {
  test('asks for feedback-tagged tickets, newest first, with the personal key', async () => {
    const { impl, calls } = fakeFetch(() =>
      json(200, { count: 7, next: null, previous: null, results: [row()] })
    )

    const page = await listFeedbackTickets(
      config,
      { status: 'open', kind: 'bug', limit: 25, offset: 50 },
      impl
    )

    const url = new URL(calls[0].url)
    expect(`${url.origin}${url.pathname}`).toBe(TICKETS)
    expect(JSON.parse(url.searchParams.get('tags_all') ?? '')).toEqual([
      'piloti-feedback',
      'kind:bug',
    ])
    expect(url.searchParams.get('status')).toBe('open')
    expect(url.searchParams.get('limit')).toBe('25')
    expect(url.searchParams.get('offset')).toBe('50')
    expect(url.searchParams.get('order_by')).toBe('-created_at')
    expect(calls[0].headers.authorization).toBe('Bearer phx_secret')
    expect(page).toEqual({
      count: 7,
      tickets: [
        {
          id: '0b6c3b1e-1111-4000-8000-000000000001',
          ticketNumber: 42,
          status: 'new',
          tags: ['piloti-feedback', 'kind:bug'],
          createdAt: '2026-10-20T08:00:00Z',
          updatedAt: '2026-10-20T09:00:00Z',
          url: 'https://eu.posthog.com/project/269895/support/tickets/0b6c3b1e-1111-4000-8000-000000000001',
        },
      ],
    })
  })

  test('without status or kind, filters on the feedback tag alone', async () => {
    const { impl, calls } = fakeFetch(() => json(200, { count: 0, results: [] }))

    await listFeedbackTickets(config, { limit: 10, offset: 0 }, impl)

    const url = new URL(calls[0].url)
    expect(JSON.parse(url.searchParams.get('tags_all') ?? '')).toEqual(['piloti-feedback'])
    expect(url.searchParams.has('status')).toBe(false)
  })

  test('reads tags given as objects with a name, and a missing ticket number', async () => {
    const { impl } = fakeFetch(() =>
      json(200, {
        count: 1,
        results: [
          row({
            tags: [
              { id: 3, name: 'piloti-feedback' },
              { id: 4, name: 'no-contact' },
            ],
            ticket_number: undefined,
          }),
        ],
      })
    )

    const page = await listFeedbackTickets(config, { limit: 10, offset: 0 }, impl)

    expect(page.tickets[0].tags).toEqual(['piloti-feedback', 'no-contact'])
    expect(page.tickets[0].ticketNumber).toBeNull()
  })

  test('drops a row it cannot read and keeps the rest', async () => {
    const { impl } = fakeFetch(() =>
      json(200, { count: 3, results: [row(), row({ status: 'escalated' }), { id: 42 }] })
    )

    const page = await listFeedbackTickets(config, { limit: 10, offset: 0 }, impl)

    expect(page.tickets).toHaveLength(1)
    expect(page.count).toBe(3)
  })

  test('a refusal is PosthogSupportUnavailableError with the status, and never names the key', async () => {
    const { impl } = fakeFetch(() => json(403, { detail: 'nope' }))

    const error = await listFeedbackTickets(config, { limit: 10, offset: 0 }, impl).catch(
      (e: unknown) => e
    )

    expect(error).toBeInstanceOf(PosthogSupportUnavailableError)
    expect((error as PosthogSupportUnavailableError).status).toBe(403)
    expect((error as Error).message).not.toContain('phx_secret')
  })

  test('a network failure is PosthogSupportUnavailableError without a status', async () => {
    const impl = vi.fn<typeof fetch>(async () => {
      throw new TypeError('fetch failed')
    })

    const error = await listFeedbackTickets(config, { limit: 10, offset: 0 }, impl).catch(
      (e: unknown) => e
    )

    expect(error).toBeInstanceOf(PosthogSupportUnavailableError)
    expect((error as PosthogSupportUnavailableError).status).toBeNull()
  })

  test('a body that is not a page is PosthogSupportUnavailableError', async () => {
    const { impl } = fakeFetch(() => json(200, { detail: 'html login page' }))

    await expect(
      listFeedbackTickets(config, { limit: 10, offset: 0 }, impl)
    ).rejects.toBeInstanceOf(PosthogSupportUnavailableError)
  })
})

describe('countFeedbackTicketsByStatus', () => {
  test('one limit=1 call per status, read off count', async () => {
    const { impl, calls } = fakeFetch((call) => {
      const status = new URL(call.url).searchParams.get('status') ?? ''
      return json(200, { count: SUPPORT_TICKET_STATUSES.indexOf(status as never) + 1, results: [] })
    })

    const counts = await countFeedbackTicketsByStatus(config, impl)

    expect(counts).toEqual({ new: 1, open: 2, pending: 3, on_hold: 4, resolved: 5 })
    expect(calls).toHaveLength(SUPPORT_TICKET_STATUSES.length)
    for (const call of calls) expect(new URL(call.url).searchParams.get('limit')).toBe('1')
  })
})

describe('getSupportTicket', () => {
  test('reads one ticket', async () => {
    const { impl, calls } = fakeFetch(() => json(200, row({ status: 'pending' })))

    const ticket = await getSupportTicket(config, 'abc', impl)

    expect(calls[0].url).toBe(`${TICKETS}abc/`)
    expect(ticket?.status).toBe('pending')
  })

  test('404 is null', async () => {
    const { impl } = fakeFetch(() => json(404, { detail: 'Not found.' }))

    expect(await getSupportTicket(config, 'abc', impl)).toBeNull()
  })

  test('500 is PosthogSupportUnavailableError', async () => {
    const { impl } = fakeFetch(() => json(500, {}))

    await expect(getSupportTicket(config, 'abc', impl)).rejects.toMatchObject({ status: 500 })
  })
})

describe('updateSupportTicketStatus', () => {
  test('PATCHes the status and returns the updated ticket', async () => {
    const { impl, calls } = fakeFetch(() => json(200, row({ status: 'resolved' })))

    const ticket = await updateSupportTicketStatus(config, 'abc', 'resolved', impl)

    expect(calls[0]).toMatchObject({
      url: `${TICKETS}abc/`,
      method: 'PATCH',
      body: { status: 'resolved' },
    })
    expect(calls[0].headers.authorization).toBe('Bearer phx_secret')
    expect(calls[0].headers['content-type']).toBe('application/json')
    expect(ticket.status).toBe('resolved')
  })
})

describe('openFeedbackTicket', () => {
  const PROJECT = 'https://eu.i.posthog.com/array/phc_public/config'
  const WIDGET = 'https://eu.i.posthog.com/api/conversations/v1/widget/message'
  const input = {
    message: '[bug] #17 /projects/1\nDer Export hängt.',
    distinctId: 'user_01',
    widgetSessionId: 'widget-session-1',
    sessionId: 'session-1',
    tags: ['piloti-feedback', 'kind:bug'],
  }

  const happy = (call: Call): Response => {
    if (call.url === PROJECT)
      return json(200, { conversations: { token: 'wt_1', enabled: true } })
    if (call.url === WIDGET) return json(200, { ticket_id: 'ticket-1', message_id: 'm-1' })
    if (call.method === 'PATCH') return json(200, row({ id: 'ticket-1' }))
    return json(500, {})
  }

  beforeEach(() => resetWidgetTokenCacheForTests())
  afterEach(() => vi.restoreAllMocks())

  test('posts the widget message exactly as posthog-js does, then tags the ticket', async () => {
    const { impl, calls } = fakeFetch(happy)

    expect(await openFeedbackTicket(config, input, impl)).toBe('ticket-1')

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${PROJECT}`,
      `POST ${WIDGET}`,
      `PATCH ${TICKETS}ticket-1/`,
    ])
    // The widget token is public: reading it sends no key.
    expect(calls[0].headers.authorization).toBeUndefined()
    expect(calls[1].headers['x-conversations-token']).toBe('wt_1')
    // Allowed domains are checked on this call: it carries the app's origin.
    expect(calls[1].headers.origin).toBe('https://app.piloti.at')
    expect(calls[1].headers.authorization).toBeUndefined()
    expect(calls[1].body).toEqual({
      message: input.message,
      traits: { name: null, email: null },
      ticket_id: null,
      widget_session_id: 'widget-session-1',
      distinct_id: 'user_01',
      session_id: 'session-1',
    })
    expect(calls[2].body).toEqual({ tags: ['piloti-feedback', 'kind:bug'] })
  })

  test('makes up a widget session and leaves out a missing replay session', async () => {
    const { impl, calls } = fakeFetch(happy)

    await openFeedbackTicket(config, { ...input, widgetSessionId: null, sessionId: null }, impl)

    const body = calls[1].body as Record<string, unknown>
    expect(body.widget_session_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(body).not.toHaveProperty('session_id')
  })

  test('fetches the widget token once and caches it', async () => {
    const { impl, calls } = fakeFetch(happy)

    await openFeedbackTicket(config, input, impl)
    await openFeedbackTicket(config, input, impl)

    expect(calls.filter((c) => c.url === PROJECT)).toHaveLength(1)
    expect(calls.filter((c) => c.url === WIDGET)).toHaveLength(2)
  })

  test('refetches the widget token after ten minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const { impl, calls } = fakeFetch(happy)
      await openFeedbackTicket(config, input, impl)
      vi.setSystemTime(Date.now() + 10 * 60 * 1000 + 1)
      await openFeedbackTicket(config, input, impl)

      expect(calls.filter((c) => c.url === PROJECT)).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  test('still resolves with the id when tagging fails, and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { impl } = fakeFetch((call) => (call.method === 'PATCH' ? json(500, {}) : happy(call)))

    expect(await openFeedbackTicket(config, input, impl)).toBe('ticket-1')

    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0][0])).toContain('ticket-1')
    expect(String(warn.mock.calls[0][0])).not.toContain('phx_secret')
  })

  test('a refused widget message is PosthogSupportUnavailableError, and nothing is tagged', async () => {
    const { impl, calls } = fakeFetch((call) => (call.url === WIDGET ? json(429, {}) : happy(call)))

    await expect(openFeedbackTicket(config, input, impl)).rejects.toMatchObject({
      name: 'PosthogSupportUnavailableError',
      status: 429,
    })
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false)
  })

  test('a project without Support in its remote config is PosthogSupportUnavailableError', async () => {
    const { impl } = fakeFetch((call) =>
      call.url === PROJECT ? json(200, { conversations: false }) : happy(call)
    )

    await expect(openFeedbackTicket(config, input, impl)).rejects.toBeInstanceOf(
      PosthogSupportUnavailableError
    )
  })

  test('a refused widget token is forgotten, so the next report fetches it afresh', async () => {
    let widgetStatus = 401
    const { impl, calls } = fakeFetch((call) =>
      call.url === WIDGET && widgetStatus === 401 ? json(401, {}) : happy(call)
    )

    await expect(openFeedbackTicket(config, input, impl)).rejects.toMatchObject({ status: 401 })
    widgetStatus = 200
    await openFeedbackTicket(config, input, impl)

    expect(calls.filter((c) => c.url === PROJECT)).toHaveLength(2)
  })
})
