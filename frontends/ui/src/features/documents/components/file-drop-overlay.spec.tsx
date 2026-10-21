/**
 * The window guard and the overlay: a file nobody took is not opened by the
 * browser, a drag inside the page is left to the page, and a refusal is said.
 */

import { render, renderHook, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { FileDropOverlay, useWindowDragGuard } from './file-drop-overlay'

const dragEventOn = (type: string, types: string[]) => {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: { types, dropEffect: 'copy' } })
  return event as DragEvent
}

describe('useWindowDragGuard', () => {
  it('keeps the browser from opening a desktop file dropped outside every zone, and says „no drop"', () => {
    renderHook(() => useWindowDragGuard())
    const over = dragEventOn('dragover', ['Files'])
    const drop = dragEventOn('drop', ['Files'])

    window.dispatchEvent(over)
    window.dispatchEvent(drop)

    expect(over.defaultPrevented).toBe(true)
    expect(over.dataTransfer?.dropEffect).toBe('none')
    expect(drop.defaultPrevented).toBe(true)
  })

  it('leaves a drag that started in the page alone: text into a field, a document between two tiles', () => {
    renderHook(() => useWindowDragGuard())
    const over = dragEventOn('dragover', ['application/x-grid-document-id'])
    const drop = dragEventOn('drop', ['text/plain'])

    window.dispatchEvent(over)
    window.dispatchEvent(drop)

    expect(over.defaultPrevented).toBe(false)
    expect(over.dataTransfer?.dropEffect).toBe('copy')
    expect(drop.defaultPrevented).toBe(false)
  })
})

describe('FileDropOverlay', () => {
  const labels = { uploadLabel: 'Hier ablegen', unsupportedLabel: 'Nicht unterstützt', testId: 'overlay' }

  it('names where the files go', () => {
    render(<FileDropOverlay show {...labels} isUnsupported={false} />)
    expect(screen.getByTestId('overlay')).toHaveTextContent('Hier ablegen')
    expect(screen.getByTestId('overlay')).not.toHaveAttribute('data-refused')
  })

  it('says a refusal over every other label, and marks itself refused', () => {
    render(<FileDropOverlay show {...labels} isUnsupported refusal="Nur lesen" />)
    const overlay = screen.getByTestId('overlay')
    expect(overlay).toHaveTextContent('Nur lesen')
    expect(overlay).toHaveAttribute('data-refused')
    expect(overlay).toHaveAttribute('role', 'status')
  })
})
