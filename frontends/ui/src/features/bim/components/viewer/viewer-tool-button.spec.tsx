/**
 * The phone's tool: the name is ON the control, because a finger has no tooltip.
 */

import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Home } from 'lucide-react'
import { ViewerToolButton } from './viewer-tool-button'

describe('ViewerToolButton', () => {
  it('writes the caption under the glyph, and keeps the long name as the accessible name', () => {
    render(<ViewerToolButton label="Ganzes Modell einpassen" caption="Einpassen" icon={Home} />)
    const button = screen.getByRole('button', { name: 'Ganzes Modell einpassen' })
    // Visible text a finger can read — not a `title`, which iOS never shows.
    expect(button).toHaveTextContent('Einpassen')
    expect(button).not.toHaveAttribute('title')
  })

  it('uses the label as the caption when none is given', () => {
    render(<ViewerToolButton label="Schnitt" icon={Home} />)
    expect(screen.getByRole('button', { name: 'Schnitt' })).toHaveTextContent('Schnitt')
  })

  it('reports a toggle through aria-pressed, and an action through nothing at all', () => {
    const { rerender } = render(<ViewerToolButton label="Schnitt" icon={Home} active />)
    expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'true')
    rerender(<ViewerToolButton label="Schnitt" icon={Home} active={false} />)
    expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'false')
    rerender(<ViewerToolButton label="Schnitt" icon={Home} />)
    expect(screen.getByRole('button')).not.toHaveAttribute('aria-pressed')
  })

  it('is at least 56 px tall, past the 44 px floor, and shares its bar equally', () => {
    render(<ViewerToolButton label="Schnitt" icon={Home} />)
    const { className } = screen.getByRole('button')
    expect(className).toMatch(/\bh-14\b/)
    expect(className).toMatch(/\bflex-1\b/)
    expect(className).toMatch(/\bmin-w-0\b/)
  })

  it('does not fire while disabled, and marks a change with a dot that speech skips', () => {
    const onClick = vi.fn()
    const { container } = render(
      <ViewerToolButton label="Mehr" icon={Home} disabled marked onClick={onClick} />
    )
    fireEvent.click(screen.getByRole('button'))
    expect(onClick).not.toHaveBeenCalled()
    expect(container.querySelector('[data-slot="viewer-tool-mark"]')).toHaveAttribute(
      'aria-hidden',
      'true'
    )
  })
})
