/**
 * The phone sheet: two sizes, a handle that owns its gesture, and a body that
 * the browser keeps scrolling.
 */

import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { SHEET_SWIPE_PX, ViewerSheet, sheetGesture, type ViewerSheetSnap } from './viewer-sheet'

function renderSheet(
  snap: ViewerSheetSnap,
  handlers: { onSnapChange?: (s: ViewerSheetSnap) => void; onClose?: () => void } = {}
) {
  const onSnapChange = handlers.onSnapChange ?? vi.fn()
  const onClose = handlers.onClose ?? vi.fn()
  render(
    <ViewerSheet
      title="AW 38"
      subtitle="Wand · Erdgeschoss"
      closeLabel="Schließen"
      onClose={onClose}
      collapse={{
        snap,
        onSnapChange,
        expandLabel: 'Details einblenden',
        collapseLabel: 'Details ausblenden',
      }}
      footer={<button type="button">Isolieren</button>}
    >
      <p>Qto_WallBaseQuantities</p>
    </ViewerSheet>
  )
  return { onSnapChange, onClose }
}

describe('sheetGesture', () => {
  it.each([
    [0, 'peek', 'toggle'],
    [SHEET_SWIPE_PX - 1, 'full', 'toggle'],
    [-SHEET_SWIPE_PX, 'peek', 'expand'],
    // Nowhere to go up to from full.
    [-120, 'full', 'none'],
    [SHEET_SWIPE_PX, 'full', 'collapse'],
    // Swiping the smallest size down is the dismissal.
    [SHEET_SWIPE_PX, 'peek', 'dismiss'],
    [90, 'peek', 'dismiss'],
  ] as const)('travel %s from %s -> %s', (travel, snap, expected) => {
    expect(sheetGesture(travel, snap)).toBe(expected)
  })

  it('a plain list sheet (no sizes) only ever dismisses, and a tap does nothing', () => {
    expect(sheetGesture(2, undefined)).toBe('none')
    expect(sheetGesture(60, undefined)).toBe('dismiss')
    expect(sheetGesture(-60, undefined)).toBe('none')
  })
})

describe('ViewerSheet', () => {
  it('shows the header and the actions in a peek, and keeps the body hidden but mounted', () => {
    renderSheet('peek')
    expect(screen.getByRole('complementary', { name: 'AW 38' })).toHaveAttribute(
      'data-snap',
      'peek'
    )
    expect(screen.getByRole('button', { name: 'Isolieren' })).toBeVisible()
    // Mounted (scroll offset and open <details> survive), not visible.
    expect(screen.getByText('Qto_WallBaseQuantities')).not.toBeVisible()
    expect(screen.getByRole('button', { name: 'Details einblenden' })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
  })

  it('shows the body when full', () => {
    renderSheet('full')
    expect(screen.getByText('Qto_WallBaseQuantities')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Details ausblenden' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
  })

  it('a tap on the handle toggles between the two sizes', () => {
    const { onSnapChange } = renderSheet('peek')
    fireEvent.click(screen.getByRole('button', { name: 'Details einblenden' }))
    expect(onSnapChange).toHaveBeenCalledWith('full')
  })

  it('a swipe up expands, and does not also fire the tap that follows it', () => {
    const { onSnapChange } = renderSheet('peek')
    const handle = screen.getByRole('button', { name: 'Details einblenden' })
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 600 })
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 600 - SHEET_SWIPE_PX - 8 })
    fireEvent.click(handle)
    expect(onSnapChange).toHaveBeenCalledTimes(1)
    expect(onSnapChange).toHaveBeenCalledWith('full')
  })

  it('a swipe down from the peek dismisses the sheet', () => {
    const { onClose } = renderSheet('peek')
    const handle = screen.getByRole('button', { name: 'Details einblenden' })
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 600 })
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 600 + 80 })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('a cancelled gesture (the browser took the pointer) does nothing', () => {
    const { onClose, onSnapChange } = renderSheet('peek')
    const handle = screen.getByRole('button', { name: 'Details einblenden' })
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 600 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 700 })
    fireEvent.pointerCancel(handle, { pointerId: 1, clientY: 700 })
    expect(onClose).not.toHaveBeenCalled()
    expect(onSnapChange).not.toHaveBeenCalled()
  })

  it('closes from its own button, 44 px on a coarse pointer', () => {
    const { onClose } = renderSheet('peek')
    const close = screen.getByRole('button', { name: 'Schließen' })
    fireEvent.click(close)
    expect(onClose).toHaveBeenCalledTimes(1)
    // `Button size="icon"` carries the coarse floor; the sheet must not shrink it.
    expect(close.className).not.toMatch(/\bsize-7\b/)
  })

  it('renders a landscape phone as a panel, not a sheet', () => {
    render(
      <ViewerSheet placement="side" title="AW 38" closeLabel="Schließen" onClose={() => {}}>
        <p>body</p>
      </ViewerSheet>
    )
    const panel = screen.getByRole('complementary', { name: 'AW 38' })
    expect(panel).not.toHaveAttribute('data-snap')
    expect(panel.className).toContain('w-[min(20rem,42vw)]')
  })

  it('a list sheet without sizes has no toggle, only a heading and a close', () => {
    render(
      <ViewerSheet title="Weitere Werkzeuge" closeLabel="Schließen" onClose={() => {}}>
        <p>rows</p>
      </ViewerSheet>
    )
    expect(screen.getByRole('heading', { name: 'Weitere Werkzeuge' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Details/ })).not.toBeInTheDocument()
    expect(screen.getByText('rows')).toBeVisible()
  })
})
