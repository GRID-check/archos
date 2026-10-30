/**
 * @vitest-environment node
 *
 * What one edit may cost: an apply that stays linear in the scene, warnings
 * capped before they reach the card or Piloti, and new elements drawn on top.
 */
import { describe, expect, it } from 'vitest'
import { applySketchEdit, MAX_SKETCH_EDIT_IDS, SketchEditError } from './sketch-edit'
import { describeWarnings, MAX_SKETCH_EDIT_WARNINGS } from './sketch-edit-lints'
import { checkSketchScene, type SketchScene } from './sketch-scene'
import { MAX_SKETCH_EDIT_OPS, type SketchEditOp } from './sketch-edit-wire'

const intent = 'Den Rahmen nach rechts schieben'

/** One frame with `members` labelled boxes in it, every box with an arrow to the next; `overlap` stacks them on one spot. */
function crowded(members: number, overlap: boolean): SketchScene {
  const elements: Record<string, unknown>[] = [{ id: 'f', type: 'frame', x: -10, y: -10, width: 40_000, height: 40_000, name: 'EG' }]
  for (let i = 0; i < members; i++) {
    const x = overlap ? 0 : (i % 50) * 200
    const y = overlap ? 0 : Math.floor(i / 50) * 120
    elements.push({ id: `b${i}`, type: 'rectangle', x, y, width: 160, height: 80, frameId: 'f', boundElements: [{ type: 'text', id: `b${i}-t` }] })
    elements.push({ id: `b${i}-t`, type: 'text', x: x + 50, y: y + 30, width: 60, height: 20, text: `Raum ${i}`, originalText: `Raum ${i}`, containerId: `b${i}`, frameId: 'f' })
  }
  return checkSketchScene({ type: 'excalidraw', elements })
}

describe('the cost of one edit', () => {
  for (const overlap of [false, true]) {
    it(`moves a frame of 1,999 members sixty times in well under a second (${overlap ? 'all overlapping' : 'laid out'})`, () => {
      const scene = crowded(999, overlap)
      const ops: SketchEditOp[] = Array.from({ length: MAX_SKETCH_EDIT_OPS }, (_, i) => ({ op: 'update', intent, id: 'f', set: { x: i * 10 } }))
      const started = performance.now()
      const applied = applySketchEdit(scene, ops, { nonce: () => 1, now: 1 })
      const took = performance.now() - started
      expect(took, `${Math.round(took)} ms`).toBeLessThan(300)
      expect(applied.warnings.length).toBeLessThanOrEqual(MAX_SKETCH_EDIT_WARNINGS)
      const lines = describeWarnings(applied.warnings, applied.moreWarnings)
      expect(lines.length).toBeLessThanOrEqual(MAX_SKETCH_EDIT_WARNINGS + 1)
      if (overlap) expect(lines.at(-1)).toMatch(/^and \d+ more warnings/)
    })
  }

  it('refuses a relative op naming more elements than a person reads through', () => {
    const scene = crowded(MAX_SKETCH_EDIT_IDS + 1, false)
    const ids = Array.from({ length: MAX_SKETCH_EDIT_IDS + 1 }, (_, i) => `b${i}`)
    expect(() => applySketchEdit(scene, [{ op: 'align', intent, ids, edge: 'left' }])).toThrow(SketchEditError)
    expect(() => applySketchEdit(scene, [{ op: 'align', intent, ids: ids.slice(1), edge: 'left' }])).not.toThrow()
  })

  it('names each warning once', () => {
    expect(describeWarnings([{ kind: 'overlap', ids: ['a', 'b'] }, { kind: 'overlap', ids: ['a', 'b'] }], 0)).toEqual(['a overlaps b'])
  })
})

describe('where new elements go', () => {
  it('draws an added shape on top when the top element was removed in the same edit', () => {
    const scene = checkSketchScene({
      type: 'excalidraw',
      elements: [
        { id: 'a', type: 'rectangle', x: 0, y: 0, width: 100, height: 50, index: 'a0' },
        { id: 'b', type: 'rectangle', x: 200, y: 0, width: 100, height: 50, index: 'a1' },
      ],
    })
    const { scene: next } = applySketchEdit(scene, [
      { op: 'remove', intent: 'Das Bad entfernen', id: 'b' },
      { op: 'add', intent: 'Rechts neben dem Flur einen Abstellraum anlegen', element: { type: 'rectangle', id: 'c', x: 200, y: 0 } },
    ])
    expect(next.elements.filter((element) => !element.isDeleted).map((element) => `${element.id}:${element.index}`)).toEqual(['a:a0', 'c:a2'])
  })
})
