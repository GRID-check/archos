/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { changedUnderEdit } from './sketch-edit-rebase'
import { checkSketchScene, type SketchScene } from './sketch-scene'
import type { SketchEditOp } from './sketch-edit-wire'

const box = (id: string, version = 1, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'rectangle',
  x: 0,
  y: 0,
  width: 100,
  height: 50,
  version,
  versionNonce: version * 10,
  ...extra,
})
const label = (container: string, text: string, version = 1) => ({
  id: `${container}-t`,
  type: 'text',
  x: 10,
  y: 10,
  width: 40,
  height: 20,
  text,
  originalText: text,
  containerId: container,
  version,
  versionNonce: version * 10,
})
const arrow = (id: string, from: string, to: string) => ({
  id,
  type: 'arrow',
  x: 0,
  y: 0,
  width: 10,
  height: 0,
  points: [
    [0, 0],
    [10, 0],
  ],
  startBinding: { elementId: from, focus: 0, gap: 4 },
  endBinding: { elementId: to, focus: 0, gap: 4 },
  version: 1,
  versionNonce: 10,
})
const scene = (elements: Record<string, unknown>[]): SketchScene => checkSketchScene({ type: 'excalidraw', elements })
const v3 = scene([box('hall', 1, { boundElements: [{ type: 'text', id: 'hall-t' }] }), label('hall', 'Gang'), box('store')])

describe('changedUnderEdit', () => {
  const relabel: SketchEditOp[] = [{ op: 'update', intent: 'Den Gang in Flur umbenennen', id: 'hall', set: { label: { text: 'Flur' } } }]

  it('lets an edit rebase over a colleague’s change elsewhere', () => {
    const v4 = scene([...v3.elements, box('bath')].map((element) => (element.id === 'store' ? { ...element, version: 2, versionNonce: 20 } : element)))
    expect(changedUnderEdit(v3, v4, relabel)).toEqual([])
  })

  it('names the element when a colleague renamed it in between', () => {
    const v4 = scene(v3.elements.map((element) => (element.id === 'hall-t' ? { ...element, text: 'Diele', version: 2, versionNonce: 20 } : element)))
    expect(changedUnderEdit(v3, v4, relabel)).toEqual(['hall-t'])
  })

  it('names the element when a colleague moved it in between', () => {
    const v4 = scene(v3.elements.map((element) => (element.id === 'hall' ? { ...element, x: 300, version: 2, versionNonce: 20 } : element)))
    expect(changedUnderEdit(v3, v4, relabel)).toEqual(['hall'])
  })

  it('names an arrow a colleague bound to the element the edit removes', () => {
    const v4 = scene([...v3.elements, arrow('a9', 'hall', 'store')])
    expect(changedUnderEdit(v3, v4, [{ op: 'remove', intent: 'Den Abstellraum entfernen', id: 'store' }])).toEqual(['a9'])
  })
})
