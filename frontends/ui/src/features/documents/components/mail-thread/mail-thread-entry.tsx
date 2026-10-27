'use client'

/**
 * One filed mail in the „E-Mails“ tab: one row per section of the thread
 * document, newest first.
 *
 * - **The heading**, exactly as the document prints it and a citation names
 *   it („14.10.2026, 09:12 · Mag. Huber (ma37.wien.gv.at)“), then „ab
 *   Fassung 4 · eingegangen …“: the Fassung the mail first appeared in.
 * - **How far its sender was confirmed**, in the three words a filed mail can
 *   carry; an unconfirmed domain wears the warning glyph, its words stay ink.
 *   How it was filed is said only where no person decided it in the app (a
 *   follow, the archive import, an agent, a Piloti card).
 * - **What came with it** (D36): every attachment, as a link to the document
 *   it became, „lag schon im Projekt“, or „nicht abgelegt“ with its reason
 *   (its bytes are then only in the original); one in a folder the reader may
 *   not see is counted, never named.
 * - **Its actions:** „Original (.eml)“, „Vergleichen“ (this mail's Fassung
 *   against the one before, the version comparison the Fassung timeline
 *   uses), and „Herauslösen …“ behind ⋯ for whoever may file mail here.
 *
 * A link or a citation that names this entry scrolls it into view and marks
 * it (`focused`): an ink bar on the leading edge, never a tint under muted
 * text (`grid-design-language.md`).
 */

import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Archive, Bot, FileText, MoreHorizontal, Paperclip, Repeat2, ShieldAlert, ShieldCheck, ShieldQuestion, Sparkles } from 'lucide-react'
import { ActionMenu, type ActionMenuEntry } from '@/components/ui/action-menu'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useLocale, useTranslations } from '@/i18n'
import { formatAbsoluteTime } from '@/lib/format'
import type { DocumentVersionView } from '@/lib/documents/lifecycle-types'
import type { MailThreadEntryView, MailThreadFiledVia } from '@/lib/mail-thread/mail-thread-wire'
import { cn } from '@/lib/utils'
import { documentFilesHref } from '../../lib/document-question'
import { DocumentVersionDiff } from '../document-version-diff'
import type { MailThreadClient } from './client'
import { EntryOriginal } from './entry-original'
import { attachmentLines, comparedVersions, filedSenderTrust, type AttachmentLine } from './mail-thread-model'

/** The ways of filing worth a line: every other mail was decided by a person in the app. */
const FILED_VIA_ICON: Partial<Record<MailThreadFiledVia, typeof Bot>> = {
  agent: Bot,
  piloti_proposal: Sparkles,
  follow: Repeat2,
  archive_import: Archive,
}

type Comparison =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'done'; from: { versionNumber: number; content: string }; to: { versionNumber: number; content: string } }

export interface MailThreadEntryItemProps {
  projectId: string
  /** The thread document, whose Fassungen „Vergleichen“ reads. */
  documentId: string
  threadId: string
  entry: MailThreadEntryView
  /** The thread document's Fassungen, once read; null while they are not. */
  versions: readonly DocumentVersionView[] | null
  focused: boolean
  /** „Herauslösen …“ is offered: the reader may file mail here, and the thread has another mail. */
  onDetach?: (entry: MailThreadEntryView) => void
  client: MailThreadClient
}

export function MailThreadEntryItem({ projectId, documentId, threadId, entry, versions, focused, onDetach, client }: MailThreadEntryItemProps): JSX.Element {
  const t = useTranslations('mailThread')
  const { locale } = useLocale()
  const ref = useRef<HTMLLIElement>(null)
  const [comparison, setComparison] = useState<Comparison | null>(null)
  const trust = filedSenderTrust(entry.senderTrust)
  const compared = versions ? comparedVersions(entry, versions) : null
  const ViaIcon = FILED_VIA_ICON[entry.filedVia]
  const attachments = attachmentLines(entry.attachments)

  useEffect(() => {
    if (!focused || !ref.current) return
    // Instant when the reader asked for less motion; the focus moves with it, so a screen reader lands here too.
    const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ref.current.scrollIntoView?.({ block: 'center', behavior: reduce ? 'auto' : 'smooth' })
    ref.current.focus({ preventScroll: true })
  }, [focused])

  const compare = async (): Promise<void> => {
    if (!compared) return
    if (comparison) {
      setComparison(null)
      return
    }
    setComparison({ status: 'loading' })
    try {
      const diff = await client.diff(documentId, compared.from.id, compared.to.id)
      setComparison({
        status: 'done',
        from: { versionNumber: compared.from.number, content: diff.from.content },
        to: { versionNumber: compared.to.number, content: diff.to.content },
      })
    } catch {
      setComparison({ status: 'failed' })
    }
  }

  const menu: ActionMenuEntry[] = onDetach
    ? [{ type: 'item', id: 'detach', label: t('entry.detach'), onSelect: () => onDetach(entry), testId: 'mail-entry-detach' }]
    : []

  const trustLine = (() => {
    if (trust === 'verified') {
      return { Icon: ShieldCheck, words: entry.signerDomain ? t('entry.trust.verified', { domain: entry.signerDomain }) : t('entry.trust.verifiedNoDomain') }
    }
    if (trust === 'unverified') return { Icon: ShieldAlert, words: t('entry.trust.unverified') }
    return { Icon: ShieldQuestion, words: t('entry.trust.notChecked') }
  })()

  return (
    <li
      ref={ref}
      tabIndex={-1}
      id={`mail-entry-${entry.id}`}
      data-testid="mail-thread-entry"
      data-entry-id={entry.id}
      data-focused={focused || undefined}
      aria-current={focused ? 'location' : undefined}
      className={cn(
        'flex flex-col gap-2 border-l-2 border-transparent px-3 py-3 outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
        focused && 'border-l-foreground bg-card',
      )}
    >
      <div className="flex min-w-0 items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h4 className="text-foreground text-[13px] font-medium leading-snug [overflow-wrap:anywhere]" data-testid="mail-thread-entry-heading">
            {entry.heading}
          </h4>
          <p className="text-muted-foreground text-xs tabular-nums leading-snug">
            {entry.firstVersion && (
              <span className="text-foreground font-medium" data-testid="mail-thread-entry-from">
                {t('entry.fromRevision', { number: entry.firstVersion.number })}
              </span>
            )}
            {entry.firstVersion && ' · '}
            {t('entry.received', { time: formatAbsoluteTime(entry.receivedAt, locale) })}
          </p>
        </div>
        {menu.length > 0 && (
          <ActionMenu
            mode="dropdown"
            entries={menu}
            trigger={
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="text-muted-foreground hover:text-foreground touch-target -my-1 size-6 shrink-0"
                aria-label={t('entry.menu', { heading: entry.heading })}
                title={t('entry.menu', { heading: entry.heading })}
                data-testid="mail-entry-menu"
              >
                <MoreHorizontal className="size-4" aria-hidden />
              </Button>
            }
          />
        )}
      </div>

      <p
        className={cn('flex min-w-0 items-start gap-1.5 text-xs leading-snug', trust === 'unverified' ? 'text-foreground font-medium' : 'text-muted-foreground')}
        data-testid="mail-thread-entry-trust"
        data-trust={trust}
      >
        <trustLine.Icon className={cn('mt-px size-3.5 shrink-0', trust === 'unverified' && 'text-warning')} aria-hidden />
        <span className="min-w-0 [overflow-wrap:anywhere]">{trustLine.words}</span>
      </p>
      {ViaIcon && (
        <p className="text-muted-foreground flex min-w-0 items-start gap-1.5 text-xs leading-snug" data-testid="mail-thread-entry-via">
          <ViaIcon className="mt-px size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0">{t(`entry.filedVia.${entry.filedVia}`)}</span>
        </p>
      )}

      {attachments.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
            <Paperclip className="size-3.5 shrink-0" aria-hidden />
            {t('attachments.label')}
          </p>
          <ul className="flex flex-col gap-0.5 pl-5" data-testid="mail-thread-entry-attachments">
            {attachments.map((line) => (
              <AttachmentItem key={line.position} projectId={projectId} line={line} />
            ))}
          </ul>
        </div>
      )}

      <div className="-ml-2 flex flex-wrap items-center gap-x-1 gap-y-1">
        <EntryOriginal entry={entry} download={() => client.downloadOriginal(projectId, threadId, entry.id)} />
        {compared && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            aria-expanded={comparison !== null}
            aria-label={t('entry.compareLabel', { from: compared.from.number, to: compared.to.number })}
            onClick={() => void compare()}
            data-testid="mail-thread-entry-compare"
          >
            {comparison ? t('entry.compareClose') : t('entry.compare')}
          </Button>
        )}
      </div>

      {comparison?.status === 'loading' && (
        <p className="text-muted-foreground flex items-center gap-2 text-xs" role="status">
          <Spinner className="size-3.5" />
          {t('entry.comparing')}
        </p>
      )}
      {comparison?.status === 'failed' && (
        <p className="text-error text-xs" data-testid="mail-thread-entry-compare-failed">
          {t('entry.compareFailed')}
        </p>
      )}
      {comparison?.status === 'done' && (
        <div data-testid="mail-thread-entry-comparison">
          <DocumentVersionDiff from={comparison.from} to={comparison.to} />
        </div>
      )}
    </li>
  )
}

function AttachmentItem({ projectId, line }: { projectId: string; line: AttachmentLine }): JSX.Element {
  const t = useTranslations('mailThread')
  if (line.kind === 'hidden') {
    return (
      <li className="text-muted-foreground text-xs leading-snug" data-testid="mail-thread-attachment" data-disposition="hidden">
        {t('attachments.hidden')}
      </li>
    )
  }
  const name = line.name || t('attachments.unnamed', { position: line.position })
  const named =
    line.kind !== 'not_filed' && line.documentId ? (
      <Link
        href={documentFilesHref(projectId, line.documentId)}
        className="text-foreground inline-flex min-w-0 items-start gap-1 rounded-sm underline underline-offset-2 outline-none hover:no-underline focus-visible:ring-2 focus-visible:ring-ring/60"
        data-testid="mail-thread-attachment-link"
      >
        <FileText className="mt-px size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 [overflow-wrap:anywhere]">{name}</span>
      </Link>
    ) : (
      <span className="inline-flex min-w-0 items-start gap-1">
        <FileText className="mt-px size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 [overflow-wrap:anywhere]">{name}</span>
      </span>
    )
  return (
    <li className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-xs leading-snug" data-testid="mail-thread-attachment" data-disposition={line.kind}>
      {named}
      {line.kind === 'already_present' && <span className="text-muted-foreground">{t('attachments.alreadyPresent')}</span>}
      {line.kind === 'not_filed' && (
        <span className="text-muted-foreground">
          {t('attachments.notFiled', { reason: line.reason ? t(`attachments.reasons.${line.reason}`) : t('attachments.inOriginal') })}
        </span>
      )}
    </li>
  )
}
