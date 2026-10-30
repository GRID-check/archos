/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { applySketchEdit, idsNamedBy, SketchEditError } from './sketch-edit'
import { boxOf, type EditElement } from './sketch-edit-elements'
import { outlineSketch } from './sketch-outline'
import { checkSketchScene, type SketchScene } from './sketch-scene'
import { sketchEditSchema, type SketchEditOp } from './sketch-edit-wire'

const shape = (id: string, type: string, x: number, y: number, extra: Record<string, unknown> = {}) => ({
  id,
  type,
  x,
  y,
  width: 160,
  height: 80,
  boundElements: [{ type: 'text', id: `${id}-t` }],
  ...extra,
})
const label = (id: string, text: string, x: number, y: number, extra: Record<string, unknown> = {}) => ({
  id: `${id}-t`,
  type: 'text',
  x: x + 50,
  y: y + 30,
  width: 60,
  height: 20,
  text,
  originalText: text,
  containerId: id,
  ...extra,
})

/** Küche → Essen, Flur below, a frame „EG“ around Küche and Essen. */
const base = (): SketchScene =>
  checkSketchScene({
    type: 'excalidraw',
    elements: [
      { id: 'eg', type: 'frame', x: -20, y: -20, width: 460, height: 120, name: 'EG' },
      shape('kitchen', 'rectangle', 0, 0, { frameId: 'eg', boundElements: [{ type: 'text', id: 'kitchen-t' }, { type: 'arrow', id: 'a1' }] }),
      label('kitchen', 'Küche', 0, 0, { frameId: 'eg' }),
      shape('dining', 'ellipse', 260, 0, { frameId: 'eg', boundElements: [{ type: 'text', id: 'dining-t' }, { type: 'arrow', id: 'a1' }] }),
      label('dining', 'Essen', 260, 0, { frameId: 'eg' }),
      shape('hall', 'rectangle', 0, 200),
      label('hall', 'Flur', 0, 200),
      {
        id: 'a1',
        type: 'arrow',
        x: 164,
        y: 40,
        width: 92,
        height: 0,
        points: [
          [0, 0],
          [92, 0],
        ],
        startBinding: { elementId: 'kitchen', focus: 0, gap: 4 },
        endBinding: { elementId: 'dining', focus: 0, gap: 4 },
      },
      { id: 'gone', type: 'text', x: 0, y: 0, text: 'old', isDeleted: true },
    ],
  })

const run = (ops: SketchEditOp[]) => applySketchEdit(base(), ops, { nonce: () => 7, now: 1 })
const byId = (scene: SketchScene, id: string) => scene.elements.find((element) => element.id === id) as EditElement | undefined
const intent = 'step'

describe('applySketchEdit', () => {
  it('adds a labelled shape bound by a new arrow, and the outline reads both', () => {
    const { scene, diff } = run([
      { op: 'add', intent, element: { type: 'rectangle', id: 'bath', x: 260, y: 200, label: { text: 'Bad' } } },
      { op: 'add', intent, element: { type: 'arrow', id: 'a2', x: 0, y: 0, start: { id: 'hall' }, end: { id: 'bath' } } },
    ])
    expect(diff.added).toEqual(['bath', 'a2'])
    const outline = outlineSketch(scene)
    expect(outline.shapes.find((s) => s.id === 'bath')?.label).toBe('Bad')
    const arrow = outline.connections.find((c) => c.id === 'a2')
    expect(arrow?.from?.label).toBe('Flur')
    expect(arrow?.to?.label).toBe('Bad')
    // Routed from the hall's right edge to the bath's left one, not left at the skeleton's origin.
    const routed = byId(scene, 'a2') as EditElement
    expect(routed.x).toBeGreaterThan(160)
    expect(byId(scene, 'hall')?.boundElements).toContainEqual({ type: 'arrow', id: 'a2' })
  })

  it('refuses an add whose id is taken, also by a deleted element, and an unknown binding', () => {
    expect(() => run([{ op: 'add', intent, element: { type: 'text', id: 'gone', x: 0, y: 0, text: 'x' } }])).toThrow(SketchEditError)
    try {
      run([{ op: 'add', intent, element: { type: 'arrow', id: 'a9', x: 0, y: 0, end: { id: 'nowhere' } } }])
    } catch (error) {
      expect((error as SketchEditError).refusal).toBe('dangling-binding')
    }
  })

  it('removes a shape with its label and the arrows bound to it', () => {
    const { scene, diff } = run([{ op: 'remove', intent, id: 'dining' }])
    expect(diff.removed.sort()).toEqual(['a1', 'dining'])
    expect(byId(scene, 'dining-t')).toBeUndefined()
    expect(byId(scene, 'kitchen')?.boundElements).toEqual([{ type: 'text', id: 'kitchen-t' }])
    // The deleted element of the base stays as a tombstone.
    expect(byId(scene, 'gone')?.isDeleted).toBe(true)
  })

  it('rebinds an arrow and routes it to its new end', () => {
    const { scene, diff } = run([{ op: 'rebind', intent, id: 'a1', end: 'hall' }])
    const arrow = byId(scene, 'a1') as EditElement
    expect(arrow.endBinding).toMatchObject({ elementId: 'hall' })
    expect(byId(scene, 'dining')?.boundElements).toEqual([{ type: 'text', id: 'dining-t' }])
    expect(byId(scene, 'hall')?.boundElements).toContainEqual({ type: 'arrow', id: 'a1' })
    expect(diff.changed).toContain('a1')
  })

  it('places a shape beside another, its label and arrows following', () => {
    const { scene, diff, warnings } = run([{ op: 'place', intent, id: 'dining', referenceId: 'hall', side: 'right', offset: 100 }])
    const dining = byId(scene, 'dining') as EditElement
    expect([dining.x, dining.y]).toEqual([260, 200])
    expect(byId(scene, 'dining-t')).toMatchObject({ x: 310, y: 230 })
    expect(diff.changed.sort()).toEqual(['a1', 'dining'])
    // It left its frame.
    expect(warnings).toContainEqual({ kind: 'outside-frame', ids: ['dining', 'eg'] })
  })

  it('aligns, stacks and distributes', () => {
    const aligned = run([{ op: 'align', intent, ids: ['kitchen', 'hall'], edge: 'right' }]).scene
    expect(boxOf(byId(aligned, 'hall') as EditElement).x).toBe(0)
    const stacked = run([{ op: 'stack', intent, ids: ['hall', 'kitchen', 'dining'], axis: 'horizontal', gap: 20 }]).scene
    expect([byId(stacked, 'kitchen')?.x, byId(stacked, 'dining')?.x]).toEqual([180, 360])
    expect(byId(stacked, 'kitchen')?.y).toBe(0)
    const spread = run([
      { op: 'update', intent, id: 'hall', set: { x: 600, y: 0 } },
      { op: 'distribute', intent, ids: ['kitchen', 'dining', 'hall'], axis: 'horizontal' },
    ]).scene
    expect(byId(spread, 'dining')?.x).toBe(300)
  })

  it('moving a frame moves what it holds', () => {
    const { scene } = run([{ op: 'update', intent, id: 'eg', set: { y: 380 } }])
    expect(byId(scene, 'kitchen')?.y).toBe(400)
    expect(byId(scene, 'dining-t')?.y).toBe(430)
  })

  it('renames a label, adds a missing one, and warns on a dimension', () => {
    const { scene, diff, warnings } = run([
      { op: 'update', intent, id: 'kitchen', set: { label: { text: 'Küche 12 m²' }, backgroundColor: '#ffec99' } },
      { op: 'update', intent, id: 'a1', set: { label: { text: 'Durchreiche' } } },
    ])
    expect(byId(scene, 'kitchen-t')).toMatchObject({ text: 'Küche 12 m²', originalText: 'Küche 12 m²' })
    expect(outlineSketch(scene).connections[0].label).toBe('Durchreiche')
    expect(diff.changed.sort()).toEqual(['a1', 'kitchen'])
    expect(warnings).toContainEqual({ kind: 'dimension-label', ids: ['kitchen'] })
  })

  it('refuses a field the element does not have, an unknown id and a bad colour', () => {
    const refusal = (ops: SketchEditOp[]) => {
      try {
        run(ops)
      } catch (error) {
        return (error as SketchEditError).refusal
      }
      return null
    }
    expect(refusal([{ op: 'update', intent, id: 'kitchen', set: { text: 'x' } }])).toBe('field-not-allowed')
    expect(refusal([{ op: 'update', intent, id: 'nope', set: { x: 1 } }])).toBe('unknown-id')
    expect(refusal([{ op: 'update', intent, id: 'kitchen', set: { strokeColor: 'red' } }])).toBe('bad-color')
    expect(refusal([{ op: 'place', intent, id: 'a1', referenceId: 'hall', side: 'below' }])).toBe('not-movable')
    expect(refusal([{ op: 'rebind', intent, id: 'kitchen', end: 'hall' }])).toBe('not-a-connector')
  })

  it('warns when a new shape lands on another', () => {
    const { warnings } = run([{ op: 'add', intent, element: { type: 'rectangle', id: 'wc', x: 20, y: 210, width: 60, height: 40 } }])
    expect(warnings).toContainEqual({ kind: 'overlap', ids: ['wc', 'hall'] })
  })

  it('names the ids a rebase must still find, not the ones it adds', () => {
    expect(
      idsNamedBy([
        { op: 'add', intent, element: { type: 'arrow', id: 'n', x: 0, y: 0, start: { id: 'hall' }, end: { id: 'm' } } },
        { op: 'add', intent, element: { type: 'text', id: 'm', x: 0, y: 0, text: 'x' } },
        { op: 'place', intent, id: 'kitchen', referenceId: 'dining', side: 'left' },
      ]).sort()
    ).toEqual(['dining', 'hall', 'kitchen'])
  })

  it('the wire takes no ops with a note, and refuses an op without intent', () => {
    expect(sketchEditSchema.safeParse({ baseVersionId: 'v', ops: [], note: 'Maße zeichnet eine Skizze nicht.' }).success).toBe(true)
    expect(sketchEditSchema.safeParse({ baseVersionId: 'v', ops: [{ op: 'remove', id: 'x' }] }).success).toBe(false)
  })
})
