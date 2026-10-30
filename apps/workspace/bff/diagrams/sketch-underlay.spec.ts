/**
 * @vitest-environment node
 */
/**
 * A Skizze may hold one image: the locked page it is traced over (S6,
 * ADR-0150). Every door holds that, and refuses a crafted scene with an
 * external image, an SVG image or any other image: the stored scene, the live
 * wire, the fence a model writes, Piloti's edit, the SVG validator and the
 * slot reader.
 */

import { describe, expect, it } from 'vitest'
import { applySketchEdit, SketchEditError } from './sketch-edit'
import { readSketchFence } from './sketch-fence'
import { outlineSketch } from './sketch-outline'
import { sceneDeltaSchema } from './sketch-room-types'
import { checkSketchScene, SketchSceneError } from './sketch-scene'
import { newUnderlayElement, underlayFileId, underlayProblem, type SketchUnderlay } from './sketch-underlay'
import { liftUnderlayImage, UnderlayImageError, withUnderlayImage } from './sketch-underlay-svg'
import { DiagramSvgError, parseDiagramSvg } from './svg'
import { whitePng } from './__fixtures__/white-png'

const BASE: SketchUnderlay = {
  documentId: '22222222-2222-4222-8222-222222222222',
  versionId: '33333333-3333-4333-8333-333333333333',
  page: 3,
  dpi: 150,
}
const page = newUnderlayElement('page', BASE, { widthPt: 1190.55, heightPt: 841.89 }, 11)
const box = { id: 'room', type: 'rectangle', x: 100, y: 100, width: 200, height: 120, version: 1, versionNonce: 3, isDeleted: false, index: 'a1' }
const scene = (elements: unknown[]) => ({ type: 'excalidraw', elements })

function refusalOf(value: unknown): string | null {
  try {
    checkSketchScene(value)
    return null
  } catch (error) {
    return error instanceof SketchSceneError ? error.message : String(error)
  }
}

/** The crafted images every door must refuse. */
const CRAFTED: [string, Record<string, unknown>][] = [
  ['an image with an external href as its file', { ...page, id: 'x', fileId: 'https://evil.example/plan.png', customData: undefined }],
  ['an svg image', { ...page, id: 'x', fileId: 'svg-1', customData: { underlay: { ...BASE } }, mimeType: 'image/svg+xml' }],
  ['an image that is no underlay', { ...page, id: 'x', customData: undefined }],
  ['an underlay that is not locked', { ...page, id: 'x', locked: false }],
  ['a cropped underlay', { ...page, id: 'x', crop: { x: 0, y: 0, width: 10, height: 10, naturalWidth: 10, naturalHeight: 10 } }],
  ['an underlay whose ids are no uuids', { ...page, id: 'x', fileId: 'underlay-v1-p3-150', customData: { underlay: { ...BASE, documentId: 'plan', versionId: 'v1' } } }],
]

describe('the stored scene', () => {
  it('keeps the one locked page below the strokes, and nothing of its bytes', () => {
    const kept = checkSketchScene(scene([page, box]))
    expect(kept.elements[0]).toMatchObject({ type: 'image', locked: true, fileId: underlayFileId(BASE), customData: { underlay: BASE } })
    expect(underlayProblem(page)).toBeNull()
  })

  it.each(CRAFTED)('refuses %s', (_, image) => {
    expect(refusalOf(scene([image, box]))).toMatch(/^unsupported-element/)
  })

  it('refuses files, a second page, and a page above a drawn element', () => {
    expect(refusalOf({ ...scene([page]), files: { [underlayFileId(BASE)]: { dataURL: 'data:image/png;base64,AAAA' } } })).toBe('has-files')
    expect(refusalOf(scene([page, { ...page, id: 'again' }]))).toMatch(/a second underlay/)
    expect(refusalOf(scene([box, page]))).toMatch(/above a drawn element/)
  })
})

describe('the live wire', () => {
  const delta = (element: unknown) =>
    sceneDeltaSchema.safeParse({ base: BASE.versionId, seq: 0, elements: [{ version: 1, versionNonce: 1, isDeleted: false, index: 'a0', ...(element as object) }] })

  it('carries the page reference', () => {
    expect(delta(page).success).toBe(true)
  })

  it.each(CRAFTED)('refuses %s', (_, image) => {
    expect(delta(image).success).toBe(false)
  })
})

describe('the fence a model writes', () => {
  it('knows no image: Piloti cannot start an underlay', () => {
    const fence = readSketchFence(JSON.stringify({ type: 'excalidraw', elements: [{ type: 'image', id: 'p', x: 0, y: 0, width: 10, height: 10, customData: { underlay: BASE } }] }))
    expect(fence.ok).toBe(false)
  })
})

describe('the edit Piloti proposes', () => {
  const base = checkSketchScene(scene([page, box]))
  const intent = 'Den Raum verschieben'
  const refused = (ops: Parameters<typeof applySketchEdit>[1]) => {
    try {
      applySketchEdit(base, ops, { nonce: () => 7, now: 1 })
      return null
    } catch (error) {
      return error instanceof SketchEditError ? error.refusal : String(error)
    }
  }

  it('refuses an operation that moves, changes or removes the page', () => {
    expect(refused([{ op: 'update', intent, id: 'page', set: { x: 50 } }])).toBe('underlay-locked')
    expect(refused([{ op: 'remove', intent, id: 'page' }])).toBe('underlay-locked')
    expect(refused([{ op: 'align', intent, ids: ['page', 'room'], edge: 'left' }])).toBe('underlay-locked')
  })

  it('lets a box be placed beside the page', () => {
    expect(refused([{ op: 'place', intent, id: 'room', referenceId: 'page', side: 'right' }])).toBeNull()
  })

  it('cannot add an image', () => {
    expect(refused([{ op: 'add', intent, element: { type: 'image', id: 'p2', x: 0, y: 0 } as never }])).not.toBeNull()
  })
})

describe('the outline', () => {
  it('reports what the sketch is drawn on, by ids, with where the page lies', () => {
    expect(outlineSketch(checkSketchScene(scene([page, box]))).underlay).toEqual({ elementId: 'page', ref: BASE, box: { x: 0, y: 0, w: 1191, h: 842 } })
  })
})

describe('the filed SVG', () => {
  const vector =
    '<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" width="400" height="300"><rect x="10" y="10" width="20" height="20"/></svg>'
  const png = whitePng(40, 30)

  it('holds the server’s page in its one slot, which the reader lifts out before the validator', () => {
    const filed = withUnderlayImage(vector, { x: 16, y: 16, width: 368, height: 268, png })
    expect(() => parseDiagramSvg(filed)).toThrow(DiagramSvgError)
    const lifted = liftUnderlayImage(filed)
    expect(lifted.svg).toBe(vector)
    expect(lifted.underlay).toMatchObject({ x: 16, y: 16, width: 368, height: 268 })
    expect(Buffer.from(lifted.underlay?.png ?? []).equals(Buffer.from(png))).toBe(true)
    expect(() => parseDiagramSvg(lifted.svg)).not.toThrow()
  })

  it.each([
    ['an external href', '<image x="0" y="0" width="10" height="10" href="https://evil.example/a.png"/>'],
    ['an svg image', '<image x="0" y="0" width="10" height="10" href="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="/>'],
    ['a png image a client sent', `<image x="0" y="0" width="10" height="10" href="data:image/png;base64,${Buffer.from(png).toString('base64')}"/>`],
    ['a symbol and its use', '<defs><symbol id="image-a"><image href="data:image/png;base64,AAAA"/></symbol></defs><use href="#image-a"/>'],
  ])('refuses %s anywhere but the slot', (_, markup) => {
    const crafted = vector.replace('<rect', `${markup}<rect`)
    expect(liftUnderlayImage(crafted).underlay).toBeNull()
    expect(() => parseDiagramSvg(liftUnderlayImage(crafted).svg)).toThrow(DiagramSvgError)
  })

  it('refuses bytes in the slot that are no PNG, whoever wrote them', () => {
    const forged = vector.replace('<rect', '<image data-underlay="" x="0" y="0" width="10" height="10" preserveAspectRatio="none" href="data:image/png;base64,PHN2Zz48L3N2Zz4="/><rect')
    expect(() => liftUnderlayImage(forged.replace(/(<svg[^>]*>)(.*?)(<image[^>]*\/>)/, '$1$3$2'))).toThrow(UnderlayImageError)
    expect(() => withUnderlayImage(vector, { x: 0, y: 0, width: 10, height: 10, png: new TextEncoder().encode('<svg/>') })).toThrow(UnderlayImageError)
  })
})
