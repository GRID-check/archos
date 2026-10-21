/**
 * The container: what reaches the composer and when it is re-read. Spend lands
 * after a turn, so the notice must be read again then; a dismissal holds for
 * its key and no further; a spent budget is never hidden.
 */
import { act, render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { ChatUsageNotice as Notice } from '@/lib/budgets/usage-notice'

const capturePosthog = vi.fn()
vi.mock('@/lib/analytics/posthog', () => ({ capturePosthog: (...args: unknown[]) => capturePosthog(...args) }))

import { useChatStore } from '../store'
import { AFTER_TURN_REFRESH_MS } from '../hooks/use-usage-notice'
import { ChatUsageNotice } from './ChatUsageNotice'

const notice = (over: Partial<Notice> = {}): Notice => ({
  level: 'warning',
  scope: 'organization',
  window: 'day',
  unit: 'credit',
  percent: 82,
  amounts: null,
  resetsAt: '2099-01-01T00:00:00.000Z',
  runsOutAt: null,
  canChange: false,
  href: '/app/organization/budgets',
  key: 'organization::day:2098-12-31:warning',
  ...over,
})

const fetchMock = vi.fn()
const answer = (value: Notice | null) =>
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ notice: value }), { status: 200 }))

beforeEach(() => {
  window.localStorage.clear()
  fetchMock.mockReset()
  capturePosthog.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  useChatStore.setState({ projectId: null, isStreaming: false })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('ChatUsageNotice', () => {
  test('reads nothing for a signed-out visitor', () => {
    render(<ChatUsageNotice />)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('shows the notice for the open project, and reports the sighting once', async () => {
    useChatStore.setState({ projectId: 'proj-1' })
    answer(notice())
    render(<ChatUsageNotice isAuthenticated />)
    expect(await screen.findByTestId('usage-notice')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith('/api/organization/usage/notice?projectId=proj-1', expect.anything())
    expect(capturePosthog).toHaveBeenCalledWith('usage_notice_shown', {
      level: 'warning',
      scope: 'organization',
      window: 'day',
      unit: 'credit',
      can_change: false,
    })
  })

  test('re-reads a moment after a turn ends, when its spend has landed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    answer(null)
    render(<ChatUsageNotice isAuthenticated />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    act(() => useChatStore.setState({ isStreaming: true }))
    answer(notice({ level: 'critical', percent: 96, key: 'k-critical' }))
    act(() => useChatStore.setState({ isStreaming: false }))
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(AFTER_TURN_REFRESH_MS)
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(await screen.findByTestId('usage-notice')).toHaveAttribute('data-level', 'critical')
  })

  test('a dismissal holds for its key, across a remount, and not for the next level', async () => {
    answer(notice())
    const first = render(<ChatUsageNotice isAuthenticated />)
    await userEvent.click(await screen.findByRole('button', { name: 'Dismiss' }))
    // It folds away, then is gone.
    await waitFor(() => expect(screen.queryByTestId('usage-notice')).toBeNull())
    expect(capturePosthog).toHaveBeenCalledWith('usage_notice_dismissed', { level: 'warning', scope: 'organization', window: 'day' })
    first.unmount()

    answer(notice())
    const second = render(<ChatUsageNotice isAuthenticated />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(screen.queryByTestId('usage-notice')).toBeNull()
    second.unmount()

    answer(notice({ level: 'critical', percent: 96, key: 'organization::day:2098-12-31:critical' }))
    render(<ChatUsageNotice isAuthenticated />)
    expect(await screen.findByTestId('usage-notice')).toHaveAttribute('data-level', 'critical')
  })

  test('a spent budget shows even when its key was dismissed', async () => {
    window.localStorage.setItem('piloti.usage-notice.dismissed', JSON.stringify(['spent']))
    answer(notice({ level: 'exhausted', percent: 100, key: 'spent' }))
    render(<ChatUsageNotice isAuthenticated />)
    expect(await screen.findByRole('alert')).toBeInTheDocument()
  })

  test('re-reads once the named window renews, however far out that is', async () => {
    // A spent day with 20 h left: further than one timer step (6 h). The read
    // waits for renewal, and a step in between must not end the countdown.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date('2026-10-21T04:00:00Z'))
    fetchMock.mockImplementation(async () =>
      new Response(
        JSON.stringify({ notice: notice({ level: 'exhausted', percent: 100, resetsAt: '2026-10-22T00:00:00.000Z' }) }),
        { status: 200 }
      )
    )
    render(<ChatUsageNotice isAuthenticated />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(12 * 60 * 60_000)
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8 * 60 * 60_000 + 5_000)
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test('drops the old project’s notice at once on a switch', async () => {
    useChatStore.setState({ projectId: 'proj-1' })
    answer(notice({ scope: 'project' }))
    render(<ChatUsageNotice isAuthenticated />)
    await screen.findByTestId('usage-notice')

    fetchMock.mockReturnValueOnce(new Promise(() => {}))
    act(() => useChatStore.setState({ projectId: 'proj-2' }))
    expect(screen.queryByTestId('usage-notice')).toBeNull()
    expect(fetchMock).toHaveBeenLastCalledWith('/api/organization/usage/notice?projectId=proj-2', expect.anything())
  })
})
