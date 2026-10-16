import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MiddleTruncate } from './middle-truncate'

describe('MiddleTruncate', () => {
  it('lets the head give way first, and the tail only after it, behind a leading ellipsis', () => {
    const name = 'EG-100_Grundriss_Erdgeschoss_Index_C_2026-07-02.pdf'
    render(<MiddleTruncate text={name} tail={22} />)

    const line = screen.getByTitle(name)
    const [, head, tail] = Array.from(line.children)
    expect(head).toHaveClass('text-ellipsis', 'overflow-hidden', 'whitespace-pre', 'min-w-0', 'shrink-[100000]')
    expect(tail).toHaveTextContent('Index_C_2026-07-02.pdf')
    // Never `shrink-0`: a column narrower than the tail sliced it at the
    // cell's edge with no ellipsis. It ellipsizes at its start instead.
    expect(tail).not.toHaveClass('shrink-0')
    expect(tail).toHaveClass('text-ellipsis', 'overflow-hidden', 'min-w-0')
    expect(tail).toHaveAttribute('dir', 'rtl')
    expect(tail.firstElementChild?.tagName).toBe('BDI')
    expect(tail.firstElementChild).toHaveAttribute('dir', 'ltr')
  })

  it('keeps the space at the cut: both halves preserve their white space', () => {
    // A flex item's edge space collapses; the halves are flex items.
    const name = 'Lageplan Baufeld Nord Index C.pdf'
    render(<MiddleTruncate text={name} tail={12} />)

    const [, head, tail] = Array.from(screen.getByTitle(name).children)
    expect(tail.textContent?.startsWith(' ') || head.textContent?.endsWith(' ')).toBe(true)
    expect(head).toHaveClass('whitespace-pre')
    expect(tail).toHaveClass('whitespace-pre')
  })

  it('is read once, whole: the halves are for the eye only', () => {
    const name = 'Wohnanlage-Schlosspark_Grundriss_1OG_Index-C.pdf'
    render(<MiddleTruncate text={name} />)

    const line = screen.getByTitle(name)
    const [whole, ...halves] = Array.from(line.children)
    expect(whole).toHaveClass('sr-only')
    expect(whole).toHaveTextContent(name)
    expect(halves).toHaveLength(2)
    for (const half of halves) expect(half).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByText(name)).toBe(whole)
  })

  it('cuts between words, so the tail after the ellipsis starts on one', () => {
    render(<MiddleTruncate text="Grundriss_1OG_C.pdf" tail={12} />)

    const [, head, tail] = Array.from(screen.getByTitle('Grundriss_1OG_C.pdf').children)
    expect(head).toHaveTextContent('Grundriss')
    expect(tail).toHaveTextContent('_1OG_C.pdf')
  })

  it('renders a short name as one piece', () => {
    render(<MiddleTruncate text="EG.pdf" />)

    expect(screen.getByTitle('EG.pdf').children).toHaveLength(1)
    expect(screen.getByTitle('EG.pdf')).toHaveTextContent('EG.pdf')
  })

  it('cuts a short name that still does not fit at its start, never at a hard edge', () => {
    render(<MiddleTruncate text="Energieausweis.pdf" />)

    const [only] = Array.from(screen.getByTitle('Energieausweis.pdf').children)
    expect(only).toHaveClass('text-ellipsis', 'overflow-hidden', 'min-w-0')
    expect(only).toHaveAttribute('dir', 'rtl')
  })
})
