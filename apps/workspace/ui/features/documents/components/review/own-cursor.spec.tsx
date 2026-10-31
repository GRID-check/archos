/**
 * The reader's own pointer over the review's pages is the one the room sees:
 * the same arrow in the same colour as the peer cursor drawn for that user,
 * the tool in hand beside it, the system pointer back over controls and
 * cards, and nothing at all on a touch screen.
 */

import { useRef, type JSX } from 'react'
import { act, fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@/test-utils'
import { identityInk } from '@/components/ui/avatar-identity'
import { LiveCursor } from '@/components/ui/live-cursor'
import type { ReviewTool } from '../../hooks/use-document-review'
import { OWN_CURSOR_ZONE, OwnCursor, ownCursorShows } from './own-cursor'

const USER = 'user_miriam'

function Canvas({ tool = 'select' }: { tool?: ReviewTool }): JSX.Element {
  const canvas = useRef<HTMLDivElement | null>(null)
  // The review opens as a dialog: the frame around the canvas is no control on the page.
  return (
    <div role="dialog">
      <div ref={canvas} data-testid="canvas" className={OWN_CURSOR_ZONE}>
        <OwnCursor canvas={canvas} userId={USER} name="Miriam Vogt" tool={tool} />
        <div data-page="1" data-testid="sheet">
          <span data-testid="drawing">Grundriss</span>
          <button type="button" data-testid="pin">1</button>
          <div data-placement="below" data-testid="card">
            <p data-testid="card-text">Anmerkung</p>
          </div>
        </div>
        <div data-testid="gutter" />
      </div>
    </div>
  )
}

/** Runs the frame the pointer asked for. */
let frames: FrameRequestCallback[] = []
const flush = () =>
  act(() => {
    const due = frames
    frames = []
    due.forEach((run) => run(0))
  })

const move = (target: Element, pointerType = 'mouse') => {
  fireEvent.pointerMove(target, { clientX: 120, clientY: 80, pointerType })
  flush()
}

const coarse = (matches: boolean) =>
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: matches && query === '(pointer: coarse)',
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
  )

beforeEach(() => {
  frames = []
  vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) => frames.push(run))
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
})
afterEach(() => vi.unstubAllGlobals())

describe('ownCursorShows', () => {
  it('stands for the reader on a page, never over a control, a card or off the pages', () => {
    render(<Canvas />)
    const root = screen.getByTestId('canvas')
    expect(ownCursorShows(screen.getByTestId('drawing'), root)).toBe(true)
    expect(ownCursorShows(screen.getByTestId('pin'), root)).toBe(false)
    expect(ownCursorShows(screen.getByTestId('card-text'), root)).toBe(false)
    expect(ownCursorShows(screen.getByTestId('gutter'), root)).toBe(false)
    expect(ownCursorShows(null, root)).toBe(false)
  })
})

describe('OwnCursor', () => {
  it('is the peer cursor the room draws for the same user: the same arrow, the same colour', () => {
    render(<Canvas />)
    const own = screen.getByTestId('own-cursor').querySelector('path')
    const { container } = render(<LiveCursor color={identityInk(USER)} label="Miriam Vogt" />)
    const peer = container.querySelector('path')
    expect(own?.getAttribute('d')).toBe(peer?.getAttribute('d'))
    expect(own?.getAttribute('fill')).toBe(identityInk(USER))
    expect(own?.getAttribute('fill')).toBe(peer?.getAttribute('fill'))
    // No name tag on one's own hand.
    expect(screen.getByTestId('own-cursor').querySelector('[data-slot="live-cursor-tag"]')).toBeNull()
  })

  it('follows the pointer on transform, hiding the system pointer only while it is shown', () => {
    render(<Canvas />)
    const own = screen.getByTestId('own-cursor')
    const root = screen.getByTestId('canvas')
    expect(own.style.visibility).toBe('hidden')

    move(screen.getByTestId('drawing'))
    expect(own.style.visibility).toBe('visible')
    expect(own.style.transform).toBe('translate3d(120px, 80px, 0)')
    expect(root.hasAttribute('data-own-cursor')).toBe(true)

    move(screen.getByTestId('pin'))
    expect(own.style.visibility).toBe('hidden')
    expect(root.hasAttribute('data-own-cursor')).toBe(false)

    move(screen.getByTestId('drawing'))
    fireEvent.pointerLeave(root)
    flush()
    expect(own.style.visibility).toBe('hidden')
  })

  it('coalesces the moves of one frame into one write', () => {
    render(<Canvas />)
    const drawing = screen.getByTestId('drawing')
    fireEvent.pointerMove(drawing, { clientX: 10, clientY: 10, pointerType: 'mouse' })
    fireEvent.pointerMove(drawing, { clientX: 30, clientY: 40, pointerType: 'mouse' })
    expect(frames).toHaveLength(1)
    flush()
    expect(screen.getByTestId('own-cursor').style.transform).toBe('translate3d(30px, 40px, 0)')
  })

  it('carries the tool in hand beside the arrow', () => {
    const { rerender } = render(<Canvas tool="point" />)
    expect(document.querySelector('[data-own-cursor-tool="point"]')).not.toBeNull()
    rerender(<Canvas tool="region" />)
    expect(document.querySelector('[data-own-cursor-tool="region"]')).not.toBeNull()
    rerender(<Canvas tool="ask" />)
    expect(document.querySelector('[data-own-cursor-tool="ask"]')).not.toBeNull()
    rerender(<Canvas tool="select" />)
    expect(document.querySelector('[data-slot="live-cursor-badge"]')).toBeNull()
  })

  it('is not drawn for a finger', () => {
    render(<Canvas />)
    move(screen.getByTestId('drawing'), 'touch')
    expect(screen.getByTestId('own-cursor').style.visibility).toBe('hidden')
  })

  it('is not rendered on a coarse pointer', () => {
    coarse(true)
    render(<Canvas />)
    expect(screen.queryByTestId('own-cursor')).toBeNull()
    move(screen.getByTestId('drawing'))
    expect(screen.getByTestId('canvas').hasAttribute('data-own-cursor')).toBe(false)
  })
})
