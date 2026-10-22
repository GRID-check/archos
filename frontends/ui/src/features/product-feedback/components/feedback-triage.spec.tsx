import { render, screen, waitFor, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type {
  ProductFeedbackListResponse,
  ProductFeedbackReportView,
  SupportTicketStatus,
} from '@/lib/product-feedback/types'
import { FeedbackTriage, type FeedbackTriageClient } from './feedback-triage'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

function ticket(status: SupportTicketStatus, id = 't1', number: number | null = 42) {
  return { id, number, status, url: `https://eu.posthog.com/project/1/support/tickets/${id}` }
}

function counts(overrides: Partial<Record<SupportTicketStatus, number>> = {}) {
  return { new: 0, open: 0, pending: 0, on_hold: 0, resolved: 0, ...overrides }
}

function list(overrides: Partial<ProductFeedbackListResponse> = {}): ProductFeedbackListResponse {
  return {
    source: 'posthog',
    reports: [report()],
    counts: counts({ new: 1 }),
    unticketed: [],
    nextCursor: null,
    ...overrides,
  }
}

function report(overrides: Partial<ProductFeedbackReportView> = {}): ProductFeedbackReportView {
  return {
    id: 'r1',
    kind: 'bug',
    ticket: ticket('new', 'r1'),
    posthogPersonUrl: 'https://eu.posthog.com/project/1/person/u1',
    message: 'The upload stops at 99 percent.',
    pagePath: '/app/projects/p1/files',
    context: { viewport: '1440×900' },
    allowContact: true,
    organizationId: 'org_nord',
    organizationName: 'Büro Nord',
    reporter: { userId: 'u1', name: 'Maria Huber', email: 'maria@buero.test' },
    createdAt: '2026-09-29T08:00:00Z',
    updatedAt: '2026-09-29T08:00:00Z',
    ...overrides,
  }
}

let client: {
  list: ReturnType<typeof vi.fn<FeedbackTriageClient['list']>>
  get: ReturnType<typeof vi.fn<FeedbackTriageClient['get']>>
  triage: ReturnType<typeof vi.fn<FeedbackTriageClient['triage']>>
}

beforeEach(() => {
  client = {
    list: vi.fn<FeedbackTriageClient['list']>().mockResolvedValue(
      list({
        reports: [
          report(),
          report({ id: 'r2', kind: 'idea', message: 'Export plan lists, please.', ticket: ticket('new', 't2', 43) }),
        ],
        counts: counts({ new: 2 }),
      })
    ),
    get: vi.fn<FeedbackTriageClient['get']>().mockResolvedValue(null),
    triage: vi.fn<FeedbackTriageClient['triage']>(),
  }
})

describe('FeedbackTriage', () => {
  test('opens on what nobody has looked at yet', async () => {
    render(<FeedbackTriage canTriage client={client} />)

    expect(await screen.findAllByTestId('feedback-report')).toHaveLength(2)
    expect(client.list).toHaveBeenCalledWith({ status: 'new', kind: undefined })
  })

  test('pins and marks the report an inbox row linked to, without listing it twice', async () => {
    client.get.mockResolvedValue(
      report({ id: 'r2', kind: 'idea', message: 'Export plan lists, please.' })
    )

    render(<FeedbackTriage canTriage client={client} focusReportId="r2" />)

    await waitFor(() => {
      const rows = screen.getAllByTestId('feedback-report')
      expect(rows.map((row) => row.dataset.reportId)).toEqual(['r2', 'r1'])
    })
  })

  test('offers the reply link only to a reporter who agreed to be contacted', async () => {
    client.list.mockResolvedValue(
      list({
        reports: [
          report({
            reporter: { userId: 'u1', name: 'Maria Huber', email: null },
            allowContact: false,
          }),
        ],
      })
    )

    render(<FeedbackTriage canTriage client={client} />)

    const row = await screen.findByTestId('feedback-report')
    expect(within(row).queryByRole('link', { name: /Reply by email/ })).not.toBeInTheDocument()
    expect(within(row).getByText('Does not want to be contacted')).toBeInTheDocument()
  })

  test('shows the status read-only to a reader who may not triage', async () => {
    render(<FeedbackTriage canTriage={false} client={client} />)

    const [row] = await screen.findAllByTestId('feedback-report')
    expect(within(row!).queryByRole('combobox', { name: 'Status' })).not.toBeInTheDocument()
    expect(within(row!).getByText('New')).toBeInTheDocument()
  })

  test('filters by status from the chips', async () => {
    const user = userEvent.setup()
    render(<FeedbackTriage canTriage client={client} />)
    await screen.findAllByTestId('feedback-report')

    await user.click(screen.getByRole('button', { name: /Resolved/ }))

    await waitFor(() =>
      expect(client.list).toHaveBeenLastCalledWith({ status: 'resolved', kind: undefined })
    )
  })

  test('a slow answer for the previous filter does not overwrite the current one', async () => {
    const user = userEvent.setup()
    let resolveSlow: (value: Awaited<ReturnType<FeedbackTriageClient['list']>>) => void = () =>
      undefined
    client.list
      .mockResolvedValueOnce(list({ counts: counts({ new: 1, resolved: 1, on_hold: 1 }) }))
      // "Resolved": slow, answers last.
      .mockReturnValueOnce(new Promise((resolve) => (resolveSlow = resolve)))
      // "On hold": fast, answers first.
      .mockResolvedValueOnce(
        list({
          reports: [report({ id: 'r9', ticket: ticket('on_hold', 't9'), message: 'On hold one.' })],
          counts: counts({ new: 1, resolved: 1, on_hold: 1 }),
        })
      )
    render(<FeedbackTriage canTriage client={client} />)
    await screen.findByText('The upload stops at 99 percent.')

    await user.click(screen.getByRole('button', { name: /Resolved/ }))
    await user.click(screen.getByRole('button', { name: /On hold/ }))
    await screen.findByText('On hold one.')

    resolveSlow(
      list({
        reports: [report({ id: 'r8', ticket: ticket('resolved', 't8'), message: 'Stale resolved one.' })],
        counts: counts({ new: 1, resolved: 1, on_hold: 1 }),
      })
    )
    await waitFor(() => expect(client.list).toHaveBeenCalledTimes(3))
    expect(screen.queryByText('Stale resolved one.')).not.toBeInTheDocument()
    expect(screen.getByText('On hold one.')).toBeInTheDocument()
  })

  test('keeps the previous rows, marked busy, while a filter refetches', async () => {
    const user = userEvent.setup()
    render(<FeedbackTriage canTriage client={client} />)
    await screen.findAllByTestId('feedback-report')

    client.list.mockReturnValueOnce(new Promise(() => undefined))
    await user.click(screen.getByRole('button', { name: /Resolved/ }))

    expect(screen.getAllByTestId('feedback-report')).toHaveLength(2)
    expect(screen.getByTestId('section-refreshing')).toBeInTheDocument()
  })

  test('says so when the linked report cannot be found', async () => {
    client.get.mockRejectedValue(new Error('404'))
    render(<FeedbackTriage canTriage client={client} focusReportId="gone" />)

    expect(await screen.findByTestId('feedback-focus-missing')).toHaveTextContent(
      'The linked report was not found.'
    )
    expect(screen.getAllByTestId('feedback-report')).toHaveLength(2)
  })

  test('keeps the filters on screen when a filter has no reports', async () => {
    client.list.mockResolvedValue(list({ reports: [], counts: counts({ resolved: 3 }) }))
    render(<FeedbackTriage canTriage client={client} />)

    expect(await screen.findByText('No feedback here')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Resolved/ })).toBeInTheDocument()
  })

  test('does not repeat the page subtitle as the card description', async () => {
    render(<FeedbackTriage canTriage client={client} />)
    await screen.findAllByTestId('feedback-report')
    expect(screen.queryByText(/What members report from inside Piloti/)).not.toBeInTheDocument()
  })

  test('names the PostHog statuses and counts each from PostHog', async () => {
    client.list.mockResolvedValue(list({ counts: counts({ new: 1, open: 2, pending: 3, on_hold: 4, resolved: 5 }) }))
    render(<FeedbackTriage canTriage client={client} />)
    await screen.findAllByTestId('feedback-report')

    const chips = within(screen.getByRole('group', { name: 'Filter by status' }))
    expect(chips.getByRole('button', { name: 'All 15' })).toBeInTheDocument()
    expect(chips.getByRole('button', { name: 'Open 2' })).toBeInTheDocument()
    expect(chips.getByRole('button', { name: 'Pending 3' })).toBeInTheDocument()
    expect(chips.getByRole('button', { name: 'On hold 4' })).toBeInTheDocument()
  })

  test('links each report to its PostHog ticket in a new tab', async () => {
    render(<FeedbackTriage canTriage client={client} />)

    const [row] = await screen.findAllByTestId('feedback-report')
    const link = within(row!).getByRole('link', { name: 'Ticket #42 in PostHog' })
    expect(link).toHaveAttribute('href', 'https://eu.posthog.com/project/1/support/tickets/r1')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    expect(within(row!).queryByRole('link', { name: 'Recordings in PostHog' })).not.toBeInTheDocument()
  })

  test('moves the PostHog ticket and recounts the chips', async () => {
    const user = userEvent.setup()
    client.triage.mockResolvedValue(report({ ticket: ticket('open', 'r1') }))
    render(<FeedbackTriage canTriage client={client} />)
    const [row] = await screen.findAllByTestId('feedback-report')

    await user.click(within(row!).getByRole('combobox', { name: 'Status' }))
    await user.click(await screen.findByRole('option', { name: 'Open' }))

    await waitFor(() => expect(client.triage).toHaveBeenCalledWith('r1', 'open'))
    expect(await screen.findByRole('button', { name: 'Open 1' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New 1' })).toBeInTheDocument()
  })

  describe('when PostHog cannot be read (local log)', () => {
    beforeEach(() => {
      client.list.mockResolvedValue(
        list({
          source: 'local',
          counts: null,
          reports: [report({ ticket: null })],
        })
      )
    })

    test('says so, drops the status filter and offers no status control', async () => {
      render(<FeedbackTriage canTriage client={client} />)

      expect(await screen.findByTestId('feedback-local-source')).toHaveTextContent(
        'PostHog Support cannot be read right now.'
      )
      expect(screen.queryByRole('group', { name: 'Filter by status' })).not.toBeInTheDocument()
      const row = screen.getByTestId('feedback-report')
      expect(within(row).queryByRole('combobox', { name: 'Status' })).not.toBeInTheDocument()
    })

    test('links the reporter\'s recordings in PostHog instead of a ticket', async () => {
      render(<FeedbackTriage canTriage client={client} />)

      const row = await screen.findByTestId('feedback-report')
      expect(within(row).getByRole('link', { name: 'Recordings in PostHog' })).toHaveAttribute(
        'href',
        'https://eu.posthog.com/project/1/person/u1'
      )
    })
  })

  test('lists the reports with no ticket apart, without a status control', async () => {
    client.list.mockResolvedValue(
      list({
        unticketed: [report({ id: 'r5', ticket: null, posthogPersonUrl: null, message: 'No ticket for me.' })],
      })
    )
    render(<FeedbackTriage canTriage client={client} />)

    const section = await screen.findByTestId('feedback-unticketed')
    expect(within(section).getByRole('heading', { name: 'Not in PostHog yet' })).toBeInTheDocument()
    expect(within(section).getByText('No ticket for me.')).toBeInTheDocument()
    expect(within(section).queryByRole('combobox')).not.toBeInTheDocument()
    expect(within(section).queryByRole('link', { name: /PostHog/ })).not.toBeInTheDocument()
  })

  test('shows no unticketed section when every report has a ticket', async () => {
    render(<FeedbackTriage canTriage client={client} />)
    await screen.findAllByTestId('feedback-report')
    expect(screen.queryByTestId('feedback-unticketed')).not.toBeInTheDocument()
  })
})

describe('FeedbackTriage → taking a ticket from the Slack alert', () => {
  test('assigns the linked ticket to the reader, pins its report and says so', async () => {
    const { toast } = await import('sonner')
    const claim = vi.fn<NonNullable<FeedbackTriageClient['claim']>>().mockResolvedValue(
      report({ id: 'r9', message: 'Claimed from Slack.', ticket: ticket('open', 't9', 77) })
    )
    render(<FeedbackTriage canTriage claimTicketId="t9" client={{ ...client, claim }} />)

    await waitFor(() => expect(claim).toHaveBeenCalledWith('t9'))
    expect(await screen.findByText('Claimed from Slack.')).toBeInTheDocument()
    expect(toast.success).toHaveBeenCalledWith('Ticket #77 is now assigned to you in PostHog.')
  })

  test('takes nothing for a reader who may only look', async () => {
    const claim = vi.fn<NonNullable<FeedbackTriageClient['claim']>>()
    render(<FeedbackTriage canTriage={false} claimTicketId="t9" client={{ ...client, claim }} />)

    await screen.findAllByText('The upload stops at 99 percent.')
    expect(claim).not.toHaveBeenCalled()
  })
})
