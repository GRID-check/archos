/**
 * „Wie vorgeschlagen ablegen“ (DECISION §9, RT-X10): which mails may be filed
 * so without a look, and what filing them will do.
 *
 * ONE rule for every surface that offers it, the list's „Bereit“ section and
 * its one-tap row action, the selection's bulk bar and a thread group's press:
 * {@link fileableReason} decides, {@link asSuggested} builds the request from
 * the same drafts the confirmation is read from, and the request carries no
 * acknowledgement (`decisionOf(…, { bulk: true })`, RT-S5). So a one-tap row
 * cannot file what a bulk confirmation would refuse, by construction.
 *
 * Whether a mail is complete is the server's: `incompleteReason` on the list's
 * summaries and on each mail (`lib/inbound-mail/review-defaults.ts`). This
 * module never recomputes it. It only refuses one thing more, on its own
 * side: a mail that reads as an impersonation is never fileable as suggested,
 * whatever a stale view or a server bug says (the server says `sender` for
 * every one of them already).
 *
 * Pure.
 */

import type {
  InboundMailDecision,
  InboundMailSummaryView,
  InboundMailView,
  IncompleteReason,
} from '@/lib/inbound-mail/inbound-mail-wire'
import { appendCandidate, decisionOf, draftSummary, initialDraft, type DraftCopy, type FolderOption, type MailDraft } from './draft'

/** What a mail says about itself that decides whether it may be filed as suggested. */
export type FileableFacts = Pick<InboundMailSummaryView, 'status' | 'incompleteReason' | 'riskLevel'>

/**
 * Why this mail may not be filed as suggested without a look; null when it
 * may. The server's reason, with one refusal of our own: an impersonation is
 * always `sender`.
 */
export function fileableReason(mail: FileableFacts): IncompleteReason | null {
  if (mail.status !== 'waiting') return 'not_waiting'
  if (mail.riskLevel === 'impersonation') return 'sender'
  return mail.incompleteReason
}

/** Whether a mail is „Bereit“: complete, waiting, and posing as nobody. */
export function isReady(mail: FileableFacts): boolean {
  return fileableReason(mail) === null
}

/** The request and the confirmation for filing these mails as suggested, or why not (the first reason, with its count). */
export type AsSuggested =
  | { ok: true; decisions: InboundMailDecision[]; plan: BulkPlan }
  | { ok: false; reason: IncompleteReason; count: number }

/**
 * Filing these mails, as they are now, as suggested: each mail's draft is its
 * defaults (`initialDraft`), the request leaves every acknowledgement out
 * (`bulk`), and the plan is read off the same drafts. Refused as a whole when
 * any mail is not fileable, so nothing is half-filed by one press.
 */
export function asSuggested(views: readonly InboundMailView[], folders: readonly FolderOption[], copy: DraftCopy): AsSuggested {
  const reasons = new Map<IncompleteReason, number>()
  for (const view of views) {
    const reason = fileableReason(view)
    if (reason) reasons.set(reason, (reasons.get(reason) ?? 0) + 1)
  }
  const [first] = reasons.entries()
  if (first) return { ok: false, reason: first[0], count: first[1] }
  const entries = views.map((view) => ({ view, draft: initialDraft(view, folders, copy) }))
  return {
    ok: true,
    decisions: entries.map(({ view, draft }) => decisionOf(view, draft, { bulk: true })),
    plan: bulkPlan(entries),
  }
}

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
