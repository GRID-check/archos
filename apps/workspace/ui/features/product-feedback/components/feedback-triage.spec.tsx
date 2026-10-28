import { render, screen, waitFor, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type {
  ProductFeedbackListResponse,
  ProductFeedbackReportView,
  ProductFeedbackTicketView,
  SupportTicketStatus,
} from '@/lib/product-feedback/types'
import { FeedbackTriage, type FeedbackTriageClient } from './feedback-triage'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

function ticket(
  status: SupportTicketStatus,
  id = 't1',
  number: number | null = 42,
  overrides: Partial<ProductFeedbackTicketView> = {}
): ProductFeedbackTicketView {
  return {
    id,
    number,
    status,
    url: `https://eu.posthog.com/project/1/support/tickets/${id}`,
    assignee: null,
    lastActivityAt: '2026-09-29T09:00:00Z',
    awaiting: status === 'resolved' ? null : 'team',
    ...overrides,
  }
}

const ANNA = { type: 'user' as const, name: 'Anna Wallner', email: 'anna@piloti.test', isViewer: false }
const ME = { type: 'user' as const, name: 'Matthias Bigl', email: 'me@piloti.test', isViewer: true }

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
    viewerNotInPosthog: false,
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
  test('opens on the active cases, whoever has them', async () => {
    render(<FeedbackTriage canTriage client={client} />)

    expect(await screen.findAllByTestId('feedback-report')).toHaveLength(2)
    expect(client.list).toHaveBeenCalledWith({ status: 'active', kind: undefined, assignee: undefined })
    expect(screen.getByRole('button', { name: /^Active/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Everyone' })).toHaveAttribute('aria-pressed', 'true')
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
      expect(client.list).toHaveBeenLastCalledWith({ status: 'resolved', kind: undefined, assignee: undefined })
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
    expect(chips.getByRole('button', { name: 'Active 10' })).toBeInTheDocument()
    expect(chips.getByRole('button', { name: 'Open 2' })).toBeInTheDocument()
    expect(chips.getByRole('button', { name: 'Pending 3' })).toBeInTheDocument()
    expect(chips.getByRole('button', { name: 'On hold 4' })).toBeInTheDocument()
  })

  test('links each report to its PostHog ticket in a new tab', async () => {
    render(<FeedbackTriage canTriage client={client} />)

    const [row] = await screen.findAllByTestId('feedback-report')
    const link = within(row!).getByRole('link', { name: 'Open in PostHog' })
    expect(within(row!).getByTestId('feedback-ticket-number')).toHaveTextContent('#42')
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

    test('says so, drops the filters and offers no status control', async () => {
      render(<FeedbackTriage canTriage client={client} />)

      expect(await screen.findByTestId('feedback-local-source')).toHaveTextContent(
        'PostHog Support cannot be read right now.'
      )
      expect(screen.queryByRole('group', { name: 'Filter by status' })).not.toBeInTheDocument()
      expect(screen.queryByRole('group', { name: 'Filter by assignee' })).not.toBeInTheDocument()
      expect(screen.queryByTestId('feedback-case')).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Take it' })).not.toBeInTheDocument()
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

describe('FeedbackTriage → active support cases', () => {
  test('says who has each ticket, whose move it is and when it last moved', async () => {
    client.list.mockResolvedValue(
      list({
        reports: [
          report({ id: 'r1', ticket: ticket('new', 't1', 41) }),
          report({ id: 'r2', ticket: ticket('pending', 't2', 40, { assignee: ANNA, awaiting: 'reporter' }) }),
          report({ id: 'r3', ticket: ticket('open', 't3', 39, { assignee: ME }) }),
        ],
      })
    )
    render(<FeedbackTriage canTriage client={client} />)

    const rows = await screen.findAllByTestId('feedback-report')
    const [unassigned, colleague, mine] = rows.map((row) => within(row))
    expect(unassigned!.getByTestId('feedback-assignee')).toHaveTextContent('Unassigned')
    expect(unassigned!.getByTestId('feedback-awaiting')).toHaveTextContent('We owe an answer')
    expect(colleague!.getByTestId('feedback-assignee')).toHaveTextContent('With Anna Wallner')
    expect(colleague!.getByTestId('feedback-awaiting')).toHaveTextContent('Waiting on the reporter')
    expect(mine!.getByTestId('feedback-assignee')).toHaveTextContent('Assigned to you')
    expect(unassigned!.getByText('Last activity')).toBeInTheDocument()
  })

  test('names an assignee PostHog gives no name for by their email', async () => {
    client.list.mockResolvedValue(
      list({ reports: [report({ ticket: ticket('open', 't1', 41, { assignee: { ...ANNA, name: null } }) })] })
    )
    render(<FeedbackTriage canTriage client={client} />)

    expect(await screen.findByTestId('feedback-assignee')).toHaveTextContent('With anna@piloti.test')
  })

  test('narrows to the reader’s own tickets and to the unassigned ones', async () => {
    const user = userEvent.setup()
    render(<FeedbackTriage canTriage client={client} />)
    await screen.findAllByTestId('feedback-report')

    await user.click(screen.getByRole('button', { name: 'Mine' }))
    await waitFor(() =>
      expect(client.list).toHaveBeenLastCalledWith({ status: 'active', kind: undefined, assignee: 'mine' })
    )
    await user.click(screen.getByRole('button', { name: 'Unassigned' }))
    await waitFor(() =>
      expect(client.list).toHaveBeenLastCalledWith({ status: 'active', kind: undefined, assignee: 'unassigned' })
    )
    await user.click(screen.getByRole('button', { name: /^All/ }))
    await waitFor(() =>
      expect(client.list).toHaveBeenLastCalledWith({ status: undefined, kind: undefined, assignee: 'unassigned' })
    )
  })

  test('offers „Take it" on unassigned and on others’ open tickets, never on the reader’s own or a resolved one', async () => {
    client.list.mockResolvedValue(
      list({
        reports: [
          report({ id: 'r1', ticket: ticket('new', 't1', 41) }),
          report({ id: 'r2', ticket: ticket('pending', 't2', 40, { assignee: ANNA }) }),
          report({ id: 'r3', ticket: ticket('open', 't3', 39, { assignee: ME }) }),
          report({ id: 'r4', ticket: ticket('resolved', 't4', 38) }),
        ],
      })
    )
    const claim = vi.fn<NonNullable<FeedbackTriageClient['claim']>>()
    render(<FeedbackTriage canTriage client={{ ...client, claim }} />)

    const rows = await screen.findAllByTestId('feedback-report')
    const offered = rows.map((row) => within(row).queryByRole('button', { name: 'Take it' }) !== null)
    expect(offered).toEqual([true, true, false, false])
  })

  test('offers „Take it" to nobody who may only look', async () => {
    const claim = vi.fn<NonNullable<FeedbackTriageClient['claim']>>()
    render(<FeedbackTriage canTriage={false} client={{ ...client, claim }} />)

    await screen.findAllByTestId('feedback-report')
    expect(screen.queryByRole('button', { name: 'Take it' })).not.toBeInTheDocument()
  })

  test('takes a row’s ticket and shows it as the reader’s', async () => {
    const { toast } = await import('sonner')
    const user = userEvent.setup()
    const claim = vi
      .fn<NonNullable<FeedbackTriageClient['claim']>>()
      .mockResolvedValue(report({ ticket: ticket('new', 'r1', 42, { assignee: ME }) }))
    render(<FeedbackTriage canTriage client={{ ...client, claim }} />)
    const [row] = await screen.findAllByTestId('feedback-report')

    await user.click(within(row!).getByRole('button', { name: 'Take it' }))

    expect(claim).toHaveBeenCalledWith('r1')
    await waitFor(() => expect(within(row!).getByTestId('feedback-assignee')).toHaveTextContent('Assigned to you'))
    expect(within(row!).queryByRole('button', { name: 'Take it' })).not.toBeInTheDocument()
    expect(toast.success).toHaveBeenCalledWith('Ticket #42 is now assigned to you in PostHog.')
  })

  test('says so when the take fails, and keeps the row as it was', async () => {
    const { toast } = await import('sonner')
    const user = userEvent.setup()
    const claim = vi.fn<NonNullable<FeedbackTriageClient['claim']>>().mockRejectedValue(new Error('502'))
    render(<FeedbackTriage canTriage client={{ ...client, claim }} />)
    const [row] = await screen.findAllByTestId('feedback-report')

    await user.click(within(row!).getByRole('button', { name: 'Take it' }))

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(within(row!).getByTestId('feedback-assignee')).toHaveTextContent('Unassigned')
  })

  test('explains an empty „Mine" when the reader has no PostHog login', async () => {
    client.list.mockResolvedValue(list({ reports: [], viewerNotInPosthog: true }))
    render(<FeedbackTriage canTriage client={client} />)

    expect(await screen.findByTestId('feedback-viewer-not-in-posthog')).toHaveTextContent(
      'Nothing is assigned to you in PostHog.'
    )
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
