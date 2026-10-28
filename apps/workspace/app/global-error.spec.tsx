import { render, screen } from '@/test-utils'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import GlobalError from './global-error'

const capturePosthogException = vi.fn()
vi.mock('@/lib/analytics/posthog', () => ({
  capturePosthogException: (...args: unknown[]) => capturePosthogException(...args),
}))

/**
 * React warns when `<html>` is rendered inside the test container; the real
 * thing owns the document, which is the whole point of this file.
 */
describe('GlobalError', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    document.cookie = 'locale=; expires=Thu, 01 Jan 1970 00:00:00 GMT'
  })

  test('renders the generic error screen and offers retry', () => {
    const retry = vi.fn()
    render(<GlobalError error={new Error('layout crashed')} retry={retry} />)

    expect(screen.getByText(/something went wrong/i)).toBeDefined()
    screen.getByRole('button', { name: /try again/i }).click()
    expect(retry).toHaveBeenCalled()
    expect(screen.getByRole('link', { name: /back to projects/i }).getAttribute('href')).toBe('/app/projects')
  })

  test("speaks the visitor's language from the locale cookie, since no provider exists to ask", () => {
    document.cookie = 'locale=de'
    render(<GlobalError error={new Error('layout crashed')} retry={vi.fn()} />)

    expect(screen.queryByText(/something went wrong/i)).toBeNull()
    expect(screen.getByRole('button', { name: /erneut|nochmal/i })).toBeDefined()
  })

  test('reports a client-side crash to PostHog', () => {
    const crash = new Error('layout crashed')
    render(<GlobalError error={crash} retry={vi.fn()} />)

    expect(capturePosthogException).toHaveBeenCalledWith(crash, { source: 'global-error-boundary' })
  })

  test('does not re-report an error the server already reported (it has a digest)', () => {
    const serverError = Object.assign(new Error('An error occurred in the Server Components render.'), {
      digest: '1234',
    })
    render(<GlobalError error={serverError} retry={vi.fn()} />)

    expect(capturePosthogException).not.toHaveBeenCalled()
  })
})
