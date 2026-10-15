import { describe, expect, it } from 'vitest'
import { render, screen } from '@/test-utils'
import { FileName } from './file-name'

const LONG = '2026-06-14_Lageplan_Baufeld_Nord_Rev_C_Freigabe.pdf'

describe('FileName', () => {
  it('keeps the end of a long name on screen: revision and extension', () => {
    const { container } = render(<FileName text={LONG} />)
    const drawn = container.querySelector('[aria-hidden="true"]')!
    expect(drawn).not.toBeNull()
    // The tail is a box of its own that never shrinks; the head ellipsizes.
    expect(drawn.textContent).toBe(LONG)
    expect(drawn.querySelector('.shrink-0')?.textContent).toMatch(/\.pdf$/)
    expect(drawn.querySelector('.truncate')?.textContent).toMatch(/^2026-06-14/)
  })

  it('reads the whole name once to assistive technology, not as two fragments', () => {
    render(<FileName text={LONG} />)
    expect(screen.getAllByText(LONG)).toHaveLength(1)
  })

  it('leaves a short name whole, as one box that is read as it stands', () => {
    const { container } = render(<FileName text="Statik.pdf" />)
    expect(container.querySelector('.truncate')).toBeNull()
    expect(container.querySelector('.sr-only')).toBeNull()
    expect(container.querySelector('[aria-hidden]')).toBeNull()
    expect(screen.getAllByText('Statik.pdf')).toHaveLength(1)
  })
})
