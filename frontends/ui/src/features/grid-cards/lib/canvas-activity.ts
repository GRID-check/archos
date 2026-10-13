/**
 * What Piloti did on a document's canvas, as the chat card reads it.
 *
 * The `canvas_activity` card is system-emitted: Piloti's canvas tools (`src/aiq_agent/tools/canvas/`)
 * pushes it after it proposed marks or replied in a thread, and the model
 * cannot author one. Every id on it is one the annotations service returned.
 *
 * ## The local type
 *
 * These interfaces mirror `CanvasActivityCard` in
 * `src/aiq_agent/cards/models.py` field for field. They exist so the component
 * reads a shape it owns, and the generated Zod output (`shared/cards/generated.ts`,
 * from `npm run generate:cards`) is assignable to it: `w`/`h` arrive there as
 * `number | null`, which these accept.
 *
 * ## The decision is per mark
 *
 * A card can carry up to twenty proposals, and each one is taken over or
 * discarded on its own: the office keeps the stair finding and drops the
 * door. So the decision is stored per mark, under `itemDecisionKey`
 * (`card-decision.ts`), on the same `ChatMessage.cardInteractions` map every
 * interactive card writes (ADR-0030). The live status beats the stored
 * decision whenever it is known:
 * a colleague may have taken the mark over on the canvas, and the card must
 * say so rather than offer the button again.
 */

import type { AnnotationKind, AnnotationStatus } from '@/lib/annotations/types'
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

/** An answer Piloti posted into a mark's thread. */
export interface CanvasRepliedItem {
  action: 'replied'
  annotation_id: string
  number: number
  excerpt: string
}

export type CanvasActivityItem = CanvasProposedItem | CanvasRepliedItem

export interface CanvasActivityDocument {
  id: string
  name: string
}

export const isProposed = (item: CanvasActivityItem): item is CanvasProposedItem => item.action === 'proposed'

/** Where one mark stands, as the card shows it. */
export type MarkState = AnnotationStatus | 'gone'

/** What the card knows about a mark from the live list. */
export interface LiveMark {
  status: AnnotationStatus
  /** Whether this reader may take it over or discard it. */
  canEdit: boolean
  /** Who took it over, when somebody did. */
  acceptedByName: string | null
  /** Who closed it (resolved or discarded), when somebody did. */
  closedByName: string | null
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

/** How many of the card's items are proposals and how many are replies, and the one thread replied in. */
export function activityCounts(items: readonly CanvasActivityItem[]): {
  proposed: number
  replied: number
  /** The number of the mark replied to, when every reply went to one thread. */
  repliedNumber: number | null
} {
  const replies = items.filter((item) => item.action === 'replied')
  const threads = new Set(replies.map((item) => item.number))
  return {
    proposed: items.length - replies.length,
    replied: threads.size,
    repliedNumber: threads.size === 1 ? replies[0].number : null,
  }
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
