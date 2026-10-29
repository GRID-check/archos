/**
 * How a Dialog presents itself on a phone.
 *
 * Pixels belong to the browser (and the presentation is CSS behind the
 * `phone:` variant, which the test DOM never matches), so these assert the
 * decisions the component makes in JavaScript: which presentation a caller
 * gets, that a caller who lays the dialog out keeps its own layout, and that
 * the grabber's pull really closes the dialog it promises to close.
 */

import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  type DialogMobilePresentation,
} from './dialog'
import { SHEET_DISMISS_DISTANCE_PX } from './sheet-pull'

function renderDialog(
  props: {
    className?: string
    fullScreenOnMobile?: boolean
    mobilePresentation?: DialogMobilePresentation
    showCloseButton?: boolean
  } = {}
) {
  const onOpenChange = vi.fn()
  const Harness = () => {
    const [open, setOpen] = useState(true)
    return (
      <Dialog
        open={open}
        onOpenChange={(next) => {
          onOpenChange(next)
          setOpen(next)
        }}
      >
        <DialogContent closeLabel="Schließen" {...props}>
          <DialogTitle>Ordner umbenennen</DialogTitle>
          <DialogDescription>Der neue Name gilt für alle.</DialogDescription>
          <DialogFooter>
            <button type="button">Abbrechen</button>
            <button type="button">Umbenennen</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }
  render(<Harness />)
  return { onOpenChange, content: () => screen.queryByRole('dialog') }
}

const grabber = () => document.querySelector<HTMLElement>('[data-slot="dialog-grabber"]')

describe('DialogContent on a phone', () => {
  it('is a bottom sheet by default, with a grabber', () => {
    const { content } = renderDialog()
    const dialog = content()!

    expect(dialog).toHaveAttribute('data-mobile-presentation', 'sheet')
    expect(dialog.className).toContain('phone:bottom-0')
    expect(dialog.className).toContain('phone:rounded-surface')
    // The footer pins to the bottom edge, and the sheet clears the home indicator.
    expect(dialog.className).toContain('phone:pb-[max(1.5rem,env(safe-area-inset-bottom))]')
    expect(dialog.className).toContain('phone:[:where(&_[data-slot=dialog-footer])]:sticky')
    expect(grabber()).not.toBeNull()
  })

  it('keeps the desktop card untouched: every phone rule is behind a phone variant', () => {
    const { content } = renderDialog()
    const desktop = content()!
      .className.split(/\s+/)
      .filter((token) => !/^(?:phone|max-sm):/.test(token))

    expect(desktop).toEqual(
      expect.arrayContaining(['top-[50%]', 'left-[50%]', 'translate-y-[-50%]', 'rounded-surface', 'p-6', 'sm:max-w-lg'])
    )
  })

  it('fills the screen for an editor that asks, below the status bar, and draws no grabber', () => {
    const { content } = renderDialog({ fullScreenOnMobile: true })
    const dialog = content()!

    expect(dialog).toHaveAttribute('data-mobile-presentation', 'fullscreen')
    expect(dialog.className).toContain('phone:inset-0')
    expect(dialog.className).toContain('phone:pt-[max(1.5rem,env(safe-area-inset-top))]')
    expect(screen.getByRole('button', { name: 'Schließen' }).className).toContain(
      'phone:top-[calc(env(safe-area-inset-top)+0.625rem)]'
    )
    expect(grabber()).toBeNull()
  })

  it.each(['h-[90dvh] w-[95vw]', 'inset-0 rounded-none p-0', 'top-[30%] translate-y-0'])(
    'leaves a dialog that lays itself out (%s) alone',
    (className) => {
      const { content } = renderDialog({ className })
      const dialog = content()!

      expect(dialog).toHaveAttribute('data-mobile-presentation', 'none')
      expect(dialog.className).not.toMatch(/(?:^|\s)phone:/)
      expect(grabber()).toBeNull()
    }
  )

  it('lets a caller that owns its padding own its bottom edge too', () => {
    const { content } = renderDialog({ className: 'p-0' })
    const dialog = content()!

    // Still a sheet: padding is not geometry…
    expect(dialog).toHaveAttribute('data-mobile-presentation', 'sheet')
    // …but the sheet does not paint a safe-area padding over the caller's `p-0`.
    expect(dialog.className).not.toContain('phone:pb-')
    expect(dialog.className).not.toContain('dialog-footer])]:pb-')
  })

  it('lets a caller that rounds itself keep its corners', () => {
    const { content } = renderDialog({ className: 'max-sm:rounded-none' })

    expect(content()!.className).not.toContain('phone:rounded-surface')
  })

  it('draws no grabber on a dialog that hides its close', () => {
    renderDialog({ showCloseButton: false })

    expect(grabber()).toBeNull()
  })

  it('keeps the close, the grabber and a leading header at the top while a long sheet scrolls', () => {
    const { content } = renderDialog()
    const dialog = content()!
    const chrome = dialog.querySelector<HTMLElement>('[data-slot="dialog-chrome"]')!

    expect(chrome.className).toContain('phone:sticky')
    expect(chrome.className).toContain('phone:-top-6')
    expect(chrome).toContainElement(screen.getByRole('button', { name: 'Schließen' }))
    expect(chrome).toContainElement(grabber())
    // Last, so the close stays last in the tab order and a keyboard lands in the first field.
    expect(dialog.lastElementChild).toBe(chrome)
    // Beside the first child in the first row: a row of its own would cost a gap above the title.
    expect(dialog.className).toContain('phone:[&>:first-child]:row-start-1')
    expect(dialog.className).toContain('phone:[:where(&>[data-slot=dialog-header]:first-child)]:sticky')
  })

  it('pins the full screen top edge against its own, inset padding', () => {
    const { content } = renderDialog({ fullScreenOnMobile: true })
    const chrome = content()!.querySelector<HTMLElement>('[data-slot="dialog-chrome"]')!

    expect(chrome.className).toContain('phone:-top-[max(1.5rem,env(safe-area-inset-top))]')
  })

  it.each(['p-0', 'p-4', 'flex flex-col'])(
    'leaves the top edge to a caller that pads or lays out the content itself (%s)',
    (className) => {
      const { content } = renderDialog({ className })
      const dialog = content()!
      const chrome = dialog.querySelector<HTMLElement>('[data-slot="dialog-chrome"]')!

      expect(chrome.className).not.toContain('phone:sticky')
      expect(chrome.className).toContain('absolute')
      expect(dialog.className).not.toContain('dialog-header]:first-child)]:sticky')
    }
  )

  it('sits the pinned buttons on the home indicator, not a padding above it', () => {
    const { content } = renderDialog()

    expect(content()!.className).toContain('phone:[:where(&_[data-slot=dialog-footer])]:pb-[max(1rem,env(safe-area-inset-bottom))]')
  })

  it('stacks the footer in DOM order, so the primary action is last: nearest the thumb', () => {
    renderDialog()
    const footer = document.querySelector('[data-slot="dialog-footer"]')!

    expect(footer.className).toMatch(/(?:^|\s)flex-col(?:\s|$)/)
    expect(footer.className).not.toContain('flex-col-reverse')
    expect(footer.lastElementChild).toHaveTextContent('Umbenennen')
  })
})

describe('focus on open', () => {
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

  function renderWithField() {
    render(
      <Dialog open onOpenChange={() => {}}>
        <DialogContent closeLabel="Schließen">
          <DialogTitle>Ordner umbenennen</DialogTitle>
          <DialogDescription>Der neue Name gilt für alle.</DialogDescription>
          <input aria-label="Name" />
        </DialogContent>
      </Dialog>
    )
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('lands on the dialog, not its field, under a finger: no keyboard over the sheet', () => {
    pointer(true)
    renderWithField()

    expect(screen.getByRole('dialog')).toHaveFocus()
  })

  it('lands in the first field with a mouse or a keyboard, as before', () => {
    pointer(false)
    renderWithField()

    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveFocus()
  })
})

describe('the grabber pulls', () => {
  const pull = (distance: number) => {
    const handle = grabber()!
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientY: 10 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 10 + distance / 2 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 10 + distance })
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 10 + distance })
  }

  it('closes the dialog when pulled past the commit distance', () => {
    const { onOpenChange } = renderDialog()

    act(() => pull(SHEET_DISMISS_DISTANCE_PX + 30))

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('follows the finger while pulling and refuses to go up', () => {
    const { content } = renderDialog()
    const handle = grabber()!

    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientY: 100 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 140 })
    expect(content()!.style.transform).toBe('translateY(40px)')

    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 60 })
    expect(content()!.style.transform).toBe('translateY(0px)')
  })

  it('stays open when the pull falls short', () => {
    const { onOpenChange, content } = renderDialog()

    // The finger comes to rest before it lifts, so no flick commits it either.
    const handle = grabber()!
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientY: 10 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 40 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 40 })
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 40 })

    expect(onOpenChange).not.toHaveBeenCalled()
    expect(content()).toBeInTheDocument()
  })
})

/*
 * An overlay summoned from the keyboard many times a day (the ⌘K palette, the
 * `?` cheatsheet) opens and closes with no motion: an entrance there is
 * latency between the keystroke and what the reader asked for.
 */
describe('an instant dialog', () => {
  function renderInstant(instant: boolean) {
    render(
      <Dialog open>
        <DialogContent instant={instant}>
          <DialogTitle>Befehle</DialogTitle>
          <DialogDescription>Suchen und springen</DialogDescription>
        </DialogContent>
      </Dialog>
    )
    const content = screen.getByRole('dialog')
    const overlay = document.querySelector('[data-slot="dialog-overlay"]')
    return { content, overlay }
  }

  it('draws neither the panel nor the scrim with an entrance or exit', () => {
    const { content, overlay } = renderInstant(true)
    for (const element of [content, overlay]) {
      expect(element).toHaveAttribute('data-instant', 'true')
      expect(element?.getAttribute('class')).not.toMatch(/animate-(in|out)|zoom-|slide-in|fade-in/)
    }
  })

  it('leaves an ordinary dialog its entrance', () => {
    const { content, overlay } = renderInstant(false)
    expect(content.className).toContain('data-[state=open]:animate-in')
    expect(content.className).toContain('phone:data-[state=open]:slide-in-from-bottom')
    expect(overlay?.getAttribute('class')).toContain('data-[state=open]:fade-in-0')
  })
})
