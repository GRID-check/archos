import { render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import type { OwnProductFeedbackSummary, OwnProductFeedbackThread } from '@/lib/product-feedback/types'
import { FeedbackThreadsSheet, type FeedbackThreadsApi } from './feedback-threads'

const REPORT: OwnProductFeedbackSummary = {
  id: '0b1c2d3e-4f50-4617-8899-aabbccddee01',
  kind: 'bug',
  excerpt: 'The upload stops at 99 percent.',
  createdAt: '2026-10-22T08:00:00Z',
  status: 'pending',
  hasUpdate: true,
  canReply: true,
}

const THREAD: OwnProductFeedbackThread = {
  report: { ...REPORT, hasUpdate: false },
  messages: [
    { id: 'm1', author: 'me', authorName: null, content: 'The upload stops at 99 percent.', createdAt: '2026-10-22T08:00:00Z' },
    { id: 'm2', author: 'team', authorName: 'Matthias', content: 'Since when does it happen?', createdAt: '2026-10-22T09:00:00Z' },
  ],
  live: true,
}

function fakeApi(overrides: Partial<FeedbackThreadsApi> = {}): FeedbackThreadsApi {
  return {
    list: vi.fn(async () => ({ reports: [REPORT], updatedCount: 1, live: true, nextCursor: null })),
    thread: vi.fn(async () => THREAD),
    reply: vi.fn(async (_id: string, message: string) => ({
      ok: true as const,
      thread: {
        ...THREAD,
        messages: [
          ...THREAD.messages,
          { id: 'm3', author: 'me' as const, authorName: null, content: message, createdAt: '2026-10-22T09:05:00Z' },
        ],
      },
    })),
    ...overrides,
  }
}

describe('FeedbackThreadsSheet', () => {
  test('lists the reports, marks the one with news, and reports the count to the shell', async () => {
    const onUpdatedCount = vi.fn()
    render(<FeedbackThreadsSheet open onOpenChange={vi.fn()} api={fakeApi()} onUpdatedCount={onUpdatedCount} />)

    expect(await screen.findByText('The upload stops at 99 percent.')).toBeInTheDocument()
    expect(screen.getByText('New')).toBeInTheDocument()
    expect(screen.getByText('Waiting for your answer')).toBeInTheDocument()
    expect(onUpdatedCount).toHaveBeenCalledWith(1)
  })

  test("opens a thread: the reporter's words as theirs, the reply under the team member's name", async () => {
    const user = userEvent.setup()
    render(<FeedbackThreadsSheet open onOpenChange={vi.fn()} api={fakeApi()} />)

    await user.click(await screen.findByTestId(`feedback-thread-${REPORT.id}`))

    expect(await screen.findByText('Since when does it happen?')).toBeInTheDocument()
    expect(
      screen.getByText('Since when does it happen?').closest('[data-shared-author]'),
    ).toHaveAttribute('data-shared-author', 'piloti-team:Matthias')
    expect(
      screen.getByText('The upload stops at 99 percent.').closest('[data-shared-author]'),
    ).toHaveAttribute('data-shared-author', 'feedback-reporter')
    expect(screen.getByText(/Matthias, Piloti team/)).toBeInTheDocument()
    // Two parties, two sides: the team speaks from the start, the reporter from the end.
    expect(screen.getByText('Since when does it happen?').closest('[data-side]')).toHaveAttribute('data-side', 'start')
    expect(screen.getByText('The upload stops at 99 percent.').closest('[data-side]')).toHaveAttribute('data-side', 'end')
  })

  test('sends a reply with Enter and shows it in the thread', async () => {
    const user = userEvent.setup()
    const api = fakeApi()
    render(<FeedbackThreadsSheet open onOpenChange={vi.fn()} api={api} initialReportId={REPORT.id} />)

    await user.type(await screen.findByTestId('feedback-reply-input'), 'Since yesterday, in Firefox too.{Enter}')

    await waitFor(() => expect(api.reply).toHaveBeenCalledWith(REPORT.id, 'Since yesterday, in Firefox too.'))
    expect(await screen.findByText('Since yesterday, in Firefox too.')).toBeInTheDocument()
    expect(screen.getByTestId('feedback-reply-input')).toHaveValue('')
  })

  test('keeps the draft and says so when the reply could not be sent', async () => {
    const user = userEvent.setup()
    const api = fakeApi({ reply: vi.fn(async () => ({ ok: false as const, reason: 'failed' as const })) })
    render(<FeedbackThreadsSheet open onOpenChange={vi.fn()} api={api} initialReportId={REPORT.id} />)

    await user.type(await screen.findByTestId('feedback-reply-input'), 'Still broken{Enter}')

    expect(await screen.findByRole('alert')).toHaveTextContent('Your reply could not be sent')
    expect(screen.getByTestId('feedback-reply-input')).toHaveValue('Still broken')
  })

  test('offers no composer on a report that cannot be answered here', async () => {
    const api = fakeApi({ thread: vi.fn(async () => ({ ...THREAD, report: { ...THREAD.report, canReply: false } })) })
    render(<FeedbackThreadsSheet open onOpenChange={vi.fn()} api={api} initialReportId={REPORT.id} />)

    expect(await screen.findByText(/Replies to this report are not possible here/)).toBeInTheDocument()
    expect(screen.queryByTestId('feedback-reply-input')).not.toBeInTheDocument()
  })

  test('says the replies cannot be loaded while the ticket is unreadable, and keeps the report', async () => {
    const api = fakeApi({ thread: vi.fn(async () => ({ ...THREAD, messages: THREAD.messages.slice(0, 1), live: false })) })
    render(<FeedbackThreadsSheet open onOpenChange={vi.fn()} api={api} initialReportId={REPORT.id} />)

    expect(await screen.findByText(/cannot be loaded right now/)).toBeInTheDocument()
    expect(screen.getByText('The upload stops at 99 percent.')).toBeInTheDocument()
  })

  test('offers to send feedback when there is none yet', async () => {
    const user = userEvent.setup()
    const onNewFeedback = vi.fn()
    const api = fakeApi({ list: vi.fn(async () => ({ reports: [], updatedCount: 0, live: true, nextCursor: null })) })
    render(<FeedbackThreadsSheet open onOpenChange={vi.fn()} api={api} onNewFeedback={onNewFeedback} />)

    await user.click(await screen.findByRole('button', { name: 'Send feedback' }))
    expect(onNewFeedback).toHaveBeenCalledOnce()
  })
})
