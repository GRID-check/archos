/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { MAX_RESULT_CHARS } from '@/lib/agent-api/discovery'
import { MAX_OUTLINE_POINTS, outlineSketch } from './sketch-outline'
import { checkSketchScene } from './sketch-scene'

const scene = checkSketchScene({
  type: 'excalidraw',
  elements: [
    { id: 'frame', type: 'frame', x: 0, y: 0, width: 600.4, height: 200, name: 'Erdgeschoss' },
    { id: 'kitchen', type: 'rectangle', x: 10, y: 10, width: 90, height: 60, frameId: 'frame' },
    { id: 'kitchen-label', type: 'text', x: 12, y: 12, text: 'Küche', containerId: 'kitchen', frameId: 'frame' },
    { id: 'dining', type: 'ellipse', x: 200, y: 10, width: 120.6, height: 59.5, frameId: 'frame' },
    { id: 'dining-label', type: 'text', x: 202, y: 12, text: 'Essen\n  Wohnen', containerId: 'dining' },
    { id: 'lift', type: 'diamond', x: 400, y: 10, width: -40, height: 40 },
    {
      id: 'arrow',
      type: 'arrow',
      x: 100,
      y: 20,
      points: [
        [0, 0],
        [100, 10.4],
      ],
      startBinding: { elementId: 'kitchen' },
      endBinding: { elementId: 'dining' },
    },
    { id: 'arrow-label', type: 'text', x: 120, y: 22, text: 'Durchreiche', containerId: 'arrow' },
    {
      id: 'loose',
      type: 'line',
      x: 0,
      y: 300,
      points: [
        [0, 0],
        [400, 0],
        [400.4, -20.6],
      ],
      startBinding: null,
    },
    { id: 'note', type: 'text', x: 0, y: 400, width: 150.2, height: 25, text: 'nicht maßstäblich' },
    { id: 'gone', type: 'rectangle', x: 0, y: 0, isDeleted: true },
    { id: 'gone-label', type: 'text', x: 0, y: 0, text: 'Abstellraum', containerId: 'gone', isDeleted: true },
  ],
})

describe('outlineSketch', () => {
  const outline = outlineSketch(scene)

  it('lists each text with the element it labels, and free text without one', () => {
    expect(outline.texts).toEqual([
      { id: 'kitchen-label', text: 'Küche', container: { id: 'kitchen', type: 'rectangle' } },
      { id: 'dining-label', text: 'Essen Wohnen', container: { id: 'dining', type: 'ellipse' } },
      { id: 'arrow-label', text: 'Durchreiche', container: { id: 'arrow', type: 'arrow' } },
      { id: 'note', text: 'nicht maßstäblich', container: null, box: { x: 0, y: 400, w: 150, h: 25 } },
    ])
  })

  it('names shapes by their label, and an unlabelled one as null', () => {
    expect(outline.shapes).toEqual([
      { id: 'kitchen', type: 'rectangle', label: 'Küche', box: { x: 10, y: 10, w: 90, h: 60 } },
      { id: 'dining', type: 'ellipse', label: 'Essen Wohnen', box: { x: 200, y: 10, w: 121, h: 60 } },
      // A shape flipped while drawing has a negative width; its box is where it is.
      { id: 'lift', type: 'diamond', label: null, box: { x: 360, y: 10, w: 40, h: 40 } },
    ])
  })

  it('reads an arrow as from-label to to-label with its own label, and an unbound line by its points', () => {
    expect(outline.connections).toEqual([
      {
        id: 'arrow',
        type: 'arrow',
        from: { id: 'kitchen', label: 'Küche' },
        to: { id: 'dining', label: 'Essen Wohnen' },
        label: 'Durchreiche',
        box: { x: 100, y: 20, w: 100, h: 10 },
      },
      {
        id: 'loose',
        type: 'line',
        from: null,
        to: null,
        label: null,
        box: { x: 0, y: 279, w: 400, h: 21 },
        points: [
          [0, 300],
          [400, 300],
          [400, 279],
        ],
      },
    ])
  })

  it('lists a frame with its children once each, a container label with its container', () => {
    expect(outline.frames).toEqual([
      {
        id: 'frame',
        name: 'Erdgeschoss',
        box: { x: 0, y: 0, w: 600, h: 200 },
        children: [
          { id: 'kitchen', type: 'rectangle', label: 'Küche' },
          { id: 'dining', type: 'ellipse', label: 'Essen Wohnen' },
        ],
      },
    ])
  })

  it('keeps the ends of a long unbound line and samples between them', () => {
    const points = Array.from({ length: 100 }, (_, index) => [index, index % 2])
    const long = outlineSketch(checkSketchScene({ type: 'excalidraw', elements: [{ id: 'street', type: 'line', x: 0, y: 0, points }] }))
    const kept = long.connections[0].points ?? []
    expect(kept).toHaveLength(MAX_OUTLINE_POINTS)
    expect(kept[0]).toEqual([0, 0])
    expect(kept.at(-1)).toEqual([99, 1])
  })

  it('leaves out what was deleted', () => {
    expect(JSON.stringify(outline)).not.toContain('Abstellraum')
  })
})

describe('the outline at the agent door', () => {
  /** An Excalidraw-like id: 21 characters, as `randomId` makes them. */
  const id = (kind: string, n: number) => `${kind}${String(n).padStart(4, '0')}`.padEnd(21, 'x')

  it('keeps an outline-only read of a 150-element sketch, the most a model draws, under the door limit', () => {
    const elements: Record<string, unknown>[] = []
    // 45 labelled rooms in 3 frames, 25 labelled arrows between them, a title, 3 free notes and 3 unbound lines: 150.
    elements.push({ id: id('title', 0), type: 'text', x: 0, y: -120, width: 600, height: 35, text: 'Raumprogramm Erdgeschoss, Variante B' })
    for (let frame = 0; frame < 3; frame++) {
      elements.push({ id: id('frame', frame), type: 'frame', x: frame * 1400.25, y: -40.5, width: 1300.75, height: 900.5, name: `Geschoss ${frame}` })
    }
    for (let room = 0; room < 45; room++) {
      const frameId = id('frame', room % 3)
      elements.push({ id: id('room', room), type: 'rectangle', x: room * 140.123, y: (room % 5) * 160.456, width: 160.5, height: 90.25, frameId })
      elements.push({ id: id('label', room), type: 'text', x: room * 140 + 4.5, y: 4.25, width: 120.33, height: 25, text: `Aufenthaltsraum ${room}`, containerId: id('room', room), frameId })
    }
    for (let arrow = 0; arrow < 25; arrow++) {
      elements.push({
        id: id('arrow', arrow),
        type: 'arrow',
        x: arrow * 140.5,
        y: 45.25,
        points: [
          [0, 0],
          [120.4, 30.6],
        ],
        startBinding: { elementId: id('room', arrow) },
        endBinding: { elementId: id('room', arrow + 1) },
      })
      elements.push({ id: id('alabel', arrow), type: 'text', x: arrow * 140 + 40, y: 50, text: `Zugang ${arrow}`, containerId: id('arrow', arrow) })
    }
    for (let note = 0; note < 3; note++) {
      elements.push({ id: id('note', note), type: 'text', x: note * 300.5, y: 1000.25, width: 220.4, height: 25, text: 'Skizze, nicht maßstäblich' })
      elements.push({
        id: id('line', note),
        type: 'line',
        x: -100.5,
        y: 1100.5 + note * 40,
        points: Array.from({ length: 30 }, (_, index) => [index * 140.33, (index % 3) * 10.5]),
      })
    }
    expect(elements).toHaveLength(150)
    const view = {
      documentId: '6f1c2b0e-2f4a-4b8e-9c55-1d2e3f4a5b6c',
      versionId: '7a1c2b0e-2f4a-4b8e-9c55-1d2e3f4a5b6c',
      canWrite: true,
      title: 'Raumprogramm Erdgeschoss Variante B',
      outline: outlineSketch(checkSketchScene({ type: 'excalidraw', elements })),
      saveTarget: 'published',
      contentHash: null,
    }
    const chars = JSON.stringify(view).length
    expect(chars).toBeLessThan(MAX_RESULT_CHARS)
    // Measured 2026-10-30: 25,202 characters, so room for longer labels.
    expect(chars).toBeLessThan(0.8 * MAX_RESULT_CHARS)
  })
})
