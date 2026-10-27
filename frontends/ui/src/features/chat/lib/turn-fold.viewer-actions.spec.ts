/**
 * The fold keeps Piloti's viewer actions (ADR-0144) for the driver to hand on:
 * in order, once each, and none after the reader stopped the turn.
 */
import { describe, expect, it } from 'vitest'
import { wireEvents } from '@/test-utils/wire-v2-fixtures'
import { foldTurnEvents, stopTurnView, type TurnView } from './turn-fold'

const recorded = wireEvents('turn-viewer-action.jsonl')
const fold = (events = recorded): TurnView => foldTurnEvents(undefined, events)!

describe('viewer actions in the fold', () => {
  it('are kept in arrival order, every one the allow-list has', () => {
    expect(fold().viewerActions?.map((call) => call.tool_call_name)).toEqual([
      'highlight_passage',
      'highlight_region',
      'compare_revisions',
      'focus_ifc_element',
      'open_document',
    ])
  })

  it('reads a call twice as one (a replayed frame)', () => {
    const second = recorded[1]!
    const replayed = { ...second, seq: 2 }
    const view = foldTurnEvents(fold(recorded.slice(0, 2)), [replayed])!
    expect(view.viewerActions).toHaveLength(1)
  })

  it('takes none after the reader pressed Stop on this page', () => {
    const before = fold(recorded.slice(0, 1))
    const stopped = stopTurnView(before, '').view
    const after = foldTurnEvents(stopped, recorded.slice(1, 3))!
    expect(after.viewerActions).toBeUndefined()
  })
})
