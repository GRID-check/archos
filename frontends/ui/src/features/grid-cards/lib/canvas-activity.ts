/**
 * What Piloti did on a document's canvas, as the chat card reads it.
 *
 * The `canvas_activity` card is system-emitted: Piloti's canvas tools (`src/aiq_agent/tools/canvas/`)
 * push it after Piloti proposed marks, set, changed or deleted one at the
 * person's request, or replied in a thread, and the model cannot author one.
 * Every id on it is one the annotations service returned.
 *
 * ## The local type
 *
 * These interfaces mirror `CanvasActivityCard` in
 * `src/aiq_agent/cards/models.py` field for field. They exist so the component
 * reads a shape it owns, and the generated Zod output (`shared/cards/generated.ts`,
 * from `npm run generate:cards`) is assignable to it: `w`/`h` arrive there as
 * `number | null`, which these accept.
 *
 * ## The decision is per mark, and the mark records it
 *
 * A card can carry up to twenty proposals, and each one is taken over or
 * discarded on its own: the office keeps the stair finding and drops the
 * door. The answer is a write to the mark (ADR-0105), so the mark is the
 * record and the card is `live` (`card-decision.ts`). Messages stored before
 * that kept the answer per mark under `itemDecisionKey` on
 * `ChatMessage.cardInteractions` (ADR-0030); those still draw, read-only, as a
 * fallback while the live list has not said anything else. The live status
 * beats the stored decision whenever it is known: a colleague may have taken
 * the mark over on the canvas, and the card must say so rather than offer the
 * button again.
 */

import type {
  AnnotationAuthor,
  AnnotationKind,
  AnnotationStatus,
  UpdateAnnotationRequest,
} from '@/lib/annotations/types'
import type { CardDecision } from '../card-decision'

/** A mark Piloti set on a page, waiting for a person to take it over. */
export interface CanvasProposedItem {
  action: 'proposed'
  annotation_id: string
  number: number
  page: number
  shape: 'point' | 'region'
  /** Normalized 0..1, origin top left: the `PageRegion` frame. */
  x: number
  y: number
  w?: number | null
  h?: number | null
  kind: AnnotationKind
  body: string
}

/** A mark Piloti set because the person asked for it: open at once, in the person's name. */
export interface CanvasCreatedItem extends Omit<CanvasProposedItem, 'action'> {
  action: 'created'
}

/** One field a change moved. An absent `before`/`after` is an empty field (no assignee, no date). */
export interface CanvasFieldChange {
  field: 'status' | 'assignee' | 'due_on' | 'kind' | 'body'
  before?: string | null
  after?: string | null
  /** The assignee's name, beside their id. */
  before_label?: string | null
  after_label?: string | null
}

/** A change Piloti made to a mark because the person asked, and the note it left in the thread. */
export interface CanvasChangedItem {
  action: 'changed'
  annotation_id: string
  number: number
  /** The mark's status after the change: what an undo expects to find. */
  status: AnnotationStatus
  changes: CanvasFieldChange[]
  note: string
}

/** A mark Piloti deleted because the person who set it asked. Gone with its thread. */
export interface CanvasDeletedItem {
  action: 'deleted'
  number: number
  body: string
}

/** An answer Piloti posted into a mark's thread. */
export interface CanvasRepliedItem {
  action: 'replied'
  annotation_id: string
  number: number
  excerpt: string
}

export type CanvasActivityItem =
  | CanvasProposedItem
  | CanvasCreatedItem
  | CanvasChangedItem
  | CanvasDeletedItem
  | CanvasRepliedItem

/** A mark Piloti put on the page: proposed, or set at the person's request. */
export type CanvasSetItem = CanvasProposedItem | CanvasCreatedItem

export interface CanvasActivityDocument {
  id: string
  name: string
}

export const isProposed = (item: CanvasActivityItem): item is CanvasProposedItem => item.action === 'proposed'
export const isSet = (item: CanvasActivityItem): item is CanvasSetItem =>
  item.action === 'proposed' || item.action === 'created'

/** The mark an item points at on the document; none for a deleted one. */
export const annotationIdOf = (item: CanvasActivityItem): string | null =>
  item.action === 'deleted' ? null : item.annotation_id

/** Where one mark stands, as the card shows it. */
export type MarkState = AnnotationStatus | 'gone'

/** The newest answer in a mark's thread, as the row tells it at a glance. */
export interface LastReply {
  authorKind: AnnotationAuthor
  /** The author's name as the directory has it; null for Piloti, or when it does not know them. */
  authorName: string | null
  body: string
}

/** What the card knows about a mark from the live list. */
export interface LiveMark {
  status: AnnotationStatus
  /** Whether this reader may take it over or discard it. */
  canEdit: boolean
  /** Who took it over, when somebody did. */
  acceptedByName: string | null
  /** Who closed it (resolved or discarded), when somebody did. */
  closedByName: string | null
  /** The fields a change can move, to tell whether a change still stands as Piloti left it. */
  assigneeUserId: string | null
  dueOn: string | null
  kind: AnnotationKind
  body: string
  /** How many replies the mark's thread holds. */
  replyCount: number
  /** The newest reply, or null for a thread with none. */
  lastReply: LastReply | null
}

/**
 * The first words of a text, for a one-line glance: whitespace collapsed, cut
 * at a word boundary at or before `max` characters, with an ellipsis when cut.
 */
export function firstWords(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  const cut = flat.slice(0, max)
  const boundary = cut.lastIndexOf(' ')
  return `${(boundary > max / 2 ? cut.slice(0, boundary) : cut).replace(/[\s.,;:!?-]+$/, '')}…`
}

/**
 * The state a proposed mark is drawn in.
 *
 * The live list wins when it says anything other than „proposed": it is the
 * canvas's truth, and a mark a colleague took over a minute ago is taken over
 * whatever this message remembers. While it still says „proposed" (or has not
 * loaded), the stored decision is the reader's own answer and holds: a mark
 * never goes back to proposed, so a decision recorded here with a live
 * „proposed" can only mean the list was read before the write.
 */
export function markState(decision: CardDecision | null, live: LiveMark | 'gone' | undefined): MarkState {
  if (live === 'gone') return 'gone'
  if (live && live.status !== 'proposed') return live.status
  if (decision === 'accepted') return 'open'
  if (decision === 'rejected') return 'dismissed'
  return 'proposed'
}

/**
 * Where a mark Piloti set at the person's request stands: open unless the
 * canvas says otherwise. There is no answer to give, so no stored decision.
 */
export function createdState(live: LiveMark | 'gone' | undefined): MarkState {
  if (live === 'gone') return 'gone'
  return live ? live.status : 'open'
}

/** How many of each act the card holds, and the one thread replied in. Changed marks count once each. */
export function activityCounts(items: readonly CanvasActivityItem[]): {
  proposed: number
  created: number
  changed: number
  deleted: number
  replied: number
  /** The number of the mark replied to, when every reply went to one thread. */
  repliedNumber: number | null
} {
  const replies = items.filter((item) => item.action === 'replied')
  const threads = new Set(replies.map((item) => item.number))
  const changed = new Set(items.filter((item) => item.action === 'changed').map((item) => item.number))
  return {
    proposed: items.filter((item) => item.action === 'proposed').length,
    created: items.filter((item) => item.action === 'created').length,
    changed: changed.size,
    deleted: items.filter((item) => item.action === 'deleted').length,
    replied: threads.size,
    repliedNumber: threads.size === 1 ? replies[0].number : null,
  }
}

const isKind = (value: string | null | undefined): value is AnnotationKind =>
  value === 'hint' || value === 'question' || value === 'defect'

/** The statuses a person's PATCH can move between in both directions: the only status changes an undo reverses. */
const isReversible = (value: string | null | undefined): value is 'open' | 'resolved' =>
  value === 'open' || value === 'resolved'

/**
 * The PATCH that puts a change back, or null when a person's PATCH cannot.
 *
 * Taking a proposal over and dismissing one have no way back to `proposed`,
 * and `open → dismissed` is not a move, so those changes are not undone here;
 * resolving and reopening are. `expectedStatus` is the status Piloti left, so
 * a colleague's move since is a 409 rather than undone.
 */
export function undoRequest(item: CanvasChangedItem): UpdateAnnotationRequest | null {
  const request: UpdateAnnotationRequest = { expectedStatus: item.status }
  for (const change of item.changes) {
    const before = change.before ?? null
    if (change.field === 'status') {
      if (!isReversible(before) || !isReversible(change.after)) return null
      request.status = before
    } else if (change.field === 'assignee') {
      request.assigneeUserId = before
    } else if (change.field === 'due_on') {
      request.dueOn = before
    } else if (change.field === 'kind') {
      if (!isKind(before)) return null
      request.kind = before
    } else {
      if (!before) return null
      request.body = before
    }
  }
  return request
}

/** Whether the mark still stands as Piloti's change left it: an undo of anything else would undo a colleague. */
export function stillAsLeft(item: CanvasChangedItem, live: LiveMark): boolean {
  if (live.status !== item.status) return false
  return item.changes.every((change) => {
    const after = change.after ?? null
    if (change.field === 'status') return true
    if (change.field === 'assignee') return live.assigneeUserId === after
    if (change.field === 'due_on') return live.dueOn === after
    if (change.field === 'kind') return live.kind === after
    return live.body === after
  })
}

/** A box's place on the page, in CSS percent; a point is a place with no size. */
export function placeStyle(item: Pick<CanvasProposedItem, 'shape' | 'x' | 'y' | 'w' | 'h'>): {
  left: string
  top: string
  width?: string
  height?: string
} {
  const pct = (value: number) => `${Math.min(1, Math.max(0, value)) * 100}%`
  if (item.shape !== 'region' || !item.w || !item.h) return { left: pct(item.x), top: pct(item.y) }
  return { left: pct(item.x), top: pct(item.y), width: pct(item.w), height: pct(item.h) }
}
