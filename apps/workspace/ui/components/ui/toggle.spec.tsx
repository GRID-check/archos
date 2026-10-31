import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Toggle, ToggleSegments } from './toggle'

describe('ToggleSegments', () => {
  // The review's Offen / Erledigt and a mark's kind were two hand-rolled tracks
  // with three radii between them (a pill, 5px, the control's 4px).
  it('is a named group of pressed buttons, each reached by Tab', async () => {
    const onPick = vi.fn()
    render(
      <ToggleSegments aria-label="Filter">
        <Toggle variant="segment" size="xs" pressed onPressedChange={() => onPick('open')}>
          Offen
        </Toggle>
        <Toggle variant="segment" size="xs" pressed={false} onPressedChange={() => onPick('closed')}>
          Erledigt
        </Toggle>
      </ToggleSegments>
    )
    expect(screen.getByRole('group', { name: 'Filter' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Offen' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Erledigt' })).toHaveAttribute('aria-pressed', 'false')
    await userEvent.tab()
    await userEvent.tab()
    expect(screen.getByRole('button', { name: 'Erledigt' })).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    expect(onPick).toHaveBeenCalledWith('closed')
  })

  it('draws the track and its segments on the control radius, the pressed one as a card pill', () => {
    render(
      <ToggleSegments aria-label="Art">
        <Toggle variant="segment" size="xs" pressed>
          Mangel
        </Toggle>
      </ToggleSegments>
    )
    expect(screen.getByRole('group').className).toContain('rounded-control')
    const segment = screen.getByRole('button', { name: 'Mangel' }).className.split(/\s+/)
    expect(segment).toEqual(expect.arrayContaining(['rounded-control', 'h-7', 'data-[state=on]:bg-card']))
    expect(segment.some((name) => name.startsWith('rounded-full') || name.startsWith('rounded-['))).toBe(false)
  })
})
