/**
 * @vitest-environment node
 */
/**
 * A Skizze's words in the document room: an element travels with what the
 * merge reads and everything else passed through; an image, an embed and an
 * oversized delta do not travel; a reader's post cannot name who it is.
 */

import { describe, expect, it } from 'vitest'
import { roomEventSchema, roomPostSchema } from '@/lib/annotations/room-types'
import { SKETCH_DELTA_MAX_BYTES, SKETCH_DELTA_MAX_ELEMENTS, sketchEventsOf } from './sketch-room-types'

const DOC_PLAN = '22222222-2222-4222-8222-222222222222'

const element = { id: 'el_1', type: 'ellipse', version: 4, versionNonce: -12, isDeleted: false, index: 'a1', x: 3, strokeColor: '#1e1e1e' }
const post = (msg: Record<string, unknown>) => roomPostSchema.safeParse({ peerId: 'peer_abcdef12', ...msg })
const PEER = { peerId: 'peer_abcdef12', userId: 'user_1', name: 'Anna', kind: 'person' as const }

describe('the sketch vocabulary', () => {
  it('passes an element’s other fields through untouched', () => {
    const parsed = post({ delta: { base: 'ver_1', seq: 1, elements: [element] } })
    expect(parsed.success && parsed.data.delta?.elements[0]).toEqual(element)
  })

  it('refuses images, embeds, elements without a version, and deltas past either cap', () => {
    for (const type of ['image', 'embeddable', 'iframe', 'magicframe', 'anything']) {
      expect(post({ delta: { base: null, seq: 0, elements: [{ ...element, type }] } }).success).toBe(false)
    }
    const { versionNonce: _nonce, ...noNonce } = element
    expect(post({ delta: { base: null, seq: 0, elements: [noNonce] } }).success).toBe(false)
    const many = Array.from({ length: SKETCH_DELTA_MAX_ELEMENTS + 1 }, (_, i) => ({ ...element, id: `el_${i}` }))
    expect(post({ delta: { base: null, seq: 0, elements: many } }).success).toBe(false)
    const heavy = { ...element, text: 'x'.repeat(SKETCH_DELTA_MAX_BYTES) }
    expect(post({ delta: { base: null, seq: 0, elements: [heavy] } }).success).toBe(false)
  })

  it('drops on the wire what a save drops: a link and foreign customData', () => {
    const parsed = post({ delta: { base: 'ver_1', seq: 1, elements: [{ ...element, link: 'https://x.example', customData: { a: 1 } }] } })
    expect(parsed.success && parsed.data.delta?.elements[0]).toEqual(element)
    const event = roomEventSchema.parse({ kind: 'scene.delta', peer: PEER, base: null, seq: 1, elements: [{ ...element, link: 'https://x.example' }] })
    expect(event.kind === 'scene.delta' && event.elements[0]).toEqual(element)
  })

  it('carries a link into the workspace live, as a save keeps it', () => {
    const customData = { documentId: DOC_PLAN, page: 12 }
    const parsed = post({ delta: { base: 'ver_1', seq: 1, elements: [{ ...element, customData: { ...customData, taskId: 't' } }] } })
    expect(parsed.success && parsed.data.delta?.elements[0]).toEqual({ ...element, customData })
  })

  it('refuses a full part past its last, and a selection longer than its cap', () => {
    expect(post({ delta: { base: null, seq: 0, full: { requestId: 'req_abcdef12', part: 2, of: 2 }, elements: [] } }).success).toBe(false)
    expect(post({ sceneSelection: Array.from({ length: 501 }, (_, i) => `el_${i}`) }).success).toBe(false)
  })

  it('turns each field into its event, stamped with the sender, and each event parses as a room event', () => {
    const events = sketchEventsOf(
      {
        scene: { pointer: { x: 1, y: 2 }, tool: 'pointer', button: 'up' },
        sceneSelection: ['el_1'],
        delta: { base: 'ver_1', seq: 3, elements: [element] },
        hash: { base: 'ver_1', sceneHash: 77, count: 1 },
        want: { requestId: 'req_abcdef12', base: 'ver_1' },
        saved: { versionId: 'ver_2', sceneHash: 77 },
      },
      PEER
    )
    expect(events.map((event) => event.kind)).toEqual([
      'scene.pointer',
      'scene.selection',
      'scene.delta',
      'scene.hash',
      'scene.want',
      'scene.saved',
    ])
    for (const event of events) expect(roomEventSchema.parse(event)).toEqual(event)
  })
})
