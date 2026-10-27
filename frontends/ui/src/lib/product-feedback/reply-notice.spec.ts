/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/db/tenant-context', () => ({
  withPlatformAccess: vi.fn(async (_reason: string, fn: () => unknown) => await fn()),
  withTenant: vi.fn(async (_scope: unknown, fn: () => unknown) => await fn()),
}))
vi.mock('@/lib/inbox/service', () => ({ emitInboxItems: vi.fn(async () => 1) }))
vi.mock('@/lib/posthog-support/config', () => ({ posthogSupportConfigFromEnv: vi.fn() }))
vi.mock('@/lib/posthog-support/client', () => ({ listCustomerVisibleMessages: vi.fn() }))
vi.mock('./repository', () => ({
  findProductFeedbackByTicketId: vi.fn(),
  advanceReporterNotifiedAt: vi.fn(),
  rewindReporterNotifiedAt: vi.fn(),
}))

import { UpstreamError } from '@/lib/api/errors'
import type { ProductFeedback } from '@/lib/db/schema'
import { withPlatformAccess, withTenant } from '@/lib/db/tenant-context'
import { INBOX_TYPE_DEFINITIONS } from '@/lib/inbox/registry'
import { emitInboxItems } from '@/lib/inbox/service'
import { listCustomerVisibleMessages } from '@/lib/posthog-support/client'
import { posthogSupportConfigFromEnv } from '@/lib/posthog-support/config'
import {
  PosthogSupportUnavailableError,
  type PosthogSupportConfig,
  type SupportMessage,
} from '@/lib/posthog-support/types'
import * as repository from './repository'
import { notifyFeedbackReplies, unannouncedReplies } from './reply-notice'

const TICKET = '0b1c2d3e-4f50-4617-8899-aabbccddeeff'
const REPORT_ID = '7b6a2c1e-0000-4000-8000-000000000001'

const config: PosthogSupportConfig = {
  appHost: 'https://eu.posthog.com',
  ingestHost: 'https://eu.i.posthog.com',
  projectId: '269895',
  projectToken: 'phc_public',
  personalApiKey: 'phx_test',
  appOrigin: 'https://app.piloti.at',
}

function report(overrides: Partial<ProductFeedback> = {}): ProductFeedback {
  return {
    id: REPORT_ID,
    organizationId: 'org_tenant',
    userId: 'user_reporter',
    userName: 'Maria Huber',
    userEmail: 'maria@buero.test',
    kind: 'bug',
    message: 'Der Upload bleibt bei 99 % stehen.',
    pagePath: '/app/projects',
    context: {},
    allowContact: true,
    posthogTicketId: TICKET,
    posthogWidgetSessionId: null,
    reporterSeenAt: new Date('2026-10-22T08:00:00Z'),
    reporterNotifiedAt: null,
    createdAt: new Date('2026-10-22T08:00:00Z'),
    updatedAt: new Date('2026-10-22T08:00:00Z'),
    ...overrides,
  }
}

const first: SupportMessage = {
  id: 'm-1',
  author: 'customer',
  authorName: null,
  content: `[bug] #${REPORT_ID} /app/projects\nDer Upload bleibt bei 99 % stehen.`,
  createdAt: '2026-10-22T08:00:00.000Z',
}
const teamReply: SupportMessage = {
  id: 'm-2',
  author: 'team',
  authorName: 'Lena Berger',
  content: 'Danke! Das ist behoben, bitte noch einmal versuchen.',
  createdAt: '2026-10-22T09:00:00.000Z',
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(posthogSupportConfigFromEnv).mockReturnValue(config)
  vi.mocked(repository.findProductFeedbackByTicketId).mockResolvedValue(report())
  vi.mocked(repository.advanceReporterNotifiedAt).mockResolvedValue(true)
  vi.mocked(repository.rewindReporterNotifiedAt).mockResolvedValue(undefined)
  vi.mocked(listCustomerVisibleMessages).mockResolvedValue([first, teamReply])
})

describe('notifyFeedbackReplies', () => {
  it('does nothing without Support configured', async () => {
    vi.mocked(posthogSupportConfigFromEnv).mockReturnValue(null)
    expect(await notifyFeedbackReplies(TICKET)).toEqual({ status: 'not-configured' })
    expect(repository.findProductFeedbackByTicketId).not.toHaveBeenCalled()
  })

  it('does nothing for a ticket no report opened, and never asks PostHog', async () => {
    vi.mocked(repository.findProductFeedbackByTicketId).mockResolvedValue(null)
    expect(await notifyFeedbackReplies(TICKET)).toEqual({ status: 'unknown-ticket' })
    expect(listCustomerVisibleMessages).not.toHaveBeenCalled()
    expect(emitInboxItems).not.toHaveBeenCalled()
  })

  it('finds the report under the platform bypass, then works as its organization', async () => {
    await notifyFeedbackReplies(TICKET)
    expect(withPlatformAccess).toHaveBeenCalledTimes(1)
    expect(withTenant).toHaveBeenCalledWith({ organizationId: 'org_tenant' }, expect.any(Function))
    expect(listCustomerVisibleMessages).toHaveBeenCalledWith(config, TICKET)
  })

  it('turns a team reply into one inbox row for the reporter that opens their thread', async () => {
    expect(await notifyFeedbackReplies(TICKET)).toEqual({ status: 'notified', replies: 1 })

    expect(repository.advanceReporterNotifiedAt).toHaveBeenCalledWith(
      'org_tenant',
      REPORT_ID,
      new Date(teamReply.createdAt),
    )
    expect(emitInboxItems).toHaveBeenCalledTimes(1)
    expect(vi.mocked(emitInboxItems).mock.calls[0]?.[0]).toEqual([
      {
        organizationId: 'org_tenant',
        recipientUserId: 'user_reporter',
        type: 'feedback.replied',
        resourceType: 'product_feedback',
        resourceId: REPORT_ID,
        groupKey: `feedback.replied:product_feedback:${REPORT_ID}`,
        occurrences: 1,
        payload: {
          subject: 'Der Upload bleibt bei 99 % stehen.',
          excerpt: teamReply.content,
          related: 'Lena Berger',
          kind: 'bug',
        },
      },
    ])
  })

  it('counts several new replies into the one row and quotes the latest', async () => {
    const later = { ...teamReply, id: 'm-3', content: 'Und noch ein Hinweis.', createdAt: '2026-10-22T10:00:00.000Z' }
    vi.mocked(listCustomerVisibleMessages).mockResolvedValue([first, later, teamReply])

    expect(await notifyFeedbackReplies(TICKET)).toEqual({ status: 'notified', replies: 2 })
    const emission = vi.mocked(emitInboxItems).mock.calls[0]?.[0][0]
    expect(emission?.occurrences).toBe(2)
    expect(emission?.payload?.excerpt).toBe('Und noch ein Hinweis.')
    expect(repository.advanceReporterNotifiedAt).toHaveBeenCalledWith('org_tenant', REPORT_ID, new Date(later.createdAt))
  })

  it('writes nothing on a replay: the reply is behind the watermark', async () => {
    vi.mocked(repository.findProductFeedbackByTicketId).mockResolvedValue(
      report({ reporterNotifiedAt: new Date(teamReply.createdAt) }),
    )
    expect(await notifyFeedbackReplies(TICKET)).toEqual({ status: 'nothing-new' })
    expect(repository.advanceReporterNotifiedAt).not.toHaveBeenCalled()
    expect(emitInboxItems).not.toHaveBeenCalled()
  })

  it('writes nothing when a concurrent poke moved the watermark first', async () => {
    vi.mocked(repository.advanceReporterNotifiedAt).mockResolvedValue(false)
    expect(await notifyFeedbackReplies(TICKET)).toEqual({ status: 'nothing-new' })
    expect(emitInboxItems).not.toHaveBeenCalled()
  })

  it('announces no reply the reporter already read in the thread', async () => {
    vi.mocked(repository.findProductFeedbackByTicketId).mockResolvedValue(
      report({ reporterSeenAt: new Date('2026-10-22T09:30:00Z') }),
    )
    expect(await notifyFeedbackReplies(TICKET)).toEqual({ status: 'nothing-new' })
    expect(emitInboxItems).not.toHaveBeenCalled()
  })

  it('announces nothing for the reporter\'s own message', async () => {
    const own = { ...first, id: 'm-4', content: 'Geht immer noch nicht.', createdAt: '2026-10-22T11:00:00.000Z' }
    vi.mocked(listCustomerVisibleMessages).mockResolvedValue([first, own])
    expect(await notifyFeedbackReplies(TICKET)).toEqual({ status: 'nothing-new' })
    expect(emitInboxItems).not.toHaveBeenCalled()
  })

  it('answers 502 and writes nothing when PostHog cannot be read', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.mocked(listCustomerVisibleMessages).mockRejectedValue(new PosthogSupportUnavailableError('PostHog Support list messages: HTTP 503', 503))
    await expect(notifyFeedbackReplies(TICKET)).rejects.toBeInstanceOf(UpstreamError)
    expect(repository.advanceReporterNotifiedAt).not.toHaveBeenCalled()
    expect(emitInboxItems).not.toHaveBeenCalled()
  })

  it('puts the watermark back when the inbox row could not be written, so the next poke tries again', async () => {
    vi.mocked(emitInboxItems).mockRejectedValueOnce(new Error('db down'))
    await expect(notifyFeedbackReplies(TICKET)).rejects.toThrow('db down')
    expect(repository.rewindReporterNotifiedAt).toHaveBeenCalledWith(
      'org_tenant',
      REPORT_ID,
      new Date(teamReply.createdAt),
      null,
    )
  })
})

describe('the feedback.replied type', () => {
  it('is in-app and push only, never mailed (product decision), and reaches every member', () => {
    expect(INBOX_TYPE_DEFINITIONS['feedback.replied']).toMatchObject({
      email: { send: 'never' },
      push: { category: 'results' },
      gate: 'operational',
      grouping: 'collapse',
    })
  })
})

describe('unannouncedReplies', () => {
  it('counts from the report itself when nothing was seen or announced', () => {
    const early = { ...teamReply, createdAt: '2026-10-22T07:00:00.000Z' }
    const fresh = unannouncedReplies(report({ reporterSeenAt: null }), [early, teamReply])
    expect(fresh.map((m) => m.id)).toEqual(['m-2'])
  })

  it('skips a message whose time PostHog sent unreadable', () => {
    expect(unannouncedReplies(report(), [{ ...teamReply, createdAt: 'not a date' }])).toEqual([])
  })
})
