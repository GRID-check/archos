import type { JSX } from 'react'
import { act, render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import type { OwnProductFeedbackListResponse } from '@/lib/product-feedback/types'
vi.mock('next/navigation', () => ({
  usePathname: () => '/app/projects',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn() }),
}))

import { FeedbackProvider, useFeedbackUpdatedCount, useOpenFeedback, useOpenFeedbackThreads } from './feedback-provider'
import type { FeedbackThreadsApi } from './feedback-threads'

const empty = (updatedCount: number): OwnProductFeedbackListResponse => ({
  reports: [],
  updatedCount,
  live: true,
  nextCursor: null,
  canViewOffice: false,
})

function Probe(): JSX.Element {
  const count = useFeedbackUpdatedCount()
  const openThreads = useOpenFeedbackThreads()
  const openFeedback = useOpenFeedback()
  return (
    <>
      <span data-testid="count">{count}</span>
      <button type="button" onClick={() => openThreads()}>
        open
      </button>
      <button type="button" onClick={() => openFeedback('question')}>
        compose
      </button>
    </>
  )
}

describe('FeedbackProvider', () => {
  test('„Feedback senden" opens the same modal, on its form, with the kind asked for', async () => {
    const user = userEvent.setup()
    const api: FeedbackThreadsApi = {
      list: vi.fn(async () => empty(0)),
      office: vi.fn(),
      thread: vi.fn(),
      reply: vi.fn(),
      submit: vi.fn(),
    }
    render(
      <FeedbackProvider threadsApi={api}>
        <Probe />
      </FeedbackProvider>
    )

    await user.click(screen.getByRole('button', { name: 'compose' }))

    expect(await screen.findByTestId('feedback-threads')).toContainElement(screen.getByTestId('feedback-form'))
    expect(screen.getByRole('radio', { name: /Question/ })).toHaveAttribute('aria-checked', 'true')
  })

  test('reads the count when the shell mounts, and again when the modal closes', async () => {
    const user = userEvent.setup()
    // One reply waits; once the member has read it (inside the modal) the server says none.
    const list = vi.fn().mockResolvedValueOnce(empty(1)).mockResolvedValue(empty(0))
    const api: FeedbackThreadsApi = {
      list,
      office: vi.fn(),
      thread: vi.fn(),
      reply: vi.fn(),
      submit: vi.fn(),
    }
    render(
      <FeedbackProvider threadsApi={api}>
        <Probe />
      </FeedbackProvider>
    )

    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('1'))
    await user.click(screen.getByRole('button', { name: 'open' }))
    await screen.findByTestId('feedback-threads')
    const before = list.mock.calls.length

    await act(async () => {
      await user.keyboard('{Escape}')
    })

    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(before))
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('0'))
  })
})
