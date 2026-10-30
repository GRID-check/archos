/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { DIAGRAM_SOURCE_FACTS } from './diagram-sources'
import {
  MAX_SCENE_ELEMENTS,
  checkSketchScene,
  parseStoredSketchScene,
  serializeSketchScene,
  SketchSceneError,
  type SceneRefusal,
} from './sketch-scene'

const element = (overrides: Record<string, unknown> = {}) => ({ id: 'a', type: 'rectangle', x: 0, y: 0, ...overrides })
const scene = (elements: unknown[], extra: Record<string, unknown> = {}) => ({ type: 'excalidraw', elements, ...extra })

function refusal(value: unknown): SceneRefusal | null {
  try {
    checkSketchScene(value)
    return null
  } catch (error) {
    return error instanceof SketchSceneError ? error.refusal : null
  }
}

describe('checkSketchScene', () => {
  it('keeps a scene the editor wrote, every field of its elements as it came', () => {
    const value = scene([element({ seed: 7, version: 3, boundElements: [] }), element({ id: 'b', type: 'freedraw' })], {
      appState: { viewBackgroundColor: '#ffffff' },
      files: {},
    })
    expect(checkSketchScene(value)).toEqual(value)
  })

  it('drops what the fence drops too: an element link, foreign customData, appState Excalidraw does not export', () => {
    const value = scene([element({ link: 'https://anywhere.example', customData: { tracker: 'x' } })], {
      appState: { gridSize: 20, zoom: { value: 1 }, openDialog: { name: 'ttd' } },
    })
    const kept = checkSketchScene(value)
    expect(kept.elements[0]).toEqual(element())
    expect(kept.appState).toEqual({ gridSize: 20 })
  })

  it('keeps a link into the workspace and drops its foreign keys; a wrong link goes whole', () => {
    const link = { documentId: 'doc_ifc', ifcGlobalId: '2O2Fr$t4X7Zf8NOew3FLOH' }
    const kept = checkSketchScene(
      scene([
        element({ customData: { ...link, tracker: 'x' } }),
        element({ id: 'b', customData: { documentId: 'doc_plan', page: 0 } }),
      ])
    )
    expect(kept.elements[0].customData).toEqual(link)
    expect(kept.elements[1]).toEqual(element({ id: 'b' }))
  })

  it.each([
    ['not an object', [], 'not-a-scene'],
    ['another type', { type: 'tldraw', elements: [] }, 'not-a-scene'],
    ['an image', scene([element({ type: 'image' })]), 'unsupported-element'],
    ['an embed', scene([element({ type: 'embeddable' })]), 'unsupported-element'],
    ['files', scene([element()], { files: { f: { dataURL: 'data:' } } }), 'has-files'],
    ['two ids alike', scene([element(), element()]), 'duplicate-id'],
    ['a coordinate out of range', scene([element({ x: 2e6 })]), 'bad-coordinate'],
    ['a missing coordinate', scene([element({ y: 'top' })]), 'bad-coordinate'],
    ['a text too long', scene([element({ type: 'text', text: 'x'.repeat(5001) })]), 'text-too-long'],
    [
      'too many elements',
      scene(Array.from({ length: MAX_SCENE_ELEMENTS + 1 }, (_, index) => element({ id: `e${index}` }))),
      'too-many-elements',
    ],
  ])('refuses %s', (_name, value, expected) => {
    expect(refusal(value)).toBe(expected)
  })

  it('refuses a scene above the excalidraw source cap when it is serialized', () => {
    const big = checkSketchScene(
      scene([element({ type: 'text', text: 'x'.repeat(4000) })], {
        padding: 'y'.repeat(DIAGRAM_SOURCE_FACTS.excalidraw.maxSourceBytes),
      })
    )
    expect(() => serializeSketchScene(big)).toThrow(SketchSceneError)
  })

  it('reads stored scene text back, or nothing for text that is not one', () => {
    expect(parseStoredSketchScene(JSON.stringify(scene([element()])))?.elements).toHaveLength(1)
    expect(parseStoredSketchScene('graph TD')).toBeNull()
    expect(parseStoredSketchScene('{"type":"excalidraw","elements":[{"id":"a","type":"image","x":0,"y":0}]}')).toBeNull()
  })
})
