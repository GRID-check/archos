/**
 * What a document hit offers: the ways from a search into the rest of the
 * workspace. One entry list (`ActionMenu`), so the result list, the register
 * and the phone's stack draw the same menu. The order is the Dateien row
 * menu's (`documentActionEntries`): open and ask first, what you came to do;
 * then where the document stands; then passing it on.
 *
 * - „Öffnen": where the row's own link goes, at the passage when the hit was
 *   found by one. A menu that lists what the row can do lists this too, so
 *   Shift+F10 from the field reaches it beside the rest.
 * - „Piloti fragen": a chat about this file, through the product's one ask
 *   (`askAboutFile`). Only for a project's document: a chat lives in a
 *   project, and the Büroablage has no chat of its own to start it in.
 * - „Aktuelle Fassung öffnen": only on a superseded hit. The hit knows that a
 *   newer Fassung exists (the projection's `superseded`), not which one; the
 *   caller asks the document's status for it when the item is chosen.
 * - „Offene Punkte": the document's Prüfansicht, where its open marks are.
 * - „Im Ordner zeigen": the folder listing the document lies in, on its shelf.
 * - „Link kopieren": the document's own address, absolute, to pass on. It
 *   grants nothing: whoever opens it is asked who they are, as on any page.
 *
 * Pure: the caller hands in the labels and what each item does.
 */

import { Eye, FolderOpen, History, Link2, MessageSquareWarning, Sparkles } from 'lucide-react'

import type { ActionMenuEntry } from '@/components/ui/action-menu'
import type { DocumentHit } from '@/lib/search/search-wire'

export type DocumentHitAction = 'open' | 'ask' | 'openCurrent' | 'openPoints' | 'showInFolder' | 'copyLink'

export type DocumentHitActionLabels = Record<DocumentHitAction, string>

export interface DocumentHitActionHandlers {
  onOpen: () => void
  onAsk: () => void
  onOpenCurrent: () => void
  onOpenPoints: () => void
  onShowInFolder: () => void
  onCopyLink: () => void
}

/** The menu's groups, a separator between each: open and ask, where it stands, passing it on. */
const GROUPS: readonly (readonly DocumentHitAction[])[] = [['open', 'ask'], ['openCurrent', 'openPoints', 'showInFolder'], ['copyLink']]

/** Which actions a hit offers, in the menu's order. */
export function documentHitActions(hit: Pick<DocumentHit, 'shelf' | 'projectId' | 'superseded'>): DocumentHitAction[] {
  const offers = (action: DocumentHitAction): boolean => {
    if (action === 'ask') return hit.shelf === 'project' && Boolean(hit.projectId)
    if (action === 'openCurrent') return hit.superseded
    return true
  }
  return GROUPS.flat().filter(offers)
}

const ICONS = {
  open: Eye,
  ask: Sparkles,
  openCurrent: History,
  openPoints: MessageSquareWarning,
  showInFolder: FolderOpen,
  copyLink: Link2,
} as const

export function documentHitActionEntries(
  hit: Pick<DocumentHit, 'id' | 'shelf' | 'projectId' | 'superseded'>,
  labels: DocumentHitActionLabels,
  handlers: DocumentHitActionHandlers
): ActionMenuEntry[] {
  const run: Record<DocumentHitAction, () => void> = {
    open: handlers.onOpen,
    ask: handlers.onAsk,
    openCurrent: handlers.onOpenCurrent,
    openPoints: handlers.onOpenPoints,
    showInFolder: handlers.onShowInFolder,
    copyLink: handlers.onCopyLink,
  }
  const offered = new Set(documentHitActions(hit))
  const entries: ActionMenuEntry[] = []
  for (const group of GROUPS) {
    const items = group.filter((action) => offered.has(action))
    if (items.length === 0) continue
    if (entries.length > 0) entries.push({ type: 'separator' })
    for (const action of items) {
      entries.push({ type: 'item', id: action, label: labels[action], icon: ICONS[action], onSelect: run[action], testId: `search-hit-action-${action}` })
    }
  }
  return entries
}
