/**
 * Pairing the server's change record with the card's rows (ADR-0109): per mark
 * and kind of change, in the order the turn made them; deletions only when the
 * card and the record agree on how many there were.
 */
import { describe, expect, it } from 'vitest'
import type { PilotiChangeView } from '@/lib/changes/types'
import type { CanvasActivityItem } from './canvas-activity'
import { matchChanges, standsAsChanged } from './canvas-changes'

const change = (id: string, patch: Partial<PilotiChangeView> = {}): PilotiChangeView => ({
  id,
  documentId: 'doc',
  annotationId: 'ann-4',
  annotationNumber: 4,
  objectKind: 'annotation',
  objectId: 'ann-4',
  op: 'update',
  before: null,
  after: null,
  onBehalfOf: 'user_miriam',
  onBehalfOfName: 'Miriam',
  createdAt: '2026-10-13T08:00:00.000Z',
  undoneAt: null,
  undoneBy: null,
  undoneByName: null,
  canUndo: true,
  ...patch,
})

const changed = (note: string): CanvasActivityItem => ({
  action: 'changed',
  annotation_id: 'ann-4',
  number: 4,
  status: 'open',
  changes: [],
  note,
})
const deleted = (number: number): CanvasActivityItem => ({ action: 'deleted', number, body: 'x' })

describe('matchChanges', () => {
  it('pairs two changes to one mark in order', () => {
    const matched = matchChanges([changed('a'), changed('b')], [change('first'), change('second')])
    expect(matched.get(0)?.id).toBe('first')
    expect(matched.get(1)?.id).toBe('second')
  })

  it('leaves a row without a change out, so the card’s copy stands', () => {
    expect(matchChanges([changed('a')], []).size).toBe(0)
    expect(matchChanges([changed('a')], null).size).toBe(0)
    expect(matchChanges([changed('a'), changed('b')], [change('only')]).has(1)).toBe(false)
  })

  it('does not mix a reply with a change on the same mark', () => {
    const reply = change('reply', { objectKind: 'annotation_reply', op: 'create' })
    const matched = matchChanges([changed('a')], [reply])
    expect(matched.size).toBe(0)
  })

  it('pairs deletions by order, and only when the counts agree', () => {
    const removals = [
      change('d1', { op: 'delete', annotationNumber: null, annotationId: 'g1' }),
      change('d2', { op: 'delete', annotationNumber: null, annotationId: 'g2' }),
    ]
    expect(matchChanges([deleted(5), deleted(6)], removals).get(1)?.id).toBe('d2')
    expect(matchChanges([deleted(5)], removals).size).toBe(0)
  })
})

describe('standsAsChanged', () => {
  const live = {
    status: 'resolved',
    canEdit: true,
    acceptedByName: null,
    closedByName: null,
    assigneeUserId: null,
    dueOn: null,
    kind: 'defect',
    body: 'x',
  } as const

  it('compares only the fields the change named', () => {
    expect(standsAsChanged(change('c', { after: { status: 'resolved' } }), live)).toBe(true)
    expect(standsAsChanged(change('c', { after: { status: 'open' } }), live)).toBe(false)
    expect(standsAsChanged(change('c', { after: { assigneeUserId: 'user_anna' } }), live)).toBe(false)
  })
})
