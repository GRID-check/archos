/**
 * The server's change record, matched to the rows of a `canvas_activity` card
 * (ADR-0109).
 *
 * A card row is what the turn REMEMBERED; a `agent_changes` row is what is
 * true now: who the turn acted for, whether somebody undid it, whether the
 * reader may undo it. Where a row has a change, the change wins; where it has
 * none (an answer older than the record, a failed request) the card's own
 * copy stands.
 *
 * Pure, so the pairing is specced without a component.
 */

import type { AgentChangeView } from '@/lib/changes/types'
import type { CanvasActivityItem, LiveMark } from './canvas-activity'

/** The kind of change the server records for each row of the card. */
const queueKey = (objectKind: string, op: string, annotationId: string): string =>
  `${objectKind}:${op}:${annotationId}`

/**
 * The server change behind each row, by the row's index in `items`.
 *
 * Rows pair with changes in the order the turn made them (the server answers
 * oldest first), per mark and kind of change: two changes to one mark are two
 * rows. A deleted row carries no id, and the change's mark number is null once
 * the mark is gone, so deletions pair by order, and only when the card and the
 * record agree on how many there were; a guess between two deletions could
 * offer the wrong one's undo.
 */
export function matchChanges(
  items: readonly CanvasActivityItem[],
  changes: readonly AgentChangeView[] | null
): ReadonlyMap<number, AgentChangeView> {
  const matched = new Map<number, AgentChangeView>()
  if (!changes || changes.length === 0) return matched

  const queues = new Map<string, AgentChangeView[]>()
  for (const change of changes) {
    const key = queueKey(change.objectKind, change.op, change.annotationId)
    queues.set(key, [...(queues.get(key) ?? []), change])
  }
  const deletions = changes.filter((change) => change.objectKind === 'annotation' && change.op === 'delete')
  const deletedRows = items.filter((item) => item.action === 'deleted').length

  let nextDeletion = 0
  items.forEach((item, index) => {
    let change: AgentChangeView | undefined
    if (item.action === 'proposed' || item.action === 'created') {
      change = queues.get(queueKey('annotation', 'create', item.annotation_id))?.shift()
    } else if (item.action === 'changed') {
      change = queues.get(queueKey('annotation', 'update', item.annotation_id))?.shift()
    } else if (item.action === 'replied') {
      change = queues.get(queueKey('annotation_reply', 'create', item.annotation_id))?.shift()
    } else if (deletions.length === deletedRows) {
      change = deletions[nextDeletion++]
    }
    if (change) matched.set(index, change)
  })
  return matched
}

/**
 * Whether the mark still stands as the change left it, judged by the fields
 * its `after` names. Only the label under a row needs this ("changed since");
 * whether undo is offered is the server's `canUndo`, never this.
 */
export function standsAsChanged(change: AgentChangeView, live: LiveMark): boolean {
  const after = change.after
  if (!after) return true
  const same = (key: string, value: unknown) => !(key in after) || (after[key] ?? null) === (value ?? null)
  return (
    same('status', live.status) &&
    same('body', live.body) &&
    same('kind', live.kind) &&
    same('assigneeUserId', live.assigneeUserId) &&
    same('dueDate', live.dueOn)
  )
}
