/**
 * The capture made honest for a strict wire: `truncated` never leaves the
 * viewer, and a view the lists cannot hold says so.
 */

import { describe, expect, it } from 'vitest'
import { viewpointInputSchema } from '@/lib/annotations/viewpoint-types'
import type { CapturedViewpoint } from './viewpoint'
import { finalizeCapture, firstRestoredSelection } from './viewpoint-bridge'

const A = '0AAAAAAAAAAAAAAAAAAAA1'
const B = '0AAAAAAAAAAAAAAAAAAAA2'

function captured(truncated: CapturedViewpoint['truncated']): CapturedViewpoint {
  return {
    camera: {
      type: 'perspective',
      position: { x: 10, y: -20, z: 5 },
      direction: { x: 0, y: 1, z: 0 },
      up: { x: 0, y: 0, z: 1 },
      fieldOfView: 50,
      aspectRatio: 1.6,
    },
    clippingPlanes: [{ location: { x: 0, y: 0, z: 1 }, direction: { x: 0, y: 0, z: 1 } }],
    components: {
      selection: { globalIds: [A] },
      visibility: { defaultVisibility: false, exceptions: [A, B] },
      coloring: [],
    },
    truncated,
  }
}

describe('finalizeCapture', () => {
  it('sends exactly what the strict wire takes: no `truncated`', () => {
    const { viewpoint, notices } = finalizeCapture(captured({ selection: false, exceptions: false }), {
      pin: { point: { x: 1, y: 2, z: 3 }, globalId: A },
      snapshot: { contentType: 'image/jpeg', dataBase64: 'QUFB' },
    })
    expect(viewpoint).not.toHaveProperty('truncated')
    expect(viewpointInputSchema.safeParse(viewpoint).success).toBe(true)
    expect(viewpoint.pin).toEqual({ point: { x: 1, y: 2, z: 3 }, globalId: A })
    expect(viewpoint.components.visibility).toEqual({ defaultVisibility: false, exceptions: [A, B] })
    expect(notices).toEqual({ selectionCut: false, visibilityDropped: false, noSnapshot: false })
  })

  it('leaves out a pin and a picture it does not have, and says the picture is missing', () => {
    const { viewpoint, notices } = finalizeCapture(captured({ selection: false, exceptions: false }), { pin: null, snapshot: null })
    expect(viewpoint).not.toHaveProperty('pin')
    expect(viewpoint).not.toHaveProperty('snapshot')
    expect(viewpointInputSchema.safeParse(viewpoint).success).toBe(true)
    expect(notices.noSnapshot).toBe(true)
  })

  it('shows the whole model rather than part of an isolation it could not list', () => {
    const { viewpoint, notices } = finalizeCapture(captured({ selection: true, exceptions: true }), {})
    expect(viewpoint.components.visibility).toEqual({ defaultVisibility: true, exceptions: [] })
    expect(viewpoint.components.selection.globalIds).toEqual([A])
    expect(notices).toEqual({ selectionCut: true, visibilityDropped: true, noSnapshot: true })
  })
})

describe('firstRestoredSelection', () => {
  it('is the first selected element this model has', () => {
    expect(firstRestoredSelection([B, A], new Map([[A, 11]]))).toBe(A)
    expect(firstRestoredSelection([B], new Map([[A, 11]]))).toBeNull()
  })
})
