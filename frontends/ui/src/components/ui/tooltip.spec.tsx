import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@/test-utils'

import { Toggletip, Tooltip, TooltipContent, TooltipTrigger } from './tooltip'

/** jsdom counts every focus as keyboard focus; the pointer case has to be stated. */
function focusVisible(visible: boolean) {
  const matches = Element.prototype.matches
  vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector: string) {
    return selector === ':focus-visible' ? visible : matches.call(this, selector)
  })
}

function renderTooltip() {
  render(
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button">Hilfe</button>
      </TooltipTrigger>
      <TooltipContent>Erklärung</TooltipContent>
    </Tooltip>
  )
  return screen.getByRole('button', { name: 'Hilfe' })
}

describe('Tooltip', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('stays closed when focus arrives without a keyboard, as when a popover opens on a click', () => {
    focusVisible(false)
    fireEvent.focus(renderTooltip())

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('opens on keyboard focus', () => {
    focusVisible(true)
    fireEvent.focus(renderTooltip())

    expect(screen.getByRole('tooltip')).toHaveTextContent('Erklärung')
  })

  it('still runs the caller’s own focus handler', () => {
    focusVisible(false)
    const onFocus = vi.fn()
    render(
      <Tooltip>
        <TooltipTrigger onFocus={onFocus}>Hilfe</TooltipTrigger>
        <TooltipContent>Erklärung</TooltipContent>
      </Tooltip>
    )
    fireEvent.focus(screen.getByRole('button', { name: 'Hilfe' }))

    expect(onFocus).toHaveBeenCalledOnce()
  })
})

/** A tap: the press, then the click a touch screen sends after it. */
function tap(element: Element, pointerType: 'touch' | 'mouse' = 'touch') {
  fireEvent.pointerDown(element, { pointerType, button: 0, pointerId: 1 })
  fireEvent.pointerUp(element, { pointerType, button: 0, pointerId: 1 })
  fireEvent.click(element)
}

function renderToggletip() {
  render(
    <>
      <Toggletip>
        <TooltipTrigger asChild>
          <button type="button">Was heißt das?</button>
        </TooltipTrigger>
        <TooltipContent>Die Gebäudeklasse richtet sich nach der Höhe.</TooltipContent>
      </Toggletip>
      <p>Anderswo</p>
    </>
  )
  return screen.getByRole('button', { name: 'Was heißt das?' })
}

describe('Tooltip under a finger', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does not open on a tap: a label for a pointer carries nothing a finger needs', () => {
    focusVisible(false)
    tap(renderTooltip())

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })
})

describe('Toggletip', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('opens on a tap, so a phone reaches what it explains', () => {
    focusVisible(false)
    tap(renderToggletip())

    expect(screen.getByRole('tooltip')).toHaveTextContent('Die Gebäudeklasse')
  })

  it('closes on a second tap', () => {
    focusVisible(false)
    const trigger = renderToggletip()
    tap(trigger)
    tap(trigger)

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('closes on a tap anywhere else', async () => {
    focusVisible(false)
    tap(renderToggletip())
    // Radix starts listening for outside presses one task after the layer mounts.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
    tap(screen.getByText('Anderswo'))

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('keeps the tooltip’s mouse behaviour: a click does not pin it open', () => {
    focusVisible(false)
    tap(renderToggletip(), 'mouse')

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })
})
