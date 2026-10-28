/**
 * A GlobalId is 22 characters of base64 and the string an architect pastes into
 * a BCF topic. It used to end in an ellipsis whose full text was a `title`, and
 * a phone has no hover.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CopyableValue } from './copyable-value'

const ID = '1kTvXnbbzCWw8lcMd1dR4o'

afterEach(() => vi.unstubAllGlobals())

describe('CopyableValue', () => {
  it('shows the whole value, wrapped, with no title the finger cannot raise', () => {
    render(<CopyableValue value={ID} />)
    const button = screen.getByRole('button')
    expect(button).toHaveTextContent(ID)
    expect(button).not.toHaveAttribute('title')
    expect(button.className).toContain('break-all')
    expect(button.className).not.toMatch(/\btruncate\b/)
  })

  it('copies on a tap and says so', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    render(<CopyableValue value={ID} />)
    fireEvent.click(screen.getByRole('button'))
    expect(writeText).toHaveBeenCalledWith(ID)
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Copied'))
  })

  it('stays quiet when the clipboard is unavailable — the value is on screen in full', () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined })
    render(<CopyableValue value={ID} />)
    expect(() => fireEvent.click(screen.getByRole('button'))).not.toThrow()
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it('grows to the 44 px floor under a finger', () => {
    render(<CopyableValue value={ID} />)
    expect(screen.getByRole('button').className).toContain('pointer-coarse:min-h-11')
  })
})
