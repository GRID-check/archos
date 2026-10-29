/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { outlineSketch } from './sketch-outline'
import { checkSketchScene } from './sketch-scene'

const scene = checkSketchScene({
  type: 'excalidraw',
  elements: [
    { id: 'frame', type: 'frame', x: 0, y: 0, name: 'Erdgeschoss' },
    { id: 'kitchen', type: 'rectangle', x: 10, y: 10, frameId: 'frame' },
    { id: 'kitchen-label', type: 'text', x: 12, y: 12, text: 'Küche', containerId: 'kitchen', frameId: 'frame' },
    { id: 'dining', type: 'ellipse', x: 200, y: 10, frameId: 'frame' },
    { id: 'dining-label', type: 'text', x: 202, y: 12, text: 'Essen\n  Wohnen', containerId: 'dining' },
    { id: 'lift', type: 'diamond', x: 400, y: 10 },
    {
      id: 'arrow',
      type: 'arrow',
      x: 100,
      y: 20,
      startBinding: { elementId: 'kitchen' },
      endBinding: { elementId: 'dining' },
    },
    { id: 'arrow-label', type: 'text', x: 120, y: 22, text: 'Durchreiche', containerId: 'arrow' },
    { id: 'loose', type: 'line', x: 0, y: 300, startBinding: null },
    { id: 'note', type: 'text', x: 0, y: 400, text: 'nicht maßstäblich' },
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
      { id: 'note', text: 'nicht maßstäblich', container: null },
    ])
  })

  it('names shapes by their label, and an unlabelled one as null', () => {
    expect(outline.shapes).toEqual([
      { id: 'kitchen', type: 'rectangle', label: 'Küche' },
      { id: 'dining', type: 'ellipse', label: 'Essen Wohnen' },
      { id: 'lift', type: 'diamond', label: null },
    ])
  })

  it('reads an arrow as from-label to to-label with its own label', () => {
    expect(outline.connections).toEqual([
      {
        id: 'arrow',
        type: 'arrow',
        from: { id: 'kitchen', label: 'Küche' },
        to: { id: 'dining', label: 'Essen Wohnen' },
        label: 'Durchreiche',
      },
      { id: 'loose', type: 'line', from: null, to: null, label: null },
    ])
  })

  it('lists a frame with its children once each, a container label with its container', () => {
    expect(outline.frames).toEqual([
      {
        id: 'frame',
        name: 'Erdgeschoss',
        children: [
          { id: 'kitchen', type: 'rectangle', label: 'Küche' },
          { id: 'dining', type: 'ellipse', label: 'Essen Wohnen' },
        ],
      },
    ])
  })

  it('leaves out what was deleted', () => {
    expect(JSON.stringify(outline)).not.toContain('Abstellraum')
  })
})
