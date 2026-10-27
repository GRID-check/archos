import { render, screen, waitFor, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import type {
  OwnProductFeedbackListResponse,
  OwnProductFeedbackSummary,
  OwnProductFeedbackThread,
} from '@/lib/product-feedback/types'
import { FeedbackThreadsDialog, type FeedbackThreadsApi } from './feedback-threads'

const REPORT: OwnProductFeedbackSummary = {
  id: '0b1c2d3e-4f50-4617-8899-aabbccddee01',
  kind: 'bug',
  excerpt: 'The upload stops at 99 percent.',
  createdAt: '2026-10-22T08:00:00Z',
  status: 'pending',
  ticketNumber: 41,
  lastActivityAt: '2026-10-22T09:00:00Z',
  hasUpdate: true,
  canReply: true,
  mine: true,
  reporterName: 'Maria Huber',
}

const DONE: OwnProductFeedbackSummary = {
  ...REPORT,
  id: '0b1c2d3e-4f50-4617-8899-aabbccddee03',
  kind: 'praise',
  excerpt: 'The citations save me time every day.',
  status: 'resolved',
  ticketNumber: 21,
  lastActivityAt: '2026-10-10T09:00:00Z',
  hasUpdate: false,
  canReply: false,
}

const COLLEAGUE: OwnProductFeedbackSummary = {
  ...REPORT,
  id: '0b1c2d3e-4f50-4617-8899-aabbccddee11',
  excerpt: 'The title block reads 1:100 as 1:1000.',
  status: 'open',
  ticketNumber: 43,
  hasUpdate: false,
  canReply: false,
  mine: false,
  reporterName: 'Jakob Steiner',
}

/** The report the form files in the specs below. */
const SENT: OwnProductFeedbackSummary = {
  ...REPORT,
  id: '0b1c2d3e-4f50-4617-8899-aabbccddee21',
  kind: 'idea',
  excerpt: 'Please add an export for plan lists.',
  status: 'new',
  ticketNumber: 44,
  hasUpdate: false,
}

const THREAD: OwnProductFeedbackThread = {
  report: { ...REPORT, hasUpdate: false },
  messages: [
    { id: 'm1', author: 'reporter', authorName: null, content: 'The upload stops at 99 percent.', createdAt: '2026-10-22T08:00:00Z' },
    { id: 'm2', author: 'team', authorName: 'Matthias', content: 'Since when does it happen?', createdAt: '2026-10-22T09:00:00Z' },
  ],
  live: true,
}

/** The pane the open thread is in: the list stays beside it, with the same excerpts. */
const detail = () => within(screen.getByTestId('feedback-detail-pane'))

const page = (reports: OwnProductFeedbackSummary[], extra: Partial<OwnProductFeedbackListResponse> = {}): OwnProductFeedbackListResponse => ({
  reports,
  updatedCount: reports.filter((report) => report.hasUpdate).length,
  live: true,
  nextCursor: null,
  canViewOffice: false,
  ...extra,
})

function fakeApi(overrides: Partial<FeedbackThreadsApi> = {}): FeedbackThreadsApi {
  return {
    list: vi.fn(async () => page([DONE, REPORT])),
    office: vi.fn(async () => page([COLLEAGUE, REPORT], { canViewOffice: true })),
    thread: vi.fn(async () => THREAD),
    reply: vi.fn(async (_id: string, message: string) => ({
      ok: true as const,
      thread: {
        ...THREAD,
        messages: [
          ...THREAD.messages,
          { id: 'm3', author: 'reporter' as const, authorName: null, content: message, createdAt: '2026-10-22T09:05:00Z' },
        ],
      },
    })),
    submit: vi.fn(async () => ({
      ok: true as const,
      report: { id: SENT.id, kind: 'idea' as const, createdAt: '2026-10-22T10:00:00Z' },
    })),
    ...overrides,
  }
}

describe('FeedbackThreadsDialog: the cases', () => {
  test('active cases first, done after, each with where it stands, and the count to the shell', async () => {
    const onUpdatedCount = vi.fn()
    render(<FeedbackThreadsDialog open onOpenChange={vi.fn()} api={fakeApi()} onUpdatedCount={onUpdatedCount} />)

    const active = await screen.findByTestId('feedback-group-active')
    const done = screen.getByTestId('feedback-group-done')
    expect(within(active).getByText('The upload stops at 99 percent.')).toBeInTheDocument()
    expect(within(active).getByText('Waiting for you')).toBeInTheDocument()
    expect(within(active).getByText('#41')).toBeInTheDocument()
    expect(within(active).getByText('New')).toBeInTheDocument()
    expect(within(done).getByText('The citations save me time every day.')).toBeInTheDocument()
    expect(within(done).getByText('Resolved')).toBeInTheDocument()
    // Active above done, whatever order the server listed them in.
    expect(active.compareDocumentPosition(done) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(onUpdatedCount).toHaveBeenCalledWith(1)
  })

  test('a plain member sees no office switch', async () => {
    render(<FeedbackThreadsDialog open onOpenChange={vi.fn()} api={fakeApi()} />)
    await screen.findByTestId('feedback-group-active')
    expect(screen.queryByTestId('feedback-scope-office')).not.toBeInTheDocument()
  })

  test("an office admin switches to the office's cases, each with who filed it", async () => {
    const user = userEvent.setup()
    const api = fakeApi({ list: vi.fn(async () => page([REPORT], { canViewOffice: true })) })
    render(<FeedbackThreadsDialog open onOpenChange={vi.fn()} api={api} />)

    await user.click(await screen.findByTestId('feedback-scope-office'))

    expect(await screen.findByText('The title block reads 1:100 as 1:1000.')).toBeInTheDocument()
    expect(screen.getByText('Jakob Steiner')).toBeInTheDocument()
    expect(screen.getByText('Our office’s feedback')).toBeInTheDocument()
    expect(api.office).toHaveBeenCalled()
  })

  test('offers to send feedback when there is none yet, in the modal', async () => {
    const user = userEvent.setup()
    const api = fakeApi({ list: vi.fn(async () => page([])) })
    render(<FeedbackThreadsDialog open onOpenChange={vi.fn()} api={api} />)

    await user.click(await screen.findByRole('button', { name: 'Send feedback' }))
    expect(await screen.findByTestId('feedback-form')).toBeInTheDocument()
  })
})

describe('FeedbackThreadsDialog: one thread', () => {
  test("the reporter's words as theirs, the reply under the team member's name, on two sides", async () => {
    const user = userEvent.setup()
    render(<FeedbackThreadsDialog open onOpenChange={vi.fn()} api={fakeApi()} />)

    await user.click(await screen.findByTestId(`feedback-thread-${REPORT.id}`))

    expect(await screen.findByText('Since when does it happen?')).toBeInTheDocument()
    expect(detail().getByText('Since when does it happen?').closest('[data-shared-author]')).toHaveAttribute(
      'data-shared-author',
      'piloti-team:Matthias',
    )
    expect(detail().getByText('The upload stops at 99 percent.').closest('[data-shared-author]')).toHaveAttribute(
      'data-shared-author',
      'feedback-reporter',
    )
    expect(detail().getByText(/Matthias, Piloti team/)).toBeInTheDocument()
    expect(detail().getByText('Since when does it happen?').closest('[data-side]')).toHaveAttribute('data-side', 'start')
    expect(detail().getByText('The upload stops at 99 percent.').closest('[data-side]')).toHaveAttribute('data-side', 'end')
  })

  test('the team spoke last on an open case: the header says it waits for the reader', async () => {
    const api = fakeApi({ thread: vi.fn(async () => ({ ...THREAD, report: { ...THREAD.report, status: 'new' as const } })) })
    render(<FeedbackThreadsDialog open onOpenChange={vi.fn()} api={api} initialReportId={REPORT.id} />)

    await screen.findByText('Since when does it happen?')
    expect(detail().getByTestId('feedback-case-status')).toHaveAttribute('data-state', 'awaiting')
  })

  test('sends a reply with Enter, shows it, and keeps the field for the next one', async () => {
    const user = userEvent.setup()
    const api = fakeApi()
    render(<FeedbackThreadsDialog open onOpenChange={vi.fn()} api={api} initialReportId={REPORT.id} />)

    const input = await screen.findByTestId('feedback-reply-input')
    expect(input).toHaveAttribute('enterkeyhint', 'send')
    await user.type(input, 'Since yesterday, in Firefox too.{Enter}')

    await waitFor(() => expect(api.reply).toHaveBeenCalledWith(REPORT.id, 'Since yesterday, in Firefox too.'))
    expect(await screen.findByText('Since yesterday, in Firefox too.')).toBeInTheDocument()
    expect(screen.getByTestId('feedback-reply-input')).toHaveValue('')
  })

  test('a press on Send keeps the focus in the field, so a phone keeps its keyboard', async () => {
    const user = userEvent.setup()
    const api = fakeApi()
    render(<FeedbackThreadsDialog open onOpenChange={vi.fn()} api={api} initialReportId={REPORT.id} />)

    const input = await screen.findByTestId('feedback-reply-input')
    await user.click(input)
    await user.type(input, 'Only above 50 MB.')
    await user.click(screen.getByTestId('feedback-reply-input-send'))

    await waitFor(() => expect(api.reply).toHaveBeenCalledWith(REPORT.id, 'Only above 50 MB.'))
    expect(screen.getByTestId('feedback-reply-input')).toHaveFocus()
  })

  test('a reply PostHog does not list yet stays on screen instead of vanishing', async () => {
    const user = userEvent.setup()
    const api = fakeApi({ reply: vi.fn(async () => ({ ok: true as const, thread: THREAD })) })
    render(<FeedbackThreadsDialog open onOpenChange={vi.fn()} api={api} initialReportId={REPORT.id} />)

    await user.type(await screen.findByTestId('feedback-reply-input'), 'Still there?{Enter}')

    expect(await screen.findByText('Still there?')).toBeInTheDocument()
  })

  test('keeps the draft and says so when the reply could not be sent', async () => {
    const user = userEvent.setup()
    const api = fakeApi({ reply: vi.fn(async () => ({ ok: false as const, reason: 'failed' as const })) })
    render(<FeedbackThreadsDialog open onOpenChange={vi.fn()} api={api} initialReportId={REPORT.id} />)

    await user.type(await screen.findByTestId('feedback-reply-input'), 'Still broken{Enter}')

    expect(await screen.findByText('Your reply could not be sent. Please try again.')).toBeInTheDocument()
    expect(screen.getByTestId('feedback-reply-input')).toHaveValue('Still broken')
  })

  test('says when too many replies went out', async () => {
    const user = userEvent.setup()
    const api = fakeApi({ reply: vi.fn(async () => ({ ok: false as const, reason: 'rate-limited' as const })) })
    render(<FeedbackThreadsDialog open onOpenChange={vi.fn()} api={api} initialReportId={REPORT.id} />)

    await user.type(await screen.findByTestId('feedback-reply-input'), 'Again{Enter}')

    expect(await screen.findByText(/a lot of replies in the last hour/)).toBeInTheDocument()
  })

  test('offers no composer on a report that cannot be answered here', async () => {
    const api = fakeApi({ thread: vi.fn(async () => ({ ...THREAD, report: { ...THREAD.report, canReply: false } })) })
    render(<FeedbackThreadsDialog open onOpenChange={vi.fn()} api={api} initialReportId={REPORT.id} />)

    expect(await screen.findByText(/Replies to this report are not possible here/)).toBeInTheDocument()
    expect(screen.queryByTestId('feedback-reply-input')).not.toBeInTheDocument()
  })

  test("a colleague's case reads, names the reporter, and only they can answer", async () => {
    const api = fakeApi({ thread: vi.fn(async () => ({ ...THREAD, report: COLLEAGUE })) })
    render(<FeedbackThreadsDialog open onOpenChange={vi.fn()} api={api} initialReportId={COLLEAGUE.id} />)

    expect(await screen.findByTestId('feedback-thread-readonly')).toHaveTextContent('Only Jakob Steiner can reply to this report.')
    expect(screen.queryByTestId('feedback-reply-input')).not.toBeInTheDocument()
    expect(screen.getAllByText('Jakob Steiner').length).toBeGreaterThan(0)
  })

  test('says the replies cannot be loaded while the ticket is unreadable, and keeps the report', async () => {
    const api = fakeApi({ thread: vi.fn(async () => ({ ...THREAD, messages: THREAD.messages.slice(0, 1), live: false })) })
    render(<FeedbackThreadsDialog open onOpenChange={vi.fn()} api={api} initialReportId={REPORT.id} />)

    expect(await screen.findByText(/cannot be loaded right now/)).toBeInTheDocument()
    expect(detail().getByText('The upload stops at 99 percent.')).toBeInTheDocument()
  })
})

describe('FeedbackThreadsDialog: a modal with two panes', () => {
  test('is a centred dialog, full screen on a phone, not a side sheet', async () => {
    render(<FeedbackThreadsDialog open onOpenChange={vi.fn()} api={fakeApi()} />)

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveAttribute('data-testid', 'feedback-threads')
    expect(dialog).toHaveAttribute('data-mobile-presentation', 'fullscreen')
    expect(dialog).toHaveAccessibleName('My feedback')
  })

  test('the open thread is marked in the list beside it', async () => {
    render(<FeedbackThreadsDialog open onOpenChange={vi.fn()} api={fakeApi()} initialReportId={REPORT.id} />)

    expect(await screen.findByTestId(`feedback-thread-${REPORT.id}`)).toHaveAttribute('aria-current', 'true')
    expect(screen.getByTestId(`feedback-thread-${DONE.id}`)).not.toHaveAttribute('aria-current')
  })

  test('below md one pane shows at a time, and back returns to the list', async () => {
    const user = userEvent.setup()
    render(<FeedbackThreadsDialog open onOpenChange={vi.fn()} api={fakeApi()} />)

    await screen.findByTestId('feedback-group-active')
    expect(screen.getByTestId('feedback-detail-pane').className).toMatch(/max-md:hidden/)
    expect(screen.getByTestId('feedback-list-pane').className).not.toMatch(/max-md:hidden/)

    await user.click(screen.getByTestId(`feedback-thread-${REPORT.id}`))
    await screen.findByText('Since when does it happen?')
    expect(screen.getByTestId('feedback-list-pane').className).toMatch(/max-md:hidden/)

    await user.click(screen.getByTestId('feedback-pane-back'))
    expect(screen.queryByText('Since when does it happen?')).not.toBeInTheDocument()
    expect(screen.getByTestId('feedback-list-pane').className).not.toMatch(/max-md:hidden/)
  })
})

describe('FeedbackThreadsDialog: new feedback in the modal', () => {
  test('„New feedback" opens the form in the modal', async () => {
    const user = userEvent.setup()
    render(<FeedbackThreadsDialog open onOpenChange={vi.fn()} api={fakeApi()} />)

    await user.click(await screen.findByTestId('feedback-new'))

    expect(within(screen.getByTestId('feedback-detail-pane')).getByTestId('feedback-form')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Bug/ })).toHaveAttribute('aria-checked', 'true')
  })

  test('opens straight on the form when asked, with the kind chosen', async () => {
    render(<FeedbackThreadsDialog open onOpenChange={vi.fn()} api={fakeApi()} initialCompose="idea" />)

    expect(await screen.findByTestId('feedback-form')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Idea/ })).toHaveAttribute('aria-checked', 'true')
  })

  test('after sending, the new case is selected in the re-read list with its thread open', async () => {
    const user = userEvent.setup()
    const sentThread: OwnProductFeedbackThread = {
      report: SENT,
      messages: [{ id: 's1', author: 'reporter', authorName: null, content: SENT.excerpt, createdAt: SENT.createdAt }],
      live: true,
    }
    const list = vi.fn().mockResolvedValueOnce(page([DONE, REPORT])).mockResolvedValue(page([SENT, DONE, REPORT]))
    const api = fakeApi({ list, thread: vi.fn(async (id: string) => (id === SENT.id ? sentThread : THREAD)) })
    render(<FeedbackThreadsDialog open onOpenChange={vi.fn()} api={api} initialCompose="idea" />)

    await user.type(await screen.findByTestId('feedback-message'), 'Please add an export for plan lists.')
    await user.click(screen.getByTestId('feedback-send'))

    await waitFor(() => expect(api.submit).toHaveBeenCalledTimes(1))
    expect(await screen.findByTestId('feedback-sent')).toHaveTextContent('Thank you!')
    expect(api.thread).toHaveBeenCalledWith(SENT.id)
    expect(await screen.findByTestId(`feedback-thread-${SENT.id}`)).toHaveAttribute('aria-current', 'true')
    expect(list).toHaveBeenCalledTimes(2)
    expect(screen.queryByTestId('feedback-form')).not.toBeInTheDocument()
  })

  test('does not close while a report is being sent', async () => {
    const user = userEvent.setup()
    let finish: (value: { ok: false; reason: 'failed' }) => void = () => undefined
    const submit = vi.fn(() => new Promise<{ ok: false; reason: 'failed' }>((resolve) => (finish = resolve)))
    const onOpenChange = vi.fn()
    render(<FeedbackThreadsDialog open onOpenChange={onOpenChange} api={fakeApi({ submit })} initialCompose="bug" />)

    await user.type(await screen.findByTestId('feedback-message'), 'The upload stops at 99 percent.')
    await user.click(screen.getByTestId('feedback-send'))
    await user.keyboard('{Escape}')

    expect(onOpenChange).not.toHaveBeenCalled()
    finish({ ok: false, reason: 'failed' })
    expect(await screen.findByRole('alert')).toBeInTheDocument()
  })

  test('a report that cannot be answered offers new feedback in the same modal', async () => {
    const user = userEvent.setup()
    const api = fakeApi({ thread: vi.fn(async () => ({ ...THREAD, report: { ...THREAD.report, canReply: false } })) })
    render(<FeedbackThreadsDialog open onOpenChange={vi.fn()} api={api} initialReportId={REPORT.id} />)

    await screen.findByText(/Replies to this report are not possible here/)
    await user.click(within(screen.getByTestId('feedback-detail-pane')).getByRole('button', { name: 'Send feedback' }))

    expect(await screen.findByTestId('feedback-form')).toBeInTheDocument()
  })
})
