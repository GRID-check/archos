import { describe, expect, it } from 'vitest'
import fixtures from './__fixtures__/sketch-fences.json'
import { readSketchFence, SKETCH_REFUSALS, sketchFenceKind } from './sketch-fence'

interface Case {
  name: string
  body: string
  refusal: string | null
  elements?: number
  dimension_labels?: number
}

const cases = fixtures.cases as Case[]

describe('the sketch fence check agrees with the server on every shared case', () => {
  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const fence = readSketchFence(c.body)
    if (c.refusal === null) {
      expect(fence).toMatchObject({ ok: true, dimensionLabels: c.dimension_labels })
      expect(fence.ok && fence.elements).toHaveLength(c.elements ?? 0)
    } else {
      expect(fence).toEqual({ ok: false, refusal: c.refusal })
    }
  })

  it('has a case for every refusal', () => {
    expect(new Set(cases.map((c) => c.refusal).filter(Boolean))).toEqual(new Set(SKETCH_REFUSALS))
  })
})

describe('what reaches Excalidraw', () => {
  it('drops what the allow-list does not name and sets every text in Helvetica', () => {
    const fence = readSketchFence(
      JSON.stringify({
        title: '  Zonen ',
        elements: [
          { type: 'rectangle', id: 'a', x: 0, y: 0, link: 'https://example.com', customData: { x: 1 }, label: { text: 'Wohnen', onClick: 'x' } },
          { type: 'text', x: 0, y: 90, text: 'Notiz', fontSize: 400, strokeColor: 'red' },
          { type: 'arrow', x: 0, y: 0, points: [[0, 0], [40, 0]], end: { id: 'a', gap: 9 }, endArrowhead: null, fillStyle: 'gradient' },
        ],
      })
    )
    expect(fence).toEqual({
      ok: true,
      title: 'Zonen',
      dimensionLabels: 0,
      elements: [
        { type: 'rectangle', id: 'a', x: 0, y: 0, label: { text: 'Wohnen', fontFamily: 2 } },
        { type: 'text', x: 0, y: 90, text: 'Notiz', fontSize: 64, fontFamily: 2 },
        { type: 'arrow', x: 0, y: 0, points: [[0, 0], [40, 0]], end: { id: 'a' }, endArrowhead: null },
      ],
    })
  })
})

describe('sketchFenceKind', () => {
  it('tells a sketch from a refused one and from everything else', () => {
    expect(sketchFenceKind('language-excalidraw')).toBe('sketch')
    expect(sketchFenceKind('language-excalidraw-refused')).toBe('refused')
    expect(sketchFenceKind('language-json')).toBeNull()
    expect(sketchFenceKind(undefined)).toBeNull()
  })
})
