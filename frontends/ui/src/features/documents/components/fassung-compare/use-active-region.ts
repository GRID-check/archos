'use client'

import { useCallback, useMemo, useReducer } from 'react'

/**
 * Which change the reader is looking at, shared by the boxes on the sheet, the
 * list beside it and anything else that names a change by its number.
 *
 * Two inputs, one answer. Hovering or focusing a box or a row PREVIEWS it, for
 * as long as the pointer or focus stays; clicking PINS it, and the pin outlives
 * the pointer leaving. `active` is the preview when there is one and the pin
 * otherwise, so every part highlights the same number and none of them keeps
 * a highlight of its own.
 */
export interface ActiveRegion {
  /** The change every part highlights now, or null. */
  active: number | null
  /** The change the reader clicked, or null. Only this one is `aria-current`. */
  pinned: number | null
  /** Preview a change (hover, focus), or end the preview with null. */
  preview: (number: number | null) => void
  /** Pin a change, or clear the pin with null. */
  pin: (number: number | null) => void
}

interface State {
  previewed: number | null
  pinned: number | null
}

type Action = { type: 'preview'; number: number | null } | { type: 'pin'; number: number | null }

function reduce(state: State, action: Action): State {
  if (action.type === 'preview') {
    return state.previewed === action.number ? state : { ...state, previewed: action.number }
  }
  return state.pinned === action.number ? state : { ...state, pinned: action.number }
}

export function useActiveRegion(): ActiveRegion {
  const [state, dispatch] = useReducer(reduce, { previewed: null, pinned: null })
  const preview = useCallback((number: number | null) => dispatch({ type: 'preview', number }), [])
  const pin = useCallback((number: number | null) => dispatch({ type: 'pin', number }), [])
  return useMemo(
    () => ({ active: state.previewed ?? state.pinned, pinned: state.pinned, preview, pin }),
    [state, preview, pin],
  )
}
