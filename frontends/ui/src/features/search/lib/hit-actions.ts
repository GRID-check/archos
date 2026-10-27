/**
 * What a document hit offers besides opening it: the ways from a search into
 * the rest of the workspace. One entry list (`ActionMenu`), so the result
 * list, the register and the phone's stack draw the same menu.
 *
 * - „Piloti fragen": a chat about this file, through the product's one ask
 *   (`askAboutFile`). Only for a project's document: a chat lives in a
 *   project, and the Büroablage has no chat of its own to start it in.
 * - „Aktuelle Fassung öffnen": only on a superseded hit. The hit knows that a
 *   newer Fassung exists (the projection's `superseded`), not which one; the
 *   caller asks the document's status for it when the item is chosen.
 * - „Offene Punkte": the document's Prüfansicht, where its open marks are.
 *
 * Pure: the caller hands in the labels and what each item does.
 */

import { History, MessageSquareWarning, Sparkles } from 'lucide-react'

import type { ActionMenuEntry } from '@/components/ui/action-menu'
import type { DocumentHit } from '@/lib/search/search-wire'

export type DocumentHitAction = 'ask' | 'openCurrent' | 'openPoints'

export interface DocumentHitActionLabels {
  ask: string
  openCurrent: string
  openPoints: string
}

export interface DocumentHitActionHandlers {
  onAsk: () => void
  onOpenCurrent: () => void
  onOpenPoints: () => void
}

/** Which actions a hit offers, in the menu's order. */
export function documentHitActions(hit: Pick<DocumentHit, 'shelf' | 'projectId' | 'superseded'>): DocumentHitAction[] {
  return [
    ...(hit.shelf === 'project' && hit.projectId ? (['ask'] as const) : []),
    ...(hit.superseded ? (['openCurrent'] as const) : []),
    'openPoints' as const,
  ]
}

const ICONS = { ask: Sparkles, openCurrent: History, openPoints: MessageSquareWarning } as const

export function documentHitActionEntries(
  hit: Pick<DocumentHit, 'id' | 'shelf' | 'projectId' | 'superseded'>,
  labels: DocumentHitActionLabels,
  handlers: DocumentHitActionHandlers
): ActionMenuEntry[] {
  const run: Record<DocumentHitAction, () => void> = {
    ask: handlers.onAsk,
    openCurrent: handlers.onOpenCurrent,
    openPoints: handlers.onOpenPoints,
  }
  return documentHitActions(hit).map((action) => ({
    type: 'item' as const,
    id: action,
    label: labels[action],
    icon: ICONS[action],
    onSelect: run[action],
    testId: `search-hit-action-${action}`,
  }))
}
