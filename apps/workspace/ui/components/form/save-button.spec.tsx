import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { SaveButton } from './save-button'

const labels = { busyLabel: 'Saving…', savedLabel: 'Saved' }

describe('SaveButton', () => {
  test('a Save with nothing to save is disabled', () => {
    render(<SaveButton busy={false} saved={false} disabled {...labels}>Save</SaveButton>)
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  test('busy keeps the focus: aria-disabled, never disabled, and the press is swallowed', async () => {
    const onClick = vi.fn()
    render(<SaveButton busy saved={false} disabled onClick={onClick} {...labels}>Save</SaveButton>)
    const button = screen.getByRole('button')
    expect(button).not.toBeDisabled()
    expect(button).toHaveAttribute('aria-disabled', 'true')
    await userEvent.click(button)
    expect(onClick).not.toHaveBeenCalled()
  })

  test('once saved it says so, stays focusable and announces it', () => {
    render(<SaveButton busy={false} saved disabled {...labels}>Save</SaveButton>)
    const button = screen.getByRole('button', { name: 'Saved' })
    expect(button).not.toBeDisabled()
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('status')).toHaveTextContent('Saved')
  })
})
