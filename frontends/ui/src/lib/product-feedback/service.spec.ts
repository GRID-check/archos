/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/authz/platform', () => ({
  requirePlatformPermission: vi.fn(),
}))
vi.mock('@/lib/db/tenant-context', () => ({
  withPlatformAccess: vi.fn(async (_reason: string, fn: () => unknown) => await fn()),
}))
vi.mock('@/lib/organizations/service', () => ({ getOrganizationDisplayName: vi.fn() }))
vi.mock('@/lib/organizations/display-names', () => ({ getOrganizationDisplayNames: vi.fn() }))
vi.mock('./announce', () => ({ announceProductFeedback: vi.fn() }))
vi.mock('@/lib/analytics/posthog-server', () => ({ captureServer: vi.fn() }))
vi.mock('@/lib/upload-screening/service', () => ({ maskChatText: vi.fn() }))
vi.mock('@/lib/posthog-support/config', () => ({ posthogSupportConfigFromEnv: vi.fn() }))
vi.mock('@/lib/posthog-support/client', () => ({
  openFeedbackTicket: vi.fn(),
  listFeedbackTickets: vi.fn(),
  countFeedbackTicketsByStatus: vi.fn(),
  getSupportTicket: vi.fn(),
  updateSupportTicketStatus: vi.fn(),
  listFeedbackTicketsOf: vi.fn(),
  listCustomerVisibleMessages: vi.fn(),
  replyAsCustomer: vi.fn(),
  findPosthogUserIdByEmail: vi.fn(),
  assignSupportTicket: vi.fn(),
}))
vi.mock('./repository', () => ({
  PRODUCT_FEEDBACK_LIST_LIMIT: 2,
  insertProductFeedback: vi.fn(),
  setProductFeedbackTicket: vi.fn(),
  listProductFeedback: vi.fn(),
  getProductFeedback: vi.fn(),
  getProductFeedbackByTicketIds: vi.fn(),
  OWN_PRODUCT_FEEDBACK_LIMIT: 20,
  listOwnProductFeedback: vi.fn(),
  getOwnProductFeedback: vi.fn(),
  markOwnProductFeedbackSeen: vi.fn(),
}))

import { captureServer } from '@/lib/analytics/posthog-server'
import type { AuthorizedSession } from '@/lib/auth/types'
import { requirePlatformPermission } from '@/lib/authz/platform'
import type { ProductFeedback } from '@/lib/db/schema'
import { getOrganizationDisplayName } from '@/lib/organizations/service'
import { getOrganizationDisplayNames } from '@/lib/organizations/display-names'
import {
  assignSupportTicket,
  countFeedbackTicketsByStatus,
  findPosthogUserIdByEmail,
  getSupportTicket,
  listCustomerVisibleMessages,
  listFeedbackTickets,
  listFeedbackTicketsOf,
  openFeedbackTicket,
  replyAsCustomer,
  updateSupportTicketStatus,
} from '@/lib/posthog-support/client'
import { posthogSupportConfigFromEnv } from '@/lib/posthog-support/config'
import {
  PosthogSupportUnavailableError,
  type PosthogSupportConfig,
  type SupportTicket,
} from '@/lib/posthog-support/types'
import { maskChatText } from '@/lib/upload-screening/service'
import { announceProductFeedback } from './announce'
import * as repository from './repository'
import {
  claimProductFeedbackTicket,
  decodeCursor,
  encodeCursor,
  getOwnProductFeedbackThread,
  getProductFeedbackForPlatform,
  listOwnProductFeedbackThreads,
  listProductFeedbackForPlatform,
  replyToOwnProductFeedback,
  submitProductFeedback,
  supportTicketText,
  triageProductFeedback,
} from './service'

const session: AuthorizedSession = {
  userId: 'user_reporter',
  email: 'maria@buero.test',
  name: 'Maria Huber',
  accessToken: 'token',
  organizationId: 'org_tenant',
  organizationMembershipId: 'om_1',
  role: 'member',
  permissions: [],
  featureFlags: null,
}

const config: PosthogSupportConfig = {
  appHost: 'https://eu.posthog.com',
  ingestHost: 'https://eu.i.posthog.com',
  projectId: '269895',
  projectToken: 'phc_public',
  personalApiKey: 'phx_test',
  appOrigin: 'https://app.piloti.at',
}

const at = new Date('2026-09-29T08:00:00Z')
const REPORT_ID = '7b6a2c1e-0000-4000-8000-000000000001'

function stored(overrides: Partial<ProductFeedback> = {}): ProductFeedback & { organizationName: string | null } {
  return {
    id: REPORT_ID,
    organizationId: 'org_tenant',
    organizationName: 'Büro Nord',
    userId: 'user_reporter',
    userName: 'Maria Huber',
    userEmail: 'maria@buero.test',
    kind: 'bug',
    message: 'Der Upload bleibt bei 99 % stehen.',
    pagePath: '/app/projects',
    context: { viewport: '1440x900' },
    allowContact: true,
    posthogTicketId: null,
    posthogWidgetSessionId: null,
    reporterSeenAt: null,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  }
}

function ticket(overrides: Partial<SupportTicket> = {}): SupportTicket {
  return {
    id: 'ticket-1',
    ticketNumber: 42,
    status: 'open',
    tags: ['piloti-feedback', 'kind:bug'],
    createdAt: at.toISOString(),
    updatedAt: at.toISOString(),
    url: 'https://eu.posthog.com/project/269895/support/tickets/ticket-1',
    ...overrides,
  }
}

const NO_COUNTS = { new: 0, open: 0, pending: 0, on_hold: 0, resolved: 0 }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requirePlatformPermission).mockResolvedValue(undefined)
  vi.mocked(repository.insertProductFeedback).mockResolvedValue(stored())
  vi.mocked(repository.listProductFeedback).mockResolvedValue([])
  vi.mocked(repository.getProductFeedbackByTicketIds).mockResolvedValue(new Map())
  vi.mocked(getOrganizationDisplayName).mockResolvedValue('Büro Nord')
  vi.mocked(getOrganizationDisplayNames).mockResolvedValue(new Map())
  vi.mocked(announceProductFeedback).mockResolvedValue({ status: 'announced', recipients: 2 })
  vi.mocked(maskChatText).mockImplementation(async (_organizationId, text) => ({ text }) as never)
  vi.mocked(posthogSupportConfigFromEnv).mockReturnValue(config)
  vi.mocked(openFeedbackTicket).mockResolvedValue('ticket-1')
  vi.mocked(listFeedbackTickets).mockResolvedValue({ tickets: [], count: 0 })
  vi.mocked(countFeedbackTicketsByStatus).mockResolvedValue(NO_COUNTS)
})

describe('submitProductFeedback', () => {
  const input = {
    kind: 'bug' as const,
    message: 'Der Upload bleibt bei 99 % stehen.',
    pagePath: '/app/projects',
    allowContact: true,
    context: { viewport: '1440x900' },
    posthog: { sessionId: 's-0199' },
  }

  it('stores the report as the caller, in the caller organization', async () => {
    await submitProductFeedback(session, input)

    expect(repository.insertProductFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org_tenant',
        userId: 'user_reporter',
        userName: 'Maria Huber',
        userEmail: 'maria@buero.test',
        kind: 'bug',
      }),
    )
  })

  it('announces the stored report with the organization name, and answers with its id only', async () => {
    const view = await submitProductFeedback(session, input)

    expect(announceProductFeedback).toHaveBeenCalledWith(stored(), 'Büro Nord')
    expect(view).toEqual({ id: REPORT_ID, kind: 'bug', createdAt: at.toISOString() })
  })

  it('opens a tagged ticket in a conversations session of its own, and remembers both', async () => {
    await submitProductFeedback(session, input)

    const opened = vi.mocked(openFeedbackTicket).mock.calls[0]?.[1]
    expect(opened).toEqual({
      message: supportTicketText('bug', REPORT_ID, '/app/projects', input.message),
      distinctId: 'user_reporter',
      widgetSessionId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
      sessionId: 's-0199',
      tags: ['piloti-feedback', 'kind:bug'],
    })
    // The session the ticket was opened in is the one later replies must use.
    expect(repository.setProductFeedbackTicket).toHaveBeenCalledWith(REPORT_ID, 'ticket-1', opened?.widgetSessionId)
  })

  it('tells the support automation the ticket opened, with ids and the kind and never the words', async () => {
    await submitProductFeedback(session, input)

    expect(captureServer).toHaveBeenCalledWith({
      event: 'product_feedback_ticket_opened',
      distinctId: 'user_reporter',
      organizationId: 'org_tenant',
      properties: { ticket_id: 'ticket-1', report_id: REPORT_ID, kind: 'bug', allow_contact: true },
    })
  })

  it('announces no ticket that did not open', async () => {
    vi.mocked(openFeedbackTicket).mockRejectedValue(new PosthogSupportUnavailableError('down', 503))

    await submitProductFeedback(session, input)

    expect(captureServer).not.toHaveBeenCalled()
  })

  it('opens every report in a fresh session, never one shared between reports', async () => {
    await submitProductFeedback(session, input)
    await submitProductFeedback(session, input)

    const [first, second] = vi.mocked(openFeedbackTicket).mock.calls.map((call) => call[1].widgetSessionId)
    expect(first).not.toBe(second)
  })

  it('sends the words masked against the caller organization policy, never as typed', async () => {
    vi.mocked(maskChatText).mockResolvedValue({ text: 'Honorar [maskiert] zu hoch' } as never)

    await submitProductFeedback(session, { ...input, message: 'Honorar 48.000 EUR zu hoch' })

    expect(maskChatText).toHaveBeenCalledWith('org_tenant', 'Honorar 48.000 EUR zu hoch')
    expect(vi.mocked(openFeedbackTicket).mock.calls[0]?.[1].message).toBe(
      `[bug] #${REPORT_ID} /app/projects\nHonorar [maskiert] zu hoch`,
    )
    // The stored record is what the reporter typed; platform owners read that.
    expect(repository.insertProductFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Honorar 48.000 EUR zu hoch' }),
    )
  })

  it('opens a ticket for a reporter who declined contact too, tagged so nobody replies', async () => {
    vi.mocked(repository.insertProductFeedback).mockResolvedValue(stored({ allowContact: false }))

    await submitProductFeedback(session, { ...input, allowContact: false })

    expect(vi.mocked(openFeedbackTicket).mock.calls[0]?.[1].tags).toEqual(['piloti-feedback', 'kind:bug', 'no-contact'])
  })

  it('opens no ticket, rather than sending the raw text, when the policy cannot be read', async () => {
    vi.mocked(maskChatText).mockRejectedValue(new Error('settings unavailable'))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const view = await submitProductFeedback(session, input)

    expect(openFeedbackTicket).not.toHaveBeenCalled()
    expect(view.id).toBe(REPORT_ID)
  })

  it('still thanks the reporter when PostHog refuses the ticket', async () => {
    vi.mocked(openFeedbackTicket).mockRejectedValue(new PosthogSupportUnavailableError('down', 503))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const view = await submitProductFeedback(session, input)

    expect(view.id).toBe(REPORT_ID)
    expect(repository.setProductFeedbackTicket).not.toHaveBeenCalled()
  })

  it('opens no ticket where Support is not configured', async () => {
    vi.mocked(posthogSupportConfigFromEnv).mockReturnValue(null)

    await submitProductFeedback(session, input)

    expect(openFeedbackTicket).not.toHaveBeenCalled()
    expect(maskChatText).not.toHaveBeenCalled()
  })

  it('still announces when the organization name cannot be resolved', async () => {
    vi.mocked(getOrganizationDisplayName).mockResolvedValue(null)

    await submitProductFeedback(session, input)

    expect(announceProductFeedback).toHaveBeenCalledWith(stored(), null)
  })
})

describe('the platform half is gated in the service, not only on the route', () => {
  it('reads with settings:view', async () => {
    await listProductFeedbackForPlatform(session, {})
    expect(requirePlatformPermission).toHaveBeenCalledWith(session, 'platform:settings:view')
  })

  it('triages with settings:manage and refuses before touching PostHog', async () => {
    vi.mocked(requirePlatformPermission).mockRejectedValue(new Error('denied'))

    await expect(triageProductFeedback(session, REPORT_ID, 'resolved')).rejects.toThrow('denied')
    expect(requirePlatformPermission).toHaveBeenCalledWith(session, 'platform:settings:manage')
    expect(updateSupportTicketStatus).not.toHaveBeenCalled()
  })

  it('answers not found for an unknown report', async () => {
    vi.mocked(repository.getProductFeedback).mockResolvedValue(null)
    await expect(getProductFeedbackForPlatform(session, REPORT_ID)).rejects.toThrow(/Unknown/)
  })
})

describe('the triage list reads PostHog', () => {
  it("joins a page of tickets to their reports and carries PostHog's counts", async () => {
    const counts = { ...NO_COUNTS, open: 1 }
    vi.mocked(listFeedbackTickets).mockResolvedValue({ tickets: [ticket()], count: 1 })
    vi.mocked(countFeedbackTicketsByStatus).mockResolvedValue(counts)
    vi.mocked(repository.getProductFeedbackByTicketIds).mockResolvedValue(
      new Map([['ticket-1', stored({ posthogTicketId: 'ticket-1' })]]),
    )

    const list = await listProductFeedbackForPlatform(session, { status: 'open', kind: 'bug' })

    expect(listFeedbackTickets).toHaveBeenCalledWith(config, { status: 'open', kind: 'bug', limit: 2, offset: 0 })
    expect(list.source).toBe('posthog')
    expect(list.counts).toEqual(counts)
    expect(list.reports).toHaveLength(1)
    expect(list.reports[0]?.ticket).toEqual({ id: 'ticket-1', number: 42, status: 'open', url: ticket().url })
    expect(list.reports[0]?.posthogPersonUrl).toBe('https://eu.posthog.com/project/269895/person/user_reporter')
  })

  it('lists recent reports whose ticket never opened beside the tickets, on the first page', async () => {
    vi.mocked(repository.listProductFeedback).mockResolvedValue([stored()])

    const list = await listProductFeedbackForPlatform(session, {})

    expect(repository.listProductFeedback).toHaveBeenCalledWith(expect.objectContaining({ unticketed: true }))
    expect(list.unticketed.map((report) => report.id)).toEqual([REPORT_ID])
    expect(list.unticketed[0]?.ticket).toBeNull()
  })

  it('skips a tagged ticket whose report is gone', async () => {
    vi.mocked(listFeedbackTickets).mockResolvedValue({ tickets: [ticket()], count: 1 })

    const list = await listProductFeedbackForPlatform(session, {})

    expect(list.reports).toEqual([])
  })

  it('pages by offset while PostHog has more', async () => {
    const tickets = [ticket(), ticket({ id: 'ticket-2' })]
    vi.mocked(listFeedbackTickets).mockResolvedValue({ tickets, count: 5 })

    const first = await listProductFeedbackForPlatform(session, {})
    expect(first.nextCursor).toBe('o:2')

    await listProductFeedbackForPlatform(session, { cursor: 'o:2' })
    expect(listFeedbackTickets).toHaveBeenLastCalledWith(config, expect.objectContaining({ offset: 2 }))
  })

  it('falls back to the local log, read-only, when PostHog cannot be read', async () => {
    vi.mocked(listFeedbackTickets).mockRejectedValue(new PosthogSupportUnavailableError('down', 502))
    vi.mocked(repository.listProductFeedback).mockResolvedValue([stored({ posthogTicketId: 'ticket-1' })])
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const list = await listProductFeedbackForPlatform(session, { cursor: 'o:50' })

    expect(list.source).toBe('local')
    expect(list.counts).toBeNull()
    expect(list.reports[0]?.ticket).toBeNull()
    // The offset cursor means nothing to the local log.
    expect(repository.listProductFeedback).toHaveBeenCalledWith(expect.objectContaining({ before: undefined }))
  })

  it('lists the local log where Support is not configured, with no PostHog links', async () => {
    vi.mocked(posthogSupportConfigFromEnv).mockReturnValue(null)
    vi.mocked(repository.listProductFeedback).mockResolvedValue([stored()])

    const list = await listProductFeedbackForPlatform(session, {})

    expect(listFeedbackTickets).not.toHaveBeenCalled()
    expect(list.source).toBe('local')
    expect(list.reports[0]?.posthogPersonUrl).toBeNull()
  })
})

describe('one report', () => {
  it('carries its live ticket', async () => {
    vi.mocked(repository.getProductFeedback).mockResolvedValue(stored({ posthogTicketId: 'ticket-1' }))
    vi.mocked(getSupportTicket).mockResolvedValue(ticket({ status: 'pending' }))

    const view = await getProductFeedbackForPlatform(session, REPORT_ID)

    expect(getSupportTicket).toHaveBeenCalledWith(config, 'ticket-1')
    expect(view.ticket?.status).toBe('pending')
  })

  it('still opens when PostHog cannot say where its ticket is', async () => {
    vi.mocked(repository.getProductFeedback).mockResolvedValue(stored({ posthogTicketId: 'ticket-1' }))
    vi.mocked(getSupportTicket).mockRejectedValue(new PosthogSupportUnavailableError('down'))

    const view = await getProductFeedbackForPlatform(session, REPORT_ID)

    expect(view.ticket).toBeNull()
  })

  it('withholds the address of a reporter who did not agree to be contacted', async () => {
    vi.mocked(repository.getProductFeedback).mockResolvedValue(stored({ allowContact: false }))

    const view = await getProductFeedbackForPlatform(session, REPORT_ID)

    expect(view.reporter).toEqual({ userId: 'user_reporter', name: 'Maria Huber', email: null })
  })
})

describe('triage moves the PostHog ticket', () => {
  it('sends the status to PostHog and answers with the moved ticket', async () => {
    vi.mocked(repository.getProductFeedback).mockResolvedValue(stored({ posthogTicketId: 'ticket-1' }))
    vi.mocked(updateSupportTicketStatus).mockResolvedValue(ticket({ status: 'resolved' }))

    const view = await triageProductFeedback(session, REPORT_ID, 'resolved')

    expect(updateSupportTicketStatus).toHaveBeenCalledWith(config, 'ticket-1', 'resolved')
    expect(view.ticket?.status).toBe('resolved')
  })

  it('refuses a report that has no ticket to move', async () => {
    vi.mocked(repository.getProductFeedback).mockResolvedValue(stored())

    await expect(triageProductFeedback(session, REPORT_ID, 'resolved')).rejects.toMatchObject({ status: 409 })
    expect(updateSupportTicketStatus).not.toHaveBeenCalled()
  })

  it('answers 502 when PostHog does not take the change', async () => {
    vi.mocked(repository.getProductFeedback).mockResolvedValue(stored({ posthogTicketId: 'ticket-1' }))
    vi.mocked(updateSupportTicketStatus).mockRejectedValue(new PosthogSupportUnavailableError('down', 503))

    await expect(triageProductFeedback(session, REPORT_ID, 'resolved')).rejects.toMatchObject({ status: 502 })
  })
})

describe('organization names', () => {
  it('names an organization without a local row through the resolver, never as unknown', async () => {
    vi.mocked(posthogSupportConfigFromEnv).mockReturnValue(null)
    const unnamed = stored({ organizationId: 'org_prod', organizationName: null } as never)
    vi.mocked(repository.listProductFeedback).mockResolvedValue([unnamed, stored()])
    vi.mocked(repository.getProductFeedback).mockResolvedValue(unnamed)
    vi.mocked(getOrganizationDisplayNames).mockResolvedValue(new Map([['org_prod', 'feld72 Architekten']]))

    const list = await listProductFeedbackForPlatform(session, {})
    const one = await getProductFeedbackForPlatform(session, unnamed.id)

    expect(list.reports.map((report) => report.organizationName)).toEqual(['feld72 Architekten', 'Büro Nord'])
    expect(one.organizationName).toBe('feld72 Architekten')
    // Only the organizations the local join could not name are resolved.
    expect(getOrganizationDisplayNames).toHaveBeenCalledWith(['org_prod'])
  })
})

describe('paging the local log', () => {
  it('hands out a cursor only when the page is full', async () => {
    vi.mocked(posthogSupportConfigFromEnv).mockReturnValue(null)
    vi.mocked(repository.listProductFeedback).mockResolvedValue([
      stored(),
      stored({ id: 'b'.repeat(8) + '-0000-4000-8000-000000000002' }),
    ])
    const full = await listProductFeedbackForPlatform(session, {})
    expect(full.nextCursor).not.toBeNull()

    vi.mocked(repository.listProductFeedback).mockResolvedValue([stored()])
    const partial = await listProductFeedbackForPlatform(session, {})
    expect(partial.nextCursor).toBeNull()
  })

  it('round-trips a cursor and rejects junk', () => {
    const cursor = encodeCursor(stored())
    expect(decodeCursor(cursor)).toEqual({ createdAt: at, id: REPORT_ID })
    expect(decodeCursor('not-a-cursor')).toBeUndefined()
    expect(decodeCursor(`${at.toISOString()}|'; drop table`)).toBeUndefined()
  })
})

describe("the reporter's own threads", () => {
  const SESSION_ID = '0b1c2d3e-4f50-4617-8899-aabbccddeeff'
  const seen = new Date('2026-09-29T09:00:00Z')
  const answerable = (overrides: Partial<ProductFeedback> = {}) =>
    stored({ posthogTicketId: 'ticket-1', posthogWidgetSessionId: SESSION_ID, reporterSeenAt: seen, ...overrides })

  beforeEach(() => {
    vi.mocked(repository.listOwnProductFeedback).mockResolvedValue([answerable()])
    vi.mocked(repository.getOwnProductFeedback).mockResolvedValue(answerable())
    vi.mocked(listFeedbackTicketsOf).mockResolvedValue([ticket({ status: 'pending', updatedAt: '2026-09-29T10:00:00Z' })])
    vi.mocked(getSupportTicket).mockResolvedValue(ticket({ status: 'pending' }))
    vi.mocked(listCustomerVisibleMessages).mockResolvedValue([
      {
        id: 'm1',
        author: 'customer',
        authorName: null,
        content: `[bug] #${REPORT_ID} /app/projects\nDer Upload bleibt bei [maskiert] stehen.`,
        createdAt: at.toISOString(),
      },
      { id: 'm2', author: 'team', authorName: 'Matthias', content: 'Seit wann?', createdAt: '2026-09-29T10:00:00Z' },
    ])
    vi.mocked(replyAsCustomer).mockResolvedValue(undefined)
  })

  it('lists only rows keyed to the caller, with the ticket status and news since they looked', async () => {
    const list = await listOwnProductFeedbackThreads(session)

    expect(repository.listOwnProductFeedback).toHaveBeenCalledWith('org_tenant', 'user_reporter', {
      limit: 20,
      before: undefined,
    })
    expect(listFeedbackTicketsOf).toHaveBeenCalledWith(config, 'user_reporter', 100)
    expect(list).toEqual({
      reports: [
        expect.objectContaining({ id: REPORT_ID, status: 'pending', hasUpdate: true, canReply: true }),
      ],
      updatedCount: 1,
      live: true,
      nextCursor: null,
    })
  })

  it('pages with a keyset cursor once a page is full', async () => {
    const list = await listOwnProductFeedbackThreads(session, { limit: 1 })

    expect(list.nextCursor).toBe(encodeCursor(answerable()))
    await listOwnProductFeedbackThreads(session, { limit: 1, cursor: list.nextCursor ?? undefined })
    expect(vi.mocked(repository.listOwnProductFeedback).mock.calls[1]?.[2]).toEqual({
      limit: 1,
      before: { createdAt: at, id: REPORT_ID },
    })
  })

  it('counts nothing as news that happened before the reporter last looked', async () => {
    vi.mocked(listFeedbackTicketsOf).mockResolvedValue([ticket({ updatedAt: '2026-09-29T08:30:00Z' })])

    const list = await listOwnProductFeedbackThreads(session)

    expect(list.reports[0]?.hasUpdate).toBe(false)
    expect(list.updatedCount).toBe(0)
  })

  it('still lists the reports while PostHog cannot be read, without statuses', async () => {
    vi.mocked(listFeedbackTicketsOf).mockRejectedValue(new PosthogSupportUnavailableError('down', 503))

    const list = await listOwnProductFeedbackThreads(session)

    expect(list.live).toBe(false)
    expect(list.reports[0]).toEqual(expect.objectContaining({ status: null, hasUpdate: false }))
  })

  it('asks PostHog nothing for a person whose reports opened no ticket', async () => {
    vi.mocked(repository.listOwnProductFeedback).mockResolvedValue([stored()])

    await listOwnProductFeedbackThreads(session)

    expect(listFeedbackTicketsOf).not.toHaveBeenCalled()
  })

  it("shows the report as the reporter typed it, then the team's reply, and marks the thread seen", async () => {
    const thread = await getOwnProductFeedbackThread(session, REPORT_ID)

    expect(repository.getOwnProductFeedback).toHaveBeenCalledWith('org_tenant', 'user_reporter', REPORT_ID)
    expect(thread.messages).toEqual([
      expect.objectContaining({ author: 'me', content: 'Der Upload bleibt bei 99 % stehen.' }),
      expect.objectContaining({ author: 'team', authorName: 'Matthias', content: 'Seit wann?' }),
    ])
    expect(thread.live).toBe(true)
    expect(thread.report.hasUpdate).toBe(false)
    expect(repository.markOwnProductFeedbackSeen).toHaveBeenCalledWith(
      'org_tenant',
      'user_reporter',
      REPORT_ID,
      expect.any(Date),
    )
  })

  it("is a 404 for a report that is not the caller's own", async () => {
    vi.mocked(repository.getOwnProductFeedback).mockResolvedValue(null)

    await expect(getOwnProductFeedbackThread(session, REPORT_ID)).rejects.toMatchObject({ status: 404 })
    expect(listCustomerVisibleMessages).not.toHaveBeenCalled()
  })

  it('shows the report alone, unmarked, while the ticket cannot be read', async () => {
    vi.mocked(listCustomerVisibleMessages).mockRejectedValue(new PosthogSupportUnavailableError('down', 503))

    const thread = await getOwnProductFeedbackThread(session, REPORT_ID)

    expect(thread.live).toBe(false)
    expect(thread.messages).toHaveLength(1)
    expect(repository.markOwnProductFeedbackSeen).not.toHaveBeenCalled()
  })

  it('sends a reply masked, onto the same ticket, from the session that opened it', async () => {
    vi.mocked(maskChatText).mockResolvedValue({ text: 'Seit Version [maskiert]' } as never)

    await replyToOwnProductFeedback(session, REPORT_ID, 'Seit Version 48.000')

    expect(maskChatText).toHaveBeenCalledWith('org_tenant', 'Seit Version 48.000')
    expect(replyAsCustomer).toHaveBeenCalledWith(config, {
      ticketId: 'ticket-1',
      widgetSessionId: SESSION_ID,
      distinctId: 'user_reporter',
      message: 'Seit Version [maskiert]',
    })
    expect(captureServer).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'product_feedback_reply_sent', properties: expect.objectContaining({ ticket_id: 'ticket-1' }) }),
    )
  })

  it('sends nothing when the policy cannot mask the reply', async () => {
    vi.mocked(maskChatText).mockRejectedValue(new Error('policy unreadable'))

    await expect(replyToOwnProductFeedback(session, REPORT_ID, 'Seit gestern')).rejects.toMatchObject({ status: 502 })
    expect(replyAsCustomer).not.toHaveBeenCalled()
  })

  it('refuses a reply on a report filed before replies were stored (no session)', async () => {
    vi.mocked(repository.getOwnProductFeedback).mockResolvedValue(answerable({ posthogWidgetSessionId: null }))

    await expect(replyToOwnProductFeedback(session, REPORT_ID, 'Seit gestern')).rejects.toMatchObject({ status: 409 })
    expect(replyAsCustomer).not.toHaveBeenCalled()
  })

  it('turns a PostHog refusal into an upstream error the reporter can retry', async () => {
    vi.mocked(replyAsCustomer).mockRejectedValue(new PosthogSupportUnavailableError('HTTP 500', 500))

    await expect(replyToOwnProductFeedback(session, REPORT_ID, 'Seit gestern')).rejects.toMatchObject({ status: 502 })
  })
})

describe('claimProductFeedbackTicket', () => {
  beforeEach(() => {
    vi.mocked(repository.getProductFeedbackByTicketIds).mockResolvedValue(
      new Map([['ticket-1', stored({ posthogTicketId: 'ticket-1' })]]),
    )
    vi.mocked(findPosthogUserIdByEmail).mockResolvedValue(338908)
    vi.mocked(assignSupportTicket).mockResolvedValue(ticket())
  })

  it('assigns the ticket to the PostHog account with the signed-in email', async () => {
    const view = await claimProductFeedbackTicket(session, 'ticket-1')

    expect(requirePlatformPermission).toHaveBeenCalledWith(session, 'platform:settings:manage')
    expect(findPosthogUserIdByEmail).toHaveBeenCalledWith(config, 'maria@buero.test')
    expect(assignSupportTicket).toHaveBeenCalledWith(config, 'ticket-1', 338908)
    expect(view.id).toBe(REPORT_ID)
  })

  it('refuses before touching PostHog without the manage permission', async () => {
    vi.mocked(requirePlatformPermission).mockRejectedValue(new Error('denied'))

    await expect(claimProductFeedbackTicket(session, 'ticket-1')).rejects.toThrow('denied')
    expect(assignSupportTicket).not.toHaveBeenCalled()
  })

  it('is a 404 for a ticket no report of ours opened', async () => {
    vi.mocked(repository.getProductFeedbackByTicketIds).mockResolvedValue(new Map())

    await expect(claimProductFeedbackTicket(session, 'ticket-x')).rejects.toMatchObject({ status: 404 })
  })

  it('assigns nobody when no PostHog member has the email', async () => {
    vi.mocked(findPosthogUserIdByEmail).mockResolvedValue(null)

    await expect(claimProductFeedbackTicket(session, 'ticket-1')).rejects.toMatchObject({ status: 409 })
    expect(assignSupportTicket).not.toHaveBeenCalled()
  })

  it('turns a PostHog refusal (a key without the members scope) into an upstream error', async () => {
    vi.mocked(findPosthogUserIdByEmail).mockRejectedValue(new PosthogSupportUnavailableError('HTTP 403', 403))

    await expect(claimProductFeedbackTicket(session, 'ticket-1')).rejects.toMatchObject({ status: 502 })
  })
})
