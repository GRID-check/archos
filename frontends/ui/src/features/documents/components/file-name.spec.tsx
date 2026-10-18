import { describe, expect, it } from 'vitest'
import { render, screen } from '@/test-utils'
import { FileName } from './file-name'

const LONG = '2026-06-14_Lageplan_Baufeld_Nord_Rev_C_Freigabe.pdf'

describe('FileName', () => {
  it('keeps the end of a long name on screen: revision and extension', () => {
    const { container } = render(<FileName text={LONG} />)
    // The tail is a box of its own that gives way only after the head is
    // gone, and then at its start; the head ellipsizes first.
    const [head, tail] = Array.from(container.querySelectorAll('[aria-hidden="true"]'))
    expect(`${head.textContent}${tail.textContent}`).toBe(LONG)
    expect(tail).toHaveAttribute('data-part', 'tail')
    expect(tail.textContent).toMatch(/\.pdf$/)
    expect(head).toHaveClass('text-ellipsis')
    expect(head.textContent).toMatch(/^2026-06-14/)
  })

  it('reads the whole name once to assistive technology, not as two fragments', () => {
    render(<FileName text={LONG} />)
    expect(screen.getAllByText(LONG)).toHaveLength(1)
  })

  it('leaves a short name whole, as one box that is read as it stands', () => {
    const { container } = render(<FileName text="Statik.pdf" />)
    // Not split: no head. Cut at its start only if even it does not fit.
    expect(container.querySelector('[data-part="head"]')).toBeNull()
    expect(container.querySelector('.sr-only')).toBeNull()
    expect(container.querySelector('[aria-hidden]')).toBeNull()
    expect(screen.getAllByText('Statik.pdf')).toHaveLength(1)
  })

  it('keeps the last segment and the extension, not a fixed sixteen characters', () => {
    const { container } = render(<FileName text="Baustellenfoto_Rohbau.jpg" />)
    // „_Rohbau.jpg": the head keeps room to say WHICH Baustellenfoto it is.
    expect(container.querySelector('[data-part="tail"]')?.textContent).toBe('_Rohbau.jpg')
    expect(container.querySelector('[data-part="head"]')?.textContent).toBe('Baustellenfoto')
  })

  it('keeps a whole drawing number: a hyphen is not a segment', () => {
    const { container } = render(<FileName text="MA37_Bescheid_Grundriss_Regelgeschoss_A-101.pdf" />)
    const tail = container.querySelector('[data-part="tail"]')?.textContent ?? ''
    expect(tail.endsWith('A-101.pdf')).toBe(true)
  })
})
