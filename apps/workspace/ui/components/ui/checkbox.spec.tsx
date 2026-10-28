import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Checkbox } from './checkbox'

/*
 * A master box over a list is ticked, empty, or half-filled, and the half-filled
 * state is the one it exists for. It used to share the unchecked paint and the
 * tick glyph, so „some" read as „checked, but disabled".
 */
describe('Checkbox', () => {
  it('draws a half-filled box as filled ink with a dash, not a tick', () => {
    render(<Checkbox checked="indeterminate" aria-label="Alle" />)

    const box = screen.getByRole('checkbox', { name: 'Alle' })
    expect(box).toHaveAttribute('data-state', 'indeterminate')
    expect(box).toHaveAttribute('aria-checked', 'mixed')
    expect(box.className).toContain('data-[state=indeterminate]:bg-primary')
    const dash = box.querySelector('[data-slot="checkbox-dash"]')
    const check = box.querySelector('[data-slot="checkbox-check"]')
    expect(dash).not.toBeNull()
    // Which glyph shows is decided by the indicator's own state, in CSS.
    expect(dash?.getAttribute('class')).toContain('group-data-[state=indeterminate]/indicator:block')
    expect(check?.getAttribute('class')).toContain('group-data-[state=indeterminate]/indicator:hidden')
    expect(box.querySelector('[data-slot="checkbox-indicator"]')).toHaveAttribute('data-state', 'indeterminate')
  })

  it('draws a ticked box with the tick, and an empty box with nothing', () => {
    const { rerender } = render(<Checkbox checked aria-label="Eine" />)
    expect(screen.getByRole('checkbox').querySelector('[data-slot="checkbox-indicator"]')).toHaveAttribute(
      'data-state',
      'checked',
    )

    rerender(<Checkbox checked={false} aria-label="Eine" />)
    // The indicator stays mounted and hides on its own state, so the un-tick
    // and the tick are one transition rather than a mount and an unmount.
    const indicator = screen.getByRole('checkbox').querySelector('[data-slot="checkbox-indicator"]')
    expect(indicator).toHaveAttribute('data-state', 'unchecked')
    expect(indicator?.getAttribute('class')).toContain('data-[state=unchecked]:opacity-0')
  })

  it('does not replay an entrance when it mounts already checked', () => {
    // A list of pre-checked boxes used to pop every tick in on load: Radix
    // mounted the indicator only while checked, and the tick was an
    // `animate-in`. A transition has no first frame to play from.
    render(<Checkbox defaultChecked aria-label="Eine" />)
    const indicator = screen.getByRole('checkbox').querySelector('[data-slot="checkbox-indicator"]')
    expect(indicator?.getAttribute('class')).not.toContain('animate-in')
    expect(indicator?.getAttribute('class')).toContain('transition-[opacity,scale]')
  })
})
