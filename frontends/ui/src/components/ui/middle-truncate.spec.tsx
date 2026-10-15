import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MiddleTruncate } from './middle-truncate'

describe('MiddleTruncate', () => {
  it('lets the head shrink and always keeps the tail whole', () => {
    const name = 'EG-100_Grundriss_Erdgeschoss_Index_C_2026-07-02.pdf'
    render(<MiddleTruncate text={name} tail={22} />)

    const line = screen.getByTitle(name)
    expect(line).toHaveTextContent(name)
    const [head, tail] = Array.from(line.children)
    expect(head).toHaveClass('text-ellipsis', 'overflow-hidden', 'whitespace-pre', 'min-w-0')
    expect(tail).toHaveTextContent('Index_C_2026-07-02.pdf')
    expect(tail).toHaveClass('shrink-0')
  })

  it('keeps the space at the cut: both halves preserve their white space', () => {
    // A flex item's edge space collapses; the halves are flex items.
    const name = 'Lageplan Baufeld Nord Index C.pdf'
    render(<MiddleTruncate text={name} tail={12} />)

    const [head, tail] = Array.from(screen.getByTitle(name).children)
    expect(tail.textContent?.startsWith(' ') || head.textContent?.endsWith(' ')).toBe(true)
    expect(head).toHaveClass('whitespace-pre')
    expect(tail).toHaveClass('whitespace-pre')
  })

  it('renders a short name as one piece', () => {
    render(<MiddleTruncate text="EG.pdf" />)

    expect(screen.getByTitle('EG.pdf').children).toHaveLength(1)
    expect(screen.getByTitle('EG.pdf')).toHaveTextContent('EG.pdf')
  })
})
