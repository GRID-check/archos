import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CountPill } from './count-pill'

describe('CountPill', () => {
  it('is muted by default — a quiet companion to whatever it counts', () => {
    render(<CountPill>5 Dokumente</CountPill>)
    const pill = screen.getByText('5 Dokumente')
    expect(pill).toHaveAttribute('data-slot', 'count-pill')
    expect(pill).toHaveClass('bg-muted')
    expect(pill).toHaveClass('text-muted-foreground')
    expect(pill).toHaveClass('tabular-nums')
  })

  it('takes the ink treatment when the count is itself the signal', () => {
    render(<CountPill tone="attention">7</CountPill>)
    const pill = screen.getByText('7')
    expect(pill).toHaveClass('bg-primary')
    expect(pill).toHaveClass('text-primary-foreground')
    // Same shape either way — the tone changes colour, never padding.
    expect(pill).toHaveClass('rounded-control')
    expect(pill).toHaveClass('px-2')
  })

  it('lets a caller position it without redefining it', () => {
    render(<CountPill className="absolute -top-1">2</CountPill>)
    expect(screen.getByText('2')).toHaveClass('absolute')
  })
})

describe('CountPill with a count', () => {
  const pill = (count: number, max?: number): HTMLElement => {
    const { container } = render(<CountPill count={count} max={max} />)
    return container.querySelector('[data-slot="count-pill"]') as HTMLElement
  }
  /** What a sighted reader sees: the text outside the screen-reader-only span. */
  const visible = (element: HTMLElement): string =>
    Array.from(element.childNodes)
      .filter((node) => !(node instanceof HTMLElement && node.classList.contains('sr-only')))
      .map((node) => node.textContent)
      .join('')

  it('shows zero as zero — an absent number would read as "unknown"', () => {
    const element = pill(0)
    expect(visible(element)).toBe('0')
    expect(element).not.toHaveAttribute('title')
    expect(element).toHaveAttribute('data-count', '0')
  })

  it('shows 99 whole: the cap is inclusive', () => {
    const element = pill(99)
    expect(visible(element)).toBe('99')
    expect(element.querySelector('.sr-only')).toBeNull()
  })

  it('caps 100 at 99+, and the exact count stays readable to assistive tech and on hover', () => {
    const element = pill(100)
    expect(visible(element)).toBe('99+')
    expect(element.querySelector('[aria-hidden]')).toHaveTextContent('99+')
    expect(element.querySelector('.sr-only')).toHaveTextContent(/^100$/)
    expect(element).toHaveAttribute('title', '100')
  })

  it('caps 12345 at 99+ without widening, and keeps the tabular numerals', () => {
    const element = pill(12345)
    expect(visible(element)).toBe('99+')
    expect(element.querySelector('.sr-only')).toHaveTextContent(/^12345$/)
    expect(element).toHaveAttribute('title', '12345')
    expect(element).toHaveAttribute('data-count', '12345')
    expect(element).toHaveClass('tabular-nums')
  })

  it('takes a different cap where a surface needs one', () => {
    expect(visible(pill(10, 9))).toBe('9+')
    expect(visible(pill(12345, Number.POSITIVE_INFINITY))).toBe('12345')
  })

  it('reads a fraction or a negative as the whole count it stands for', () => {
    expect(visible(pill(3.7))).toBe('3')
    expect(visible(pill(-2))).toBe('0')
  })
})
