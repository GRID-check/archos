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
  listPosthogMembers: vi.fn(),
  lastVisibleMessageAuthor: vi.fn(),
  memberByEmail: (members: Array<{ email: string }>, email: string) =>
    members.find((member) => member.email.toLowerCase() === email.toLowerCase()) ?? null,
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
  listOrganizationProductFeedback: vi.fn(),
  getOrganizationProductFeedback: vi.fn(),
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
  lastVisibleMessageAuthor,
  listCustomerVisibleMessages,
  listFeedbackTickets,
  listFeedbackTicketsOf,
  listPosthogMembers,
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
  listOfficeProductFeedbackThreads,
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

/** An office admin: may manage the organization's settings, so sees the office view. */
const admin: AuthorizedSession = { ...session, permissions: ['org:settings:manage'] }

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
    reporterNotifiedAt: null,
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
    assignee: null,
    lastActivityAt: at.toISOString(),
    messageCount: 1,
    unreadTeamCount: 0,
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
  vi.mocked(listPosthogMembers).mockResolvedValue([])
  vi.mocked(lastVisibleMessageAuthor).mockResolvedValue('customer')
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
      tags: ['piloti-feedback', 'kind:bug', 'origin:app.piloti.at'],
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

    expect(vi.mocked(openFeedbackTicket).mock.calls[0]?.[1].tags).toEqual(['piloti-feedback', 'kind:bug', 'no-contact', 'origin:app.piloti.at'])
  })

  it('tags the deployment the ticket came from by its host, and no origin where none is pinned', async () => {
    vi.mocked(posthogSupportConfigFromEnv).mockReturnValue({ ...config, appOrigin: 'https://app.dev.piloti.at' })
    await submitProductFeedback(session, input)
    expect(vi.mocked(openFeedbackTicket).mock.calls[0]?.[1].tags).toContain('origin:app.dev.piloti.at')

    vi.mocked(posthogSupportConfigFromEnv).mockReturnValue({ ...config, appOrigin: null })
    await submitProductFeedback(session, input)
    expect(vi.mocked(openFeedbackTicket).mock.calls[1]?.[1].tags).toEqual(['piloti-feedback', 'kind:bug'])
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

    expect(listFeedbackTickets).toHaveBeenCalledWith(config, {
      status: 'open',
      kind: 'bug',
      assignee: undefined,
      limit: 2,
      offset: 0,
    })
    expect(list.source).toBe('posthog')
    expect(list.counts).toEqual(counts)
    expect(list.viewerNotInPosthog).toBe(false)
    expect(list.reports).toHaveLength(1)
    expect(list.reports[0]?.ticket).toEqual({
      id: 'ticket-1',
      number: 42,
      status: 'open',
      url: ticket().url,
      assignee: null,
      lastActivityAt: at.toISOString(),
      awaiting: 'team',
    })
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

describe('the active support cases', () => {
  const ANNA = { id: 7, email: 'anna@piloti.test', name: 'Anna Wallner' }
  const MARIA = { id: 9, email: 'Maria@Buero.test', name: 'Maria Huber' }

  function withTicket(...tickets: SupportTicket[]): void {
    vi.mocked(listFeedbackTickets).mockResolvedValue({ tickets, count: tickets.length })
    vi.mocked(repository.getProductFeedbackByTicketIds).mockResolvedValue(
      new Map(tickets.map((t, index) => [t.id, stored({ id: `${REPORT_ID.slice(0, -1)}${index}`, posthogTicketId: t.id })]))
    )
  }

  it('pages by the size asked for, never above the bound', async () => {
    await listProductFeedbackForPlatform(session, { limit: 1 })
    expect(listFeedbackTickets).toHaveBeenLastCalledWith(config, expect.objectContaining({ limit: 1 }))

    await listProductFeedbackForPlatform(session, { limit: 50 })
    expect(listFeedbackTickets).toHaveBeenLastCalledWith(config, expect.objectContaining({ limit: 2 }))
  })

  it('`active` asks PostHog for every status but resolved', async () => {
    await listProductFeedbackForPlatform(session, { status: 'active' })

    expect(listFeedbackTickets).toHaveBeenCalledWith(
      config,
      expect.objectContaining({ status: ['new', 'open', 'pending', 'on_hold'] })
    )
  })

  it('`unassigned` narrows the list and the counts, and leaves the ticketless reports out', async () => {
    vi.mocked(repository.listProductFeedback).mockResolvedValue([stored()])

    const list = await listProductFeedbackForPlatform(session, { assignee: 'unassigned' })

    expect(listFeedbackTickets).toHaveBeenCalledWith(config, expect.objectContaining({ assignee: 'unassigned' }))
    expect(countFeedbackTicketsByStatus).toHaveBeenCalledWith(config, expect.any(Function), { assignee: 'unassigned' })
    expect(repository.listProductFeedback).not.toHaveBeenCalled()
    expect(list.unticketed).toEqual([])
  })

  it('`mine` finds the reader in PostHog by email and lists their tickets', async () => {
    vi.mocked(listPosthogMembers).mockResolvedValue([ANNA, MARIA])

    const list = await listProductFeedbackForPlatform(session, { assignee: 'mine' })

    expect(listFeedbackTickets).toHaveBeenCalledWith(config, expect.objectContaining({ assignee: { userId: 9 } }))
    expect(countFeedbackTicketsByStatus).toHaveBeenCalledWith(config, expect.any(Function), { assignee: { userId: 9 } })
    expect(list.viewerNotInPosthog).toBe(false)
  })

  it('`mine` for a reader nobody in PostHog has is empty and says why, without listing anyone else’s', async () => {
    vi.mocked(listPosthogMembers).mockResolvedValue([ANNA])

    const list = await listProductFeedbackForPlatform(session, { assignee: 'mine' })

    expect(listFeedbackTickets).not.toHaveBeenCalled()
    expect(list).toMatchObject({ source: 'posthog', reports: [], viewerNotInPosthog: true, counts: NO_COUNTS })
  })

  it('`mine` falls back to the local log when the members cannot be read', async () => {
    vi.mocked(listPosthogMembers).mockRejectedValue(new PosthogSupportUnavailableError('HTTP 403', 403))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const list = await listProductFeedbackForPlatform(session, { assignee: 'mine' })

    expect(listFeedbackTickets).not.toHaveBeenCalled()
    expect(list.source).toBe('local')
  })

  it('names each assignee from the PostHog members, and marks the reader’s own', async () => {
    vi.mocked(listPosthogMembers).mockResolvedValue([ANNA, MARIA])
    withTicket(
      ticket({ id: 't-anna', assignee: { type: 'user', id: 7, email: 'anna@piloti.test' } }),
      ticket({ id: 't-mine', assignee: { type: 'user', id: 9, email: 'maria@buero.test' } }),
      ticket({ id: 't-team', assignee: { type: 'role', id: 'r-1', name: 'Support' } })
    )

    const list = await listProductFeedbackForPlatform(session, {})

    expect(list.reports.map((report) => report.ticket?.assignee)).toEqual([
      { type: 'user', name: 'Anna Wallner', email: 'anna@piloti.test', isViewer: false },
      { type: 'user', name: 'Maria Huber', email: 'maria@buero.test', isViewer: true },
      { type: 'role', name: 'Support', email: null, isViewer: false },
    ])
  })

  it('shows an assignee by email while the members cannot be read, and still lists', async () => {
    vi.mocked(listPosthogMembers).mockRejectedValue(new PosthogSupportUnavailableError('HTTP 403', 403))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    withTicket(ticket({ assignee: { type: 'user', id: 7, email: 'anna@piloti.test' } }))

    const list = await listProductFeedbackForPlatform(session, {})

    expect(list.source).toBe('posthog')
    expect(list.reports[0]?.ticket?.assignee).toEqual({
      type: 'user',
      name: null,
      email: 'anna@piloti.test',
      isViewer: false,
    })
  })

  it('says whose move it is from the last message the reporter can see', async () => {
    withTicket(ticket({ id: 't-1' }), ticket({ id: 't-2' }), ticket({ id: 't-3', status: 'resolved' }))
    vi.mocked(lastVisibleMessageAuthor).mockImplementation(async (_config, t) =>
      t.id === 't-1' ? 'customer' : 'team'
    )

    const list = await listProductFeedbackForPlatform(session, {})

    expect(list.reports.map((report) => report.ticket?.awaiting)).toEqual(['team', 'reporter', null])
    // A resolved ticket owes nobody: its thread is not read.
    expect(lastVisibleMessageAuthor).toHaveBeenCalledTimes(2)
  })

  it('leaves whose move it is unknown when a thread cannot be read, and still lists', async () => {
    withTicket(ticket())
    vi.mocked(lastVisibleMessageAuthor).mockRejectedValue(new PosthogSupportUnavailableError('down', 502))

    const list = await listProductFeedbackForPlatform(session, {})

    expect(list.source).toBe('posthog')
    expect(list.reports[0]?.ticket?.awaiting).toBeNull()
  })

  it('a claimed ticket comes back as the reader’s', async () => {
    vi.mocked(listPosthogMembers).mockResolvedValue([MARIA])
    vi.mocked(repository.getProductFeedbackByTicketIds).mockResolvedValue(
      new Map([['ticket-1', stored({ posthogTicketId: 'ticket-1' })]])
    )
    vi.mocked(findPosthogUserIdByEmail).mockResolvedValue(9)
    vi.mocked(assignSupportTicket).mockResolvedValue(
      ticket({ assignee: { type: 'user', id: 9, email: 'maria@buero.test' } })
    )

    const view = await claimProductFeedbackTicket(session, 'ticket-1')

    expect(view.ticket?.assignee).toMatchObject({ name: 'Maria Huber', isViewer: true })
    expect(view.ticket?.awaiting).toBe('team')
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

describe("the office view: every case of the caller's organization", () => {
  const mineRow = stored({ posthogTicketId: 'ticket-1', posthogWidgetSessionId: '0b1c2d3e-4f50-4617-8899-aabbccddeeff' })
  const colleagueRow = stored({
    id: '7b6a2c1e-0000-4000-8000-000000000002',
    userId: 'user_colleague',
    userName: 'Jakob Steiner',
    posthogTicketId: 'ticket-2',
    posthogWidgetSessionId: '0b1c2d3e-4f50-4617-8899-aabbccddee00',
    reporterSeenAt: null,
  })

  beforeEach(() => {
    vi.mocked(repository.listOrganizationProductFeedback).mockResolvedValue([colleagueRow, mineRow])
    vi.mocked(listFeedbackTicketsOf).mockResolvedValue([
      ticket({ id: 'ticket-1', status: 'open' }),
      ticket({ id: 'ticket-2', ticketNumber: 43, status: 'pending', updatedAt: '2026-09-30T08:00:00Z' }),
    ])
  })

  it('is refused (403) to a member who may not manage the organization', async () => {
    await expect(listOfficeProductFeedbackThreads(session)).rejects.toMatchObject({ status: 403 })
    expect(repository.listOrganizationProductFeedback).not.toHaveBeenCalled()
  })

  it("lists the organization's rows with who filed each, in one PostHog call for everybody on the page", async () => {
    const list = await listOfficeProductFeedbackThreads(admin)

    expect(repository.listOrganizationProductFeedback).toHaveBeenCalledWith('org_tenant', { limit: 20, before: undefined })
    expect(listFeedbackTicketsOf).toHaveBeenCalledOnce()
    expect(listFeedbackTicketsOf).toHaveBeenCalledWith(config, ['user_colleague', 'user_reporter'], 100)
    expect(list.canViewOffice).toBe(true)
    expect(list.reports[0]).toEqual(
      expect.objectContaining({
        reporterName: 'Jakob Steiner',
        mine: false,
        status: 'pending',
        ticketNumber: 43,
        // A colleague's news is theirs; a colleague's ticket is not the admin's to answer.
        hasUpdate: false,
        canReply: false,
      })
    )
    expect(list.reports[1]).toEqual(expect.objectContaining({ mine: true, canReply: true }))
  })

  it('still lists the cases while PostHog cannot be read, without statuses', async () => {
    vi.mocked(listFeedbackTicketsOf).mockRejectedValue(new PosthogSupportUnavailableError('down', 503))

    const list = await listOfficeProductFeedbackThreads(admin)

    expect(list.live).toBe(false)
    expect(list.reports.map((report) => report.status)).toEqual([null, null])
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
    expect(listFeedbackTicketsOf).toHaveBeenCalledWith(config, ['user_reporter'], 100)
    expect(list).toEqual({
      reports: [
        expect.objectContaining({
          id: REPORT_ID,
          status: 'pending',
          ticketNumber: 42,
          lastActivityAt: '2026-09-29T10:00:00.000Z',
          hasUpdate: true,
          canReply: true,
          mine: true,
          reporterName: 'Maria Huber',
        }),
      ],
      updatedCount: 1,
      live: true,
      nextCursor: null,
      canViewOffice: false,
    })
  })

  it('tells an office admin the office view is open to them', async () => {
    const list = await listOwnProductFeedbackThreads(admin)
    expect(list.canViewOffice).toBe(true)
  })

  it('a report never looked at counts from when it was sent: a team reply on it is news', async () => {
    vi.mocked(repository.listOwnProductFeedback).mockResolvedValue([answerable({ reporterSeenAt: null })])

    const list = await listOwnProductFeedbackThreads(session)

    expect(list.reports[0]?.hasUpdate).toBe(true)
  })

  it("the ticket's own setup right after sending is not news on a report never looked at", async () => {
    vi.mocked(repository.listOwnProductFeedback).mockResolvedValue([answerable({ reporterSeenAt: null })])
    vi.mocked(listFeedbackTicketsOf).mockResolvedValue([ticket({ updatedAt: '2026-09-29T08:00:00.300Z' })])

    const list = await listOwnProductFeedbackThreads(session)

    expect(list.reports[0]?.hasUpdate).toBe(false)
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
      expect.objectContaining({ author: 'reporter', content: 'Der Upload bleibt bei 99 % stehen.' }),
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
    vi.mocked(repository.getOrganizationProductFeedback).mockResolvedValue(answerable({ userId: 'user_colleague' }))

    await expect(getOwnProductFeedbackThread(session, REPORT_ID)).rejects.toMatchObject({ status: 404 })
    expect(repository.getOrganizationProductFeedback).not.toHaveBeenCalled()
    expect(listCustomerVisibleMessages).not.toHaveBeenCalled()
  })

  it("lets an office admin read a colleague's thread, read-only, without marking it seen", async () => {
    vi.mocked(repository.getOwnProductFeedback).mockResolvedValue(null)
    vi.mocked(repository.getOrganizationProductFeedback).mockResolvedValue(
      answerable({ userId: 'user_colleague', userName: 'Jakob Steiner' })
    )

    const thread = await getOwnProductFeedbackThread(admin, REPORT_ID)

    expect(repository.getOrganizationProductFeedback).toHaveBeenCalledWith('org_tenant', REPORT_ID)
    expect(thread.report).toEqual(
      expect.objectContaining({ mine: false, canReply: false, hasUpdate: false, reporterName: 'Jakob Steiner' })
    )
    expect(thread.messages[0]).toEqual(expect.objectContaining({ author: 'reporter' }))
    expect(repository.markOwnProductFeedbackSeen).not.toHaveBeenCalled()
  })

  it("refuses an office admin's reply on a colleague's report: only the reporter's session answers", async () => {
    vi.mocked(repository.getOwnProductFeedback).mockResolvedValue(null)

    await expect(replyToOwnProductFeedback(admin, REPORT_ID, 'Danke')).rejects.toMatchObject({ status: 404 })
    expect(replyAsCustomer).not.toHaveBeenCalled()
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
