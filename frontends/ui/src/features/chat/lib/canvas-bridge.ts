/**
 * The review canvas asking through the chat's own turn driver.
 *
 * When the review is opened over the chat (the document is the chat's peek),
 * a question asked on the canvas belongs to THAT conversation: it shows in the
 * transcript, and the chat's driver is the only one on its socket. Two drivers
 * on one conversation would race for its turns and leave the transcript stale.
 *
 * The driver lives inside `useWebSocketChat` (one instance, in the composer),
 * so it registers a sender here, the way `registerStopStreamingHandler` lets
 * the store reach it, and the canvas (`features/documents/hooks/use-canvas-ask`)
 * asks through it. No store and no React: both sides import this file only.
 */

import type { ChatEffort } from '@/lib/reasoning-settings/catalog'
import type { DocumentVersionState } from '@/lib/documents/lifecycle-types'

/** A box on a page, shares of it, top-left origin; `annotation_id` names the Anmerkung it belongs to. */
export interface CanvasFocusRegion {
  page: number
  x: number
  y: number
  w: number
  h: number
  annotation_id?: string
}

/** What a canvas question tells the turn beyond its text: the document, and where on it. */
export interface CanvasFocus {
  documentId: string
  fileName: string | null
  versionId: string | null
  versionState: DocumentVersionState | null
  shelf: 'session' | 'project' | 'archiv' | null
  /** Null: the whole document. */
  region: CanvasFocusRegion | null
  replyInThread: boolean
}

export interface CanvasChatQuestion {
  text: string
  focus: CanvasFocus
  effort?: ChatEffort
}

/** The turn a question opened, in the chat store's `turns`; null when it did not open one. */
export type CanvasChatSender = (question: CanvasChatQuestion) => { conversationId: string; turnId: string } | null

let sender: CanvasChatSender | null = null

/** The chat's driver offers itself. Returns the withdrawal, which leaves a later registration alone. */
export const registerCanvasChatSender = (next: CanvasChatSender): (() => void) => {
  sender = next
  return () => {
    if (sender === next) sender = null
  }
}

/** The chat's sender, while a chat composer is mounted. */
export const canvasChatSender = (): CanvasChatSender | null => sender

/** A note for the chat's running turn: its text and, when one was drawn meanwhile, the box. */
export interface CanvasChatSteer {
  text: string
  focusRegion?: CanvasFocusRegion | null
  /** The turn never read it: what to ask instead once it has ended. */
  onLeftover?: (text: string) => void
}

/** Steer the chat's running turn; false when there is none or its server reads no notes. */
export type CanvasChatSteerer = (request: CanvasChatSteer) => boolean

let steerer: CanvasChatSteerer | null = null

/** The chat's driver offers its `steer`. Returns the withdrawal, which leaves a later registration alone. */
export const registerCanvasChatSteerer = (next: CanvasChatSteerer): (() => void) => {
  steerer = next
  return () => {
    if (steerer === next) steerer = null
  }
}

/** The chat's steerer, while a chat composer is mounted. */
export const canvasChatSteerer = (): CanvasChatSteerer | null => steerer

/**
 * The region as the server accepts it: on its page, with `x + w` and `y + h`
 * at most 1. Rounding a dragged box to four decimals can overshoot the edge
 * by a hair, and the server refuses the whole question for that.
 */
export function clampFocusRegion<R extends { x: number; y: number; w: number; h: number }>(region: R): R {
  const x = Math.min(Math.max(region.x, 0), 1)
  const y = Math.min(Math.max(region.y, 0), 1)
  const w = Math.max(Math.min(region.w, 1 - x), 0.0001)
  const h = Math.max(Math.min(region.h, 1 - y), 0.0001)
  return { ...region, x: Math.min(x, 1 - w), y: Math.min(y, 1 - h), w, h }
}
