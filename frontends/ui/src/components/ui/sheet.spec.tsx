/**
 * Where focus lands when a side sheet opens: on its first control for a mouse
 * or a keyboard, on the panel itself under a finger (`overlay-focus.ts`), so
 * the phone drawer does not open with its project pill wearing a focus ring.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

import { Sheet, SheetContent, SheetDescription, SheetTitle } from './sheet'

const pointer = (coarse: boolean) =>
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: coarse && query === '(pointer: coarse)',
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList
  )

function renderSheet(onOpenAutoFocus?: (event: Event) => void) {
  render(
    <Sheet open onOpenChange={() => {}}>
      <SheetContent side="left" closeLabel="Schließen" onOpenAutoFocus={onOpenAutoFocus}>
        <SheetTitle>Navigation</SheetTitle>
        <SheetDescription>Bereiche</SheetDescription>
        <button type="button">Wohnbau Seestadt</button>
      </SheetContent>
    </Sheet>
  )
}

describe('SheetContent focus on open', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('lands on the panel under a finger', () => {
    pointer(true)
    renderSheet()

    expect(screen.getByRole('dialog')).toHaveFocus()
  })

  it('lands on the first control with a mouse or a keyboard', () => {
    pointer(false)
    renderSheet()

    expect(screen.getByRole('button', { name: 'Wohnbau Seestadt' })).toHaveFocus()
  })

  it('leaves the focus to a caller that directs it', () => {
    pointer(true)
    renderSheet((event) => {
      event.preventDefault()
      screen.getByRole('button', { name: 'Schließen' }).focus()
    })

    expect(screen.getByRole('button', { name: 'Schließen' })).toHaveFocus()
  })
})
