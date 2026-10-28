import type { ReactNode } from 'react'
import { render, screen } from '@/test-utils'
import { vi, describe, test, expect, beforeEach } from 'vitest'
import RouteError from './error'

const capturePosthogException = vi.fn()
vi.mock('@/lib/analytics/posthog', () => ({
  capturePosthogException: (...args: unknown[]) => capturePosthogException(...args),
}))

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

describe('RouteError', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  test('a genuine authz denial (requireProjectAccess\'s NotFoundError) shows the access screen without a retry button', () => {
    const reset = vi.fn()
    render(<RouteError error={new Error('Not found')} reset={reset} />)

    expect(screen.getByText(/don.t have access to this/i)).toBeDefined()
    // Always-offered retry per the fix, even on the access screen.
    expect(screen.getByRole('button', { name: /try again/i })).toBeDefined()
    // The escape action must not point back at the page that just failed.
    const homeLink = screen.getByRole('link', { name: /go home/i })
    expect(homeLink.getAttribute('href')).toBe('/')
  })

  test('a non-authz error whose message merely contains "access" shows the generic retry screen, not access-denied', () => {
    const reset = vi.fn()
    render(<RouteError error={new Error("Cannot access 'x' before initialization")} reset={reset} />)

    expect(screen.getByText(/something went wrong/i)).toBeDefined()
    expect(screen.queryByText(/don.t have access to this/i)).toBeNull()
    expect(screen.getByRole('button', { name: /try again/i })).toBeDefined()
  })

  test('retry is always offered on the generic error screen and invokes reset', () => {
    const reset = vi.fn()
    render(<RouteError error={new Error('boom')} reset={reset} />)

    screen.getByRole('button', { name: /try again/i }).click()
    expect(reset).toHaveBeenCalled()
  })

  test('an unknown/unclassified error fails safe to the generic screen', () => {
    const reset = vi.fn()
    render(<RouteError error={new Error('database connection reset')} reset={reset} />)

    expect(screen.getByText(/something went wrong/i)).toBeDefined()
    expect(screen.getByRole('button', { name: /try again/i })).toBeDefined()
    expect(screen.getByRole('link', { name: /back to projects/i })).toBeDefined()
  })

  describe('error tracking', () => {
    test('a client-side crash is reported to PostHog, with where it was caught', () => {
      const crash = new Error('boom')
      render(<RouteError error={crash} reset={vi.fn()} />)

      expect(capturePosthogException).toHaveBeenCalledWith(crash, { source: 'route-error-boundary' })
    })

    test('an authz denial is an outcome, not an exception', () => {
      render(<RouteError error={new Error('Not found')} reset={vi.fn()} />)

      expect(capturePosthogException).not.toHaveBeenCalled()
    })

    test('a server-thrown error (it has a digest) was reported by onRequestError and is not reported twice', () => {
      const serverError = Object.assign(new Error('An error occurred in the Server Components render.'), {
        digest: '1234',
      })
      render(<RouteError error={serverError} reset={vi.fn()} />)

      expect(capturePosthogException).not.toHaveBeenCalled()
    })
  })
})
