import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Chip, ChipCount, ChipLabel } from './chip'

describe('Chip', () => {
  it('renders children and the muted default variant', () => {
    render(<Chip>Piloti noted</Chip>)
    const chip = screen.getByText('Piloti noted')
    expect(chip).toBeInTheDocument()
    expect(chip).toHaveClass('bg-muted')
  })

  it('applies the requested variant and interactive affordances', () => {
    render(
      <Chip variant="info" interactive>
        Interactive
      </Chip>
    )
    const chip = screen.getByText('Interactive')
    expect(chip).toHaveClass('bg-info-subtle')
    expect(chip).toHaveClass('cursor-pointer')
  })

  it('renders as its child element when asChild is set (composable trigger)', () => {
    render(
      <Chip asChild interactive>
        <button type="button">Open</button>
      </Chip>
    )
    const button = screen.getByRole('button', { name: 'Open' })
    expect(button).toBeInTheDocument()
    expect(button).toHaveClass('cursor-pointer')
  })

  it('ChipCount renders the count', () => {
    render(<ChipCount>3</ChipCount>)
    expect(screen.getByText('3')).toBeInTheDocument()
  })

  it('never outgrows its row, and truncates a long label while the count stays whole', () => {
    render(
      <Chip title="Brandabschnittsbildung zwischen Tiefgarage und Stiegenhaus">
        <ChipLabel>Brandabschnittsbildung zwischen Tiefgarage und Stiegenhaus</ChipLabel>
        <ChipCount>3</ChipCount>
      </Chip>
    )
    const label = screen.getByText('Brandabschnittsbildung zwischen Tiefgarage und Stiegenhaus')
    expect(label).toHaveClass('truncate', 'min-w-0')
    expect(label.parentElement).toHaveClass('max-w-full')
  })
})
