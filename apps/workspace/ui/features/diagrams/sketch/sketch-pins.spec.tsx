import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/features/documents', () => ({
  ReviewPageLayer: ({ review }: { review: { annotations: Array<{ id: string; x: number; w: number | null }> } }) => (
    <div data-testid="layer">
      {review.annotations.map((mark) => (
        <span key={mark.id} data-testid={`pin-${mark.id}`} data-x={mark.x} data-w={mark.w ?? ''} />
      ))}
    </div>
  ),
  DraftCard: () => null,
  ThreadCard: () => null,
}))

import { placedLive, SketchPins, type SketchViewApi } from './sketch-pins'

type Listener = () => void

function fakeApi(elements: Array<{ id: string; x: number; y: number; width: number; height: number }>, selected: string[] = []) {
  const listeners: Listener[] = []
  const state = { scrollX: 0, scrollY: 0, zoom: { value: 1 }, selectedElementIds: Object.fromEntries(selected.map((id) => [id, true])) }
  const api: SketchViewApi = {
    getSceneElements: () => elements,
    getAppState: () => state,
    onChange: (callback) => {
      listeners.push(callback)
      return () => undefined
    },
    onScrollChange: (callback) => {
      listeners.push(callback)
      return () => undefined
    },
  }
  return {
    api,
    move: (id: string, x: number) => {
      const element = elements.find((candidate) => candidate.id === id)!
      element.x = x
      listeners.forEach((listener) => listener())
    },
    scroll: (x: number, zoom: number) => {
      state.scrollX = x
      state.zoom = { value: zoom }
      listeners.forEach((listener) => listener())
    },
  }
}

const mark = (id: string, elementIds: string[] | null) =>
  ({ id, elementIds, x: 0.9, y: 0.9, w: 0.05, h: 0.05, page: 1, onCurrentRevision: true, status: 'open' }) as never

const review = (annotations: unknown[]) =>
  ({ annotations, draft: null, selectedId: null, canAnnotate: true, setDraft: vi.fn() }) as never

const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))

describe('placedLive', () => {
  it('puts a pinned mark where its elements stand, and leaves a lost one where it was', () => {
    const elements = [{ id: 'a', x: 0, y: 0, width: 100, height: 100 }]
    const frame = { left: -16, top: -16, width: 132, height: 132 }
    expect(placedLive({ elementIds: ['a'], x: 0.5, y: 0.5, w: 0.1, h: 0.1 }, elements, frame).x).toBeCloseTo(16 / 132)
    expect(placedLive({ elementIds: ['gone'], x: 0.5, y: 0.5, w: 0.1, h: 0.1 }, elements, frame).x).toBe(0.5)
  })
})

describe('SketchPins', () => {
  it('follows its element while it is dragged, before any save', async () => {
    const canvas = fakeApi([
      { id: 'a', x: 0, y: 0, width: 100, height: 100 },
      { id: 'b', x: 300, y: 0, width: 100, height: 100 },
    ])
    render(<SketchPins api={canvas.api} review={review([mark('m1', ['a'])])} canAnnotate onAnnotate={vi.fn()} />)
    const before = Number(screen.getByTestId('pin-m1').dataset.x)
    await act(async () => {
      canvas.move('a', 200)
      await frame()
    })
    expect(Number(screen.getByTestId('pin-m1').dataset.x)).toBeGreaterThan(before)
  })

  it('lays the sheet over the canvas at its scroll and zoom', async () => {
    const canvas = fakeApi([{ id: 'a', x: 0, y: 0, width: 100, height: 100 }])
    render(<SketchPins api={canvas.api} review={review([])} canAnnotate onAnnotate={vi.fn()} />)
    await act(async () => {
      canvas.scroll(50, 2)
      await frame()
    })
    const sheet = screen.getByTestId('sketch-pins-sheet')
    expect(sheet.style.left).toBe(`${(-16 + 50) * 2}px`)
    expect(sheet.style.width).toBe(`${132 * 2}px`)
  })

  it('stacks above the canvas, as the link marks do', () => {
    // Excalidraw's canvases are positioned with z-index 1 and 2 in the same slot:
    // without a stacking order of its own the layer is drawn, and clicked, under them.
    // jsdom has no layout, so this holds the class; `elementFromPoint` on /dev/sketch-links checked the paint.
    const canvas = fakeApi([{ id: 'a', x: 0, y: 0, width: 100, height: 100 }])
    render(<SketchPins api={canvas.api} review={review([])} canAnnotate onAnnotate={vi.fn()} />)
    expect(screen.getByTestId('sketch-pins').classList).toContain('z-10')
  })

  it('offers „Anmerkung“ on a selection and hands its elements to the dialog', () => {
    const onAnnotate = vi.fn()
    const canvas = fakeApi([{ id: 'a', x: 0, y: 0, width: 100, height: 100 }], ['a'])
    render(<SketchPins api={canvas.api} review={review([])} canAnnotate onAnnotate={onAnnotate} />)
    fireEvent.click(screen.getByTestId('sketch-annotate'))
    expect(onAnnotate).toHaveBeenCalledWith(expect.objectContaining({ page: 1, shape: 'region', elementIds: ['a'] }))
  })

  it('offers nothing to a reader who may not annotate', () => {
    const canvas = fakeApi([{ id: 'a', x: 0, y: 0, width: 100, height: 100 }], ['a'])
    render(<SketchPins api={canvas.api} review={review([])} canAnnotate={false} onAnnotate={vi.fn()} />)
    expect(screen.queryByTestId('sketch-annotate')).toBeNull()
  })
})
