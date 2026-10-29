/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { reviseScene, withoutTombstones } from './sketch-revise'
import type { SketchScene } from './sketch-scene'

const scene = (elements: Array<Record<string, unknown>>): SketchScene => ({ type: 'excalidraw', elements: elements as never })
const box = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: 'rectangle', x: 0, y: 0, version: 2, versionNonce: 10, ...extra })
let n = 100
const nonce = () => ++n

describe('reviseScene', () => {
  it('changes nothing an editor save already versioned', () => {
    const stored = scene([box('a'), box('b')])
    const next = scene([box('a', { x: 5, version: 3, versionNonce: 11 }), box('b')])
    const revised = reviseScene(stored, next, nonce)
    expect(revised.scene.elements).toEqual(next.elements)
    expect(revised).toMatchObject({ bumped: 0, tombstoned: 0 })
  })

  it('gives a change at the version read the next version and a fresh nonce', () => {
    const revised = reviseScene(scene([box('a')]), scene([box('a', { x: 40 })]), nonce, 7)
    expect(revised.scene.elements[0]).toMatchObject({ x: 40, version: 3, updated: 7 })
    expect(revised.scene.elements[0].versionNonce).not.toBe(10)
    expect(revised.bumped).toBe(1)
  })

  it('versions an element that came without a version', () => {
    const revised = reviseScene(scene([]), scene([{ id: 'new', type: 'ellipse', x: 1, y: 1 }]), nonce)
    expect(revised.scene.elements[0]).toMatchObject({ version: 1, versionNonce: expect.any(Number) })
  })

  it('keeps an element the save left out as a tombstone with the next version, once', () => {
    const stored = scene([box('a'), box('gone', { version: 4 }), box('dead', { isDeleted: true })])
    const next = scene([box('a')])
    const revised = reviseScene(stored, next, nonce)
    expect(revised.scene.elements.map((element) => [element.id, element.isDeleted ?? false, element.version])).toEqual([
      ['a', false, 2],
      ['gone', true, 5],
    ])
    expect(withoutTombstones(revised, next).elements).toEqual(next.elements)
  })
})
