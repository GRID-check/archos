/**
 * The usage notice says whose budget it is, when it renews, and what this
 * person can do about it. These cases pin the copy each level composes and the
 * two things that change with the viewer's rights: the link and the amounts.
 */
import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import type { ChatUsageNotice } from '@/lib/budgets/usage-notice'
import { UsageNotice } from './UsageNotice'

const notice = (over: Partial<ChatUsageNotice>): ChatUsageNotice => ({
  level: 'warning',
  scope: 'organization',
  window: 'day',
  unit: 'credit',
  percent: 82,
  amounts: null,
  resetsAt: '2026-10-22T00:00:00.000Z',
  runsOutAt: null,
  canChange: false,
  href: '/app/organization/budgets',
  key: 'organization::day:2026-10-21:warning',
  ...over,
})

describe('UsageNotice', () => {
  test('a warning names the budget and its share, politely', () => {
    render(<UsageNotice notice={notice({})} />)
    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('The office’s daily budget is 82% used')
    expect(status).toHaveTextContent(/It renews at/)
    expect(screen.getByRole('link', { name: 'See usage' })).toHaveAttribute('href', '/app/organization/budgets')
    expect(screen.queryByRole('link', { name: 'Raise the limit' })).toBeNull()
  })

  test('shows amounts only when the notice carries them', () => {
    render(<UsageNotice notice={notice({ scope: 'member', amounts: { used: 41, limit: 50 } })} />)
    expect(screen.getByRole('status')).toHaveTextContent('Your personal daily budget is 82% used')
    expect(screen.getByRole('status')).toHaveTextContent('41 of 50 credits.')
  })

  test('a warning on pace to run out says when', () => {
    render(<UsageNotice notice={notice({ window: 'month', resetsAt: '2026-11-01T00:00:00.000Z', runsOutAt: '2026-10-27T12:00:00.000Z' })} />)
    expect(screen.getByRole('status')).toHaveTextContent(/At this pace it runs out around Oct 27, 2026\./)
  })

  test('a forecast leads with the run-out date', () => {
    render(
      <UsageNotice
        notice={notice({
          level: 'forecast',
          window: 'month',
          percent: 58,
          resetsAt: '2026-11-01T00:00:00.000Z',
          runsOutAt: '2026-10-27T12:00:00.000Z',
        })}
      />
    )
    expect(screen.getByRole('status')).toHaveTextContent('The office’s monthly budget runs out around Oct 27, 2026 at this pace')
    expect(screen.getByRole('status')).toHaveTextContent('58% used so far.')
  })

  test('critical warns that a long research run may stop, and offers the limit to who can raise it', () => {
    render(
      <UsageNotice
        notice={notice({
          level: 'critical',
          scope: 'project',
          window: 'month',
          percent: 96,
          canChange: true,
          href: '/app/projects/p1/settings/usage',
          amounts: { used: 1920, limit: 2000 },
        })}
      />
    )
    expect(screen.getByRole('status')).toHaveTextContent('This project’s monthly budget is almost used up (96%)')
    expect(screen.getByRole('status')).toHaveTextContent('A long research run may stop before it finishes.')
    expect(screen.getByRole('link', { name: 'Raise the limit' })).toHaveAttribute('href', '/app/projects/p1/settings/usage')
    expect(screen.queryByRole('link', { name: 'See usage' })).toBeNull()
  })

  test('exhausted is an alert, says when chat resumes and cannot be dismissed', () => {
    const onDismiss = vi.fn()
    render(<UsageNotice notice={notice({ level: 'exhausted', percent: 100 })} onDismiss={onDismiss} />)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('The office’s daily budget is used up')
    expect(alert).toHaveTextContent(/New messages can’t be sent until it renews at .+\. An admin can raise the limit\./)
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull()
    expect(screen.queryByRole('progressbar')).toBeNull()
  })

  test('a budget admin is not told to ask an admin', () => {
    render(<UsageNotice notice={notice({ level: 'exhausted', percent: 100, canChange: true })} />)
    expect(screen.getByRole('alert')).not.toHaveTextContent('An admin can raise the limit.')
    expect(screen.getByRole('link', { name: 'Raise the limit' })).toBeInTheDocument()
  })

  test('a token organization reads tokens', () => {
    render(<UsageNotice notice={notice({ unit: 'token', amounts: { used: 820_000, limit: 1_000_000 } })} />)
    expect(screen.getByRole('status')).toHaveTextContent('820K of 1M tokens.')
  })

  test('dismissing calls back', async () => {
    const onDismiss = vi.fn()
    render(<UsageNotice notice={notice({})} onDismiss={onDismiss} />)
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onDismiss).toHaveBeenCalledOnce()
  })
})
