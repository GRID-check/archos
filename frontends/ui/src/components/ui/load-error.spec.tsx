/**
 * The shared load-failure block: what failed, a hint, and a retry that is busy
 * without being disabled.
 *
 * Rendered without an I18nProvider, so the copy is the default locale (`en`).
 */
import { act, render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'

import { LoadError } from './load-error'

describe('LoadError', () => {
  test('is an alert that says what failed, in the surface’s words', () => {
    render(<LoadError title="Budgets could not be loaded" description="Try again in a moment." />)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveAttribute('data-slot', 'load-error')
    expect(alert).toHaveTextContent('Budgets could not be loaded')
    expect(alert).toHaveTextContent('Try again in a moment.')
  })

  test('falls back to a generic sentence from the dictionary', () => {
    render(<LoadError />)
    expect(screen.getByRole('alert')).toHaveTextContent('Could not be loaded')
    // No retry handler, no button that does nothing.
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  test('retries on a press', async () => {
    const onRetry = vi.fn()
    render(<LoadError onRetry={onRetry} />)
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  test('busy is not disabled: a running retry keeps focus and swallows a second press', async () => {
    const onRetry = vi.fn()
    render(<LoadError onRetry={onRetry} retrying />)
    const button = screen.getByRole('button', { name: 'Retry' })
    expect(button).not.toBeDisabled()
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).toHaveAttribute('aria-busy', 'true')
    button.focus()
    await userEvent.click(button)
    expect(onRetry).not.toHaveBeenCalled()
    expect(button).toHaveFocus()
  })

  test('stays busy while a returned promise is in flight, and frees itself when it settles', async () => {
    let settle: () => void = () => {}
    const onRetry = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve
        }),
    )
    render(<LoadError onRetry={onRetry} />)
    const button = screen.getByRole('button', { name: 'Retry' })
    await userEvent.click(button)
    expect(button).toHaveAttribute('aria-busy', 'true')
    await userEvent.click(button)
    expect(onRetry).toHaveBeenCalledTimes(1)

    await act(async () => settle())
    expect(button).not.toHaveAttribute('aria-busy')
  })

  test('a failed retry also ends the busy state', async () => {
    let fail: () => void = () => {}
    render(
      <LoadError
        onRetry={() =>
          new Promise<void>((_, reject) => {
            fail = () => reject(new Error('down'))
          })
        }
      />,
    )
    const button = screen.getByRole('button', { name: 'Retry' })
    await userEvent.click(button)
    await act(async () => fail())
    expect(button).not.toHaveAttribute('aria-busy')
  })

  test('carries further actions beside the retry', () => {
    render(<LoadError onRetry={() => {}} actions={<button type="button">Clear filters</button>} />)
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeInTheDocument()
  })
})
