/**
 * Schematic labels stay legible when the drawing shrinks (`legibleLabelSize`,
 * `SvgLabel` inside `SchematicCanvas`): the geometry is to scale, a label is
 * not, and a label is never enlarged past the room its template left for it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { MAX_LABEL_GROWTH, MIN_LABEL_PX, SchematicCanvas, SvgLabel, legibleLabelSize } from './kit'

describe('legibleLabelSize', () => {
  it('leaves the label alone before the canvas is measured', () => {
    expect(legibleLabelSize(8, null)).toBe(8)
    expect(legibleLabelSize(8, 0)).toBe(8)
  })

  it('leaves a label that already reads at the minimum', () => {
    expect(legibleLabelSize(10, 1)).toBe(10)
    expect(legibleLabelSize(8, 1.25)).toBe(8)
  })

  it('enlarges a shrunken label to the minimum on screen', () => {
    // 9 units at 0.8 would be 7.2px; 12.5 units at 0.8 is exactly 10px.
    expect(legibleLabelSize(9, 0.8)).toBeCloseTo(MIN_LABEL_PX / 0.8)
    expect(legibleLabelSize(9, 0.8) * 0.8).toBeCloseTo(MIN_LABEL_PX)
  })

  it('caps the growth at 2×, even when the minimum is not reached', () => {
    expect(MAX_LABEL_GROWTH).toBe(2)
    // 8 units at 0.4 would need 25 units to read at 10px; it gets 16.

    expect(legibleLabelSize(8, 0.4)).toBeCloseTo(8 * MAX_LABEL_GROWTH)
  })
})

describe('SvgLabel on a SchematicCanvas', () => {
  afterEach(() => vi.restoreAllMocks())

  const drawnAt = (width: number) => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ width } as DOMRect)
    const { container } = render(
      <SchematicCanvas viewW={500} viewH={200} label="Schnitt">
        <SvgLabel x={0} y={0} size={8}>
          3,00 m
        </SvgLabel>
      </SchematicCanvas>
    )
    const text = container.querySelector('text') as SVGTextElement
    return { size: Number(text.getAttribute('font-size')), halo: Number(text.getAttribute('stroke-width')) }
  }

  it('draws the label larger on a narrow canvas and scales its halo with it', () => {
    // 500 units in 350px: scale 0.7, so 8 units would be 5.6px; it is drawn
    // at 10 / 0.7 units, which is the 10px floor, inside the 2× cap.
    const { size, halo } = drawnAt(350)
    expect(size).toBeCloseTo(MIN_LABEL_PX / 0.7)
    expect(halo).toBeCloseTo((3 * size) / 8)
  })

  it('draws the authored size on a canvas wide enough to read it', () => {
    expect(drawnAt(1000).size).toBe(8)
  })
})

describe('SchematicCanvas label declutter', () => {
  afterEach(() => vi.restoreAllMocks())

  const rectOf = (left: number, top: number, width: number, height = 12): DOMRect =>
    ({ left, top, width, height, right: left + width, bottom: top + height }) as DOMRect

  it('nudges a label that overprints another, and one cut by the edge', () => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this instanceof SVGSVGElement) return rectOf(0, 0, 350, 200)
      const label = this.textContent
      if (label === 'GK4-Grenze') return rectOf(150, 40, 70)
      if (label === '+11 m') return rectOf(150, 44, 40)
      if (label === 'Ungünstigster Punkt') return rectOf(-12, 120, 90)
      return rectOf(0, 0, 0, 0)
    })
    const { container } = render(
      <SchematicCanvas viewW={500} viewH={200} label="Schnitt">
        <SvgLabel x={0} y={0}>GK4-Grenze</SvgLabel>
        <SvgLabel x={0} y={5}>+11 m</SvgLabel>
        <SvgLabel x={0} y={50}>Ungünstigster Punkt</SvgLabel>
      </SchematicCanvas>
    )
    const [grenze, hoehe, start] = Array.from(container.querySelectorAll('text'))

    // Scale 0.7: a 12px push back to viewBox units is 12 / 0.7 or more.
    expect(grenze.hasAttribute('dy')).toBe(false)
    expect(Number(hoehe.getAttribute('dy'))).toBeGreaterThan(0)
    // 12px cut off at the left edge (minus the 2px margin) slides back by 14px.
    expect(Number(start.getAttribute('dx'))).toBeCloseTo((12 + 2) / 0.7)
  })
})
