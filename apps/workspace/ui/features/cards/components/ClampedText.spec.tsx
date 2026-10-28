/**
 * ClampedText: the reader can always reach the whole text without a hover.
 *
 * jsdom has no layout, so the clamp is simulated the way the component reads it:
 * `scrollHeight` against `clientHeight`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { ClampedText } from './ClampedText'

const LONG = 'Laufbreite im Treppenhaus 1,10 m; für GK 4 sind 1,20 m nutzbare Laufbreite gefordert.'

const layout = (scrollHeight: number, clientHeight: number) => {
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(scrollHeight)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(clientHeight)
}

describe('ClampedText', () => {
  afterEach(() => vi.restoreAllMocks())

  it('adds nothing to a text that fits', () => {
    layout(40, 40)
    render(<ClampedText>{LONG}</ClampedText>)

    expect(screen.getByText(LONG)).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('offers "Show more" when the clamp cut the text, and opens it on a tap', async () => {
    layout(60, 40)
    const user = userEvent.setup()
    render(<ClampedText className="card-body">{LONG}</ClampedText>)

    const text = screen.getByText(LONG)
    expect(text).toHaveClass('line-clamp-2')
    const toggle = screen.getByRole('button', { name: 'Show more' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    await user.click(toggle)

    expect(text).not.toHaveClass('line-clamp-2')
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true')
  })

  it('gives its toggle the 44px catchment, and never a hover-only title', () => {
    layout(60, 40)
    render(<ClampedText>{LONG}</ClampedText>)

    expect(screen.getByRole('button', { name: 'Show more' })).toHaveClass('touch-target')
    expect(screen.getByText(LONG)).not.toHaveAttribute('title')
  })
})
