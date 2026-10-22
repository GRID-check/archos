// @vitest-environment node
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import {
  countFeedbackTicketsByStatus,
  assignSupportTicket,
  findPosthogUserIdByEmail,
  getSupportTicket,
  lastVisibleMessageAuthor,
  listCustomerVisibleMessages,
  listFeedbackTickets,
  listFeedbackTicketsOf,
  listPosthogMembers,
  openFeedbackTicket,
  replyAsCustomer,
  resetLastAuthorCacheForTests,
  resetMembersCacheForTests,
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
          assignee: null,
          lastActivityAt: '2026-10-20T09:00:00Z',
          messageCount: null,
          unreadTeamCount: 0,
          url: 'https://eu.posthog.com/project/269895/support/tickets/0b6c3b1e-1111-4000-8000-000000000001',
        },
      ],
    })
  })

  test('asks for several statuses at once, and for one assignee or the unassigned', async () => {
    const { impl, calls } = fakeFetch(() => json(200, { count: 0, results: [] }))

    await listFeedbackTickets(
      config,
      { status: ['new', 'open', 'pending', 'on_hold'], assignee: { userId: 388858 }, limit: 10, offset: 0 },
      impl
    )
    await listFeedbackTickets(config, { assignee: 'unassigned', limit: 10, offset: 0 }, impl)

    const [mine, unassigned] = calls.map((call) => new URL(call.url).searchParams)
    expect(mine!.get('status')).toBe('new,open,pending,on_hold')
    expect(mine!.get('assignee')).toBe('user:388858')
    expect(unassigned!.get('assignee')).toBe('unassigned')
    expect(unassigned!.has('status')).toBe(false)
  })

  test('reads the assignee and the activity as PostHog serves them', async () => {
    const { impl } = fakeFetch(() =>
      json(200, {
        count: 3,
        results: [
          // The shape seen in real data.
          row({
            assignee: { id: 388858, type: 'user', user: { email: 'matthias@piloti.test' }, role: null },
            message_count: 2,
            unread_team_count: 1,
            last_message_at: '2026-10-20T09:30:00Z',
          }),
          row({ assignee: { id: 'role-1', type: 'role', role: { name: 'Support' } } }),
          row({ assignee: { type: 'robot' } }),
        ],
      })
    )

    const { tickets } = await listFeedbackTickets(config, { limit: 10, offset: 0 }, impl)

    expect(tickets[0]).toMatchObject({
      assignee: { type: 'user', id: 388858, email: 'matthias@piloti.test' },
      messageCount: 2,
      unreadTeamCount: 1,
      lastActivityAt: '2026-10-20T09:30:00Z',
    })
    expect(tickets[1]?.assignee).toEqual({ type: 'role', id: 'role-1', name: 'Support' })
    // An assignee it cannot read is unassigned, never a lost row.
    expect(tickets[2]?.assignee).toBeNull()
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

  test('counts one assignee’s tickets when asked', async () => {
    const { impl, calls } = fakeFetch(() => json(200, { count: 0, results: [] }))

    await countFeedbackTicketsByStatus(config, impl, { assignee: 'unassigned' })

    for (const call of calls) expect(new URL(call.url).searchParams.get('assignee')).toBe('unassigned')
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

  test('leaves out a missing replay session', async () => {
    const { impl, calls } = fakeFetch(happy)

    await openFeedbackTicket(config, { ...input, sessionId: null }, impl)

    const body = calls[1].body as Record<string, unknown>
    expect(body.widget_session_id).toBe('widget-session-1')
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

describe('replyAsCustomer', () => {
  const PROJECT = 'https://eu.i.posthog.com/array/phc_public/config'
  const WIDGET = 'https://eu.i.posthog.com/api/conversations/v1/widget/message'
  const reply = {
    ticketId: 'ticket-1',
    widgetSessionId: 'widget-session-1',
    distinctId: 'user_01',
    message: 'Seit gestern, auch in Firefox.',
  }
  const answering = (ticketId: string) => (call: Call): Response => {
    if (call.url === PROJECT) return json(200, { conversations: { token: 'wt_1', enabled: true } })
    if (call.url === WIDGET) return json(200, { ticket_id: ticketId, message_id: 'm-2' })
    return json(500, {})
  }

  beforeEach(() => resetWidgetTokenCacheForTests())

  test("posts onto the existing ticket from the session that opened it, without the personal key", async () => {
    const { impl, calls } = fakeFetch(answering('ticket-1'))

    await replyAsCustomer(config, reply, impl)

    expect(calls[1].url).toBe(WIDGET)
    expect(calls[1].headers.authorization).toBeUndefined()
    expect(calls[1].body).toEqual({
      message: reply.message,
      traits: { name: null, email: null },
      ticket_id: 'ticket-1',
      widget_session_id: 'widget-session-1',
      distinct_id: 'user_01',
    })
    // A reply is a message, not a new ticket: nothing is tagged.
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false)
  })

  test('a reply PostHog put on another ticket is an error, not a silent split', async () => {
    const { impl } = fakeFetch(answering('ticket-2'))

    await expect(replyAsCustomer(config, reply, impl)).rejects.toBeInstanceOf(PosthogSupportUnavailableError)
  })
})

describe('listCustomerVisibleMessages', () => {
  test('keeps the reporter’s messages and the replies sent to them, never notes or AI drafts', async () => {
    const { impl, calls } = fakeFetch(() =>
      json(200, {
        count: 5,
        next: null,
        previous: null,
        results: [
          { id: 'm1', message_type: 'customer_message', content: 'Der Export hängt.', author_name: 'Customer', is_private: false, created_at: '2026-10-20T08:00:00Z' },
          { id: 'm2', message_type: 'internal_note', content: 'Kunde ist VIP', author_name: 'Matthias', is_private: true, created_at: '2026-10-20T08:10:00Z' },
          { id: 'm3', message_type: 'ai_draft', content: 'Entwurf', author_name: 'AI', is_private: true, created_at: '2026-10-20T08:11:00Z' },
          { id: 'm4', message_type: 'sent_reply', content: 'Seit wann?', author_name: 'Matthias Bigl', author_email: 'm@posthog.test', is_private: false, created_at: '2026-10-20T08:20:00Z' },
          { id: 'm5', message_type: 'sent_reply', content: 'leaked?', author_name: 'X', is_private: true, created_at: '2026-10-20T08:30:00Z' },
        ],
      })
    )

    const messages = await listCustomerVisibleMessages(config, 'ticket-1', impl)

    expect(calls[0].url).toBe(`${TICKETS}ticket-1/messages/?limit=200`)
    expect(calls[0].headers.authorization).toBe('Bearer phx_secret')
    expect(messages).toEqual([
      { id: 'm1', author: 'customer', authorName: null, content: 'Der Export hängt.', createdAt: '2026-10-20T08:00:00Z' },
      { id: 'm4', author: 'team', authorName: 'Matthias Bigl', content: 'Seit wann?', createdAt: '2026-10-20T08:20:00Z' },
    ])
  })

  test('an unreadable thread is PosthogSupportUnavailableError', async () => {
    const { impl } = fakeFetch(() => json(503, {}))

    await expect(listCustomerVisibleMessages(config, 'ticket-1', impl)).rejects.toMatchObject({ status: 503 })
  })
})

describe('listFeedbackTicketsOf', () => {
  test("asks for one person's feedback tickets, most recently updated first", async () => {
    const { impl, calls } = fakeFetch(() => json(200, { count: 1, next: null, previous: null, results: [row()] }))

    const tickets = await listFeedbackTicketsOf(config, 'user_01', 20, impl)

    const url = new URL(calls[0].url)
    expect(url.searchParams.get('distinct_ids')).toBe('user_01')
    expect(JSON.parse(url.searchParams.get('tags_all') ?? '')).toEqual(['piloti-feedback'])
    expect(url.searchParams.get('order_by')).toBe('-updated_at')
    expect(url.searchParams.get('limit')).toBe('20')
    expect(tickets.map((t) => t.id)).toEqual(['0b6c3b1e-1111-4000-8000-000000000001'])
  })
})

describe('the PostHog members', () => {
  beforeEach(() => resetMembersCacheForTests())

  const members = (results: unknown[]) => json(200, { count: results.length, results })

  test('names each member from their first and last name, and reads the list once for a while', async () => {
    const { impl, calls } = fakeFetch(() =>
      members([
        { id: 'm-1', user: { id: 1, email: 'anna@posthog.test', first_name: 'Anna', last_name: 'Wallner' } },
        { id: 'm-2', user: { id: 2, email: 'bot@posthog.test', first_name: '', last_name: null } },
        { id: 'm-3', user: { email: 'broken' } },
      ])
    )

    const first = await listPosthogMembers(config, impl)
    await listPosthogMembers(config, impl)

    expect(first).toEqual([
      { id: 1, email: 'anna@posthog.test', name: 'Anna Wallner' },
      { id: 2, email: 'bot@posthog.test', name: null },
    ])
    expect(calls).toHaveLength(1)
  })

  test('a miss in the cached list reads it afresh before saying nobody has the email', async () => {
    let joined = false
    const { impl, calls } = fakeFetch(() =>
      members([
        { id: 'm-1', user: { id: 1, email: 'anna@posthog.test' } },
        ...(joined ? [{ id: 'm-2', user: { id: 2, email: 'new@posthog.test' } }] : []),
      ])
    )
    await listPosthogMembers(config, impl)
    joined = true

    expect(await findPosthogUserIdByEmail(config, 'new@posthog.test', impl)).toBe(2)
    expect(calls).toHaveLength(2)
  })
})

describe('lastVisibleMessageAuthor', () => {
  beforeEach(() => resetLastAuthorCacheForTests())

  const message = (message_type: string, is_private = false) => ({
    id: `m-${message_type}`,
    message_type,
    content: 'x',
    is_private,
    created_at: '2026-10-20T09:00:00Z',
  })
  const thread = { id: 'ticket-1', updatedAt: '2026-10-20T09:00:00Z', messageCount: 8 }

  test('reads only the tail of the thread, and skips notes and AI drafts', async () => {
    const { impl, calls } = fakeFetch(() =>
      json(200, {
        count: 8,
        results: [message('sent_reply'), message('customer_message'), message('internal_note', true), message('ai_draft', true)],
      })
    )

    expect(await lastVisibleMessageAuthor(config, thread, impl)).toBe('customer')
    const url = new URL(calls[0]!.url)
    expect(url.pathname).toBe('/api/projects/269895/conversations/tickets/ticket-1/messages/')
    expect(url.searchParams.get('offset')).toBe('3')
    expect(url.searchParams.get('limit')).toBe('5')
  })

  test('a team reply last means the reporter owes the answer', async () => {
    const { impl } = fakeFetch(() => json(200, { count: 2, results: [message('customer_message'), message('sent_reply')] }))

    expect(await lastVisibleMessageAuthor(config, { ...thread, messageCount: 2 }, impl)).toBe('team')
  })

  test('remembers the answer until the ticket changes', async () => {
    const { impl, calls } = fakeFetch(() => json(200, { count: 1, results: [message('customer_message')] }))
    const one = { ...thread, messageCount: 1 }

    await lastVisibleMessageAuthor(config, one, impl)
    await lastVisibleMessageAuthor(config, one, impl)
    expect(calls).toHaveLength(1)

    await lastVisibleMessageAuthor(config, { ...one, updatedAt: '2026-10-20T10:00:00Z' }, impl)
    expect(calls).toHaveLength(2)
  })

  test('reads the real tail when the thread grew past the count the ticket carried', async () => {
    const { impl, calls } = fakeFetch((call) =>
      new URL(call.url).searchParams.get('offset') === '0'
        ? json(200, { count: 9, results: [message('customer_message')] })
        : json(200, { count: 9, results: [message('sent_reply')] })
    )

    expect(await lastVisibleMessageAuthor(config, { ...thread, messageCount: 1 }, impl)).toBe('team')
    expect(new URL(calls[1]!.url).searchParams.get('offset')).toBe('4')
  })

  test('an unreadable thread is PosthogSupportUnavailableError', async () => {
    const { impl } = fakeFetch(() => json(500, {}))

    await expect(lastVisibleMessageAuthor(config, thread, impl)).rejects.toBeInstanceOf(PosthogSupportUnavailableError)
  })
})

describe('taking a ticket', () => {
  beforeEach(() => resetMembersCacheForTests())

  test('finds the PostHog user id by email, case-insensitively, through the members list', async () => {
    const { impl, calls } = fakeFetch(() =>
      json(200, {
        count: 2,
        next: null,
        previous: null,
        results: [
          { id: 'm-1', user: { id: 1, uuid: 'u-1', email: 'anna@posthog.test' } },
          { id: 'm-2', user: { id: 338908, uuid: 'u-2', email: 'Matthias@Bigls.net' } },
        ],
      })
    )

    expect(await findPosthogUserIdByEmail(config, 'matthias@bigls.net', impl)).toBe(338908)
    expect(await findPosthogUserIdByEmail(config, 'nobody@example.test', impl)).toBeNull()
    expect(calls[0].url).toBe('https://eu.posthog.com/api/organizations/@current/members/?limit=200')
    expect(calls[0].headers.authorization).toBe('Bearer phx_secret')
  })

  test('assigns by PATCHing the ticket with a user assignee', async () => {
    const { impl, calls } = fakeFetch(() => json(200, row({ id: 'ticket-1' })))

    await assignSupportTicket(config, 'ticket-1', 338908, impl)

    expect(calls[0]).toMatchObject({
      url: `${TICKETS}ticket-1/`,
      method: 'PATCH',
      body: { assignee: { type: 'user', id: 338908 } },
    })
  })
})
