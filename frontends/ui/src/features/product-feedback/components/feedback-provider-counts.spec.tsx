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

import { FeedbackProvider, useFeedbackUpdatedCount, useOpenFeedbackThreads } from './feedback-provider'
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
  return (
    <>
      <span data-testid="count">{count}</span>
      <button type="button" onClick={() => openThreads()}>
        open
      </button>
    </>
  )
}

describe('FeedbackProvider', () => {
  test('reads the count when the shell mounts, and again when the sheet closes', async () => {
    const user = userEvent.setup()
    // One reply waits; once the member has read it (inside the sheet) the server says none.
    const list = vi.fn().mockResolvedValueOnce(empty(1)).mockResolvedValue(empty(0))
    const api: FeedbackThreadsApi = {
      list,
      office: vi.fn(),
      thread: vi.fn(),
      reply: vi.fn(),
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
