import { act, render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BusyButton } from './busy-button'

describe('BusyButton', () => {
  afterEach(() => vi.useRealTimers())

  it('presses like a button while idle', async () => {
    const onClick = vi.fn()
    render(
      <BusyButton busyLabel="Saving …" onClick={onClick}>
        Save
      </BusyButton>
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('swallows a press and keeps focus while busy, never disabled', async () => {
    const onClick = vi.fn()
    render(
      <BusyButton busy busyLabel="Saving …" onClick={onClick}>
        Save
      </BusyButton>
    )
    const button = screen.getByRole('button', { hidden: true })
    button.focus()
    await userEvent.click(button)

    expect(onClick).not.toHaveBeenCalled()
    expect(button).not.toBeDisabled()
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(button).toHaveFocus()
  })

  it('swallows a press while blocked by another request, without the busy look', async () => {
    const onClick = vi.fn()
    render(
      <BusyButton blocked busyLabel="Saving …" onClick={onClick}>
        Save
      </BusyButton>
    )
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onClick).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Save' })).not.toHaveAttribute('aria-busy')
  })

  it('shows the busy label only once the wait is long enough to notice', () => {
    vi.useFakeTimers()
    render(
      <BusyButton busy busyLabel="Saving …">
        Save
      </BusyButton>
    )
    expect(screen.getByRole('button')).toHaveAccessibleName('Save')

    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(screen.getByRole('button')).toHaveAccessibleName('Saving …')
  })
})
