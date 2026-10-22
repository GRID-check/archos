/**
 * What a bulk „Wie vorgeschlagen ablegen“ of several mails will do (DECISION
 * §9, RT-X10): the confirmation, grouped by where things go, computed from the
 * same drafts the request is built from (`decisionOf`).
 *
 * Whether a mail may be filed so at all is the server's: `incompleteReason` on
 * the list's summaries and on each mail (`lib/inbound-mail/review-defaults.ts`),
 * so the selection bar needs no read to say why not.
 *
 * Pure.
 */

import type { InboundMailView } from '@/lib/inbound-mail/inbound-mail-wire'
import { appendCandidate, draftSummary, type MailDraft } from './draft'

/** One line of the bulk confirmation: where it goes, and how many go there. */
export interface BulkDestination {
  kind: 'folder' | 'new_folder' | 'thread' | 'new_thread'
  /** The folder path (`''` is the root) or the thread's name. */
  label: string
  count: number
}

export interface BulkPlan {
  mails: number
  files: number
  texts: number
  destinations: BulkDestination[]
}

/** What filing these drafts as suggested will do, for the `ConfirmDialog` grouped by folder. */
export function bulkPlan(entries: ReadonlyArray<{ view: InboundMailView; draft: MailDraft }>): BulkPlan {
  const destinations = new Map<string, BulkDestination>()
  const add = (kind: BulkDestination['kind'], label: string): void => {
    const key = `${kind}:${label}`
    const current = destinations.get(key)
    if (current) current.count += 1
    else destinations.set(key, { kind, label, count: 1 })
  }
  let files = 0
  let texts = 0
  for (const { view, draft } of entries) {
    const summary = draftSummary(view, draft)
    files += summary.files
    if (summary.text) texts += 1
    for (const attachment of draft.attachments) {
      if (!attachment.checked) continue
      if (attachment.revisionOf !== null) {
        const revision = view.parts.find((part) => part.id === attachment.partId)?.revisionCandidate
        add('folder', revision?.folderPath ?? '')
      } else if (attachment.folder) {
        add(attachment.folder.kind === 'new' ? 'new_folder' : 'folder', attachment.folder.path)
      }
    }
    if (summary.text) {
      const candidate = appendCandidate(view, draft)
      const target = draft.message?.target
      if (candidate) add('thread', candidate.name)
      else if (target?.kind === 'create') add('new_thread', target.name)
    }
  }
  const order: Record<BulkDestination['kind'], number> = { thread: 0, new_thread: 1, folder: 2, new_folder: 3 }
  return {
    mails: entries.length,
    files,
    texts,
    destinations: [...destinations.values()].sort((a, b) => order[a.kind] - order[b.kind] || b.count - a.count || a.label.localeCompare(b.label)),
  }
}
