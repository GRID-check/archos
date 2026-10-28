/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import fixtures from './__fixtures__/sketch-fences.json'
import { readSketchFence, SKETCH_REFUSALS, sketchFenceKind, streamedSketchElements } from './sketch-fence'

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
        { type: 'rectangle', id: 'a', x: 0, y: 0, label: { text: 'Wohnen', fontFamily: 2, fontSize: 16 } },
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

describe('a sketch still being written', () => {
  const finished = JSON.stringify({
    title: 'Zonen',
    elements: [
      { type: 'ellipse', id: 'a', x: 0, y: 0, label: { text: 'Wohnen {mit} "Bar"' } },
      { type: 'arrow', x: 0, y: 0, points: [[0, 0], [100, 0]], start: { id: 'a' }, end: { id: 'b' } },
      { type: 'ellipse', id: 'b', x: 200, y: 0, label: { text: 'Kochen' } },
    ],
  })

  it('draws the elements that have arrived, whole ones only', () => {
    const cut = finished.indexOf('"Kochen"')
    const elements = streamedSketchElements(finished.slice(0, cut))
    expect(elements.map((element) => element.type)).toEqual(['ellipse', 'arrow'])
  })

  it('leaves a binding off until the element it names has arrived', () => {
    const cut = finished.indexOf('{"type":"ellipse","id":"b"')
    const [, arrow] = streamedSketchElements(finished.slice(0, cut))
    expect(arrow).toMatchObject({ start: { id: 'a' } })
    expect(arrow).not.toHaveProperty('end')
    expect(streamedSketchElements(finished)[1]).toMatchObject({ end: { id: 'b' } })
  })

  it('reads a bare array, and nothing before the array opens', () => {
    expect(streamedSketchElements('[{"type":"text","x":0,"y":0,"text":"N"},{"type":')).toHaveLength(1)
    expect(streamedSketchElements('{"title": "Zon')).toEqual([])
  })

  it('reads a body escaped twice as it streams', () => {
    expect(streamedSketchElements('{\\"elements\\":[{\\"type\\":\\"text\\",\\"x\\":0,\\"y\\":0,\\"text\\":\\"N\\"},')).toHaveLength(1)
  })

  it('skips an element that would be refused rather than the whole sketch', () => {
    expect(streamedSketchElements('[{"type":"image","x":0,"y":0},{"type":"text","x":0,"y":0,"text":"ok"}')).toHaveLength(1)
  })
})
