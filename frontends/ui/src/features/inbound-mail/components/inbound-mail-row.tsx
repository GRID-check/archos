'use client'

/**
 * One mail in the E-Mail-Eingang's list (`InboundMailRow`, DECISION §9).
 *
 * Connected, never a pill: the list owns the hairlines and the corners. A
 * leading checkbox for bulk work, visible on hover and focus and always under
 * a finger; then the sender's disc, the subject with its „AW:“/„WG:“ chain
 * stripped (the full subject is in the title), the time, and one muted line:
 * who, from which domain, how many attachments. While a mail waits, a third
 * line names the E-Mail-Verlauf it would continue (only one the reader may
 * read; not under a thread group's header, which says it already, nor once a
 * follow appended the text) and a glyph says when the sender is not confirmed.
 *
 * A waiting mail is „Bereit“ or needs the person (`isReady`, the server's
 * `incompleteReason`). A ready row outside a thread group carries „Wie
 * vorgeschlagen ablegen“, one press through the same rule and request as the
 * bulk bar; a row that needs the person says what, in a few plain words. A
 * handled mail says what became of it and until when it can be restored.
 *
 * Metadata only: the list never carries a mail's text (D22).
 */

import type { JSX } from 'react'
import Link from 'next/link'
import { Bot, CircleDashed, FileInput, Paperclip, Repeat2, ShieldAlert } from 'lucide-react'
import { PersonAvatar } from '@/components/ui/avatar-stack'
import { BusyButton } from '@/components/ui/busy-button'
import { Checkbox } from '@/components/ui/checkbox'
import { TimeAgo } from '@/components/ui/time-ago'
import { useLocale, useTranslations } from '@/i18n'
import type { InboundMailSummaryView } from '@/lib/inbound-mail/inbound-mail-wire'
import { formatCalendarDate } from '@/lib/format'
import { cn } from '@/lib/utils'
import { displaySubject } from '@/lib/inbound-mail/subject'
import { fileableReason } from '../lib/completeness'
import { bulkSelectable } from '../lib/impersonation'
import { SenderTrustGlyph } from './sender-trust'

export interface InboundMailRowProps {
  mail: InboundMailSummaryView
  href: string
  /** This mail is open in the detail. */
  open: boolean
  /** The keyboard's row (J/K). */
  focused: boolean
  /** Checked for a bulk action. */
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  /** The list is selecting: checkboxes stay visible on every row. */
  selecting: boolean
  onFocusRow?: () => void
  /** Under a thread group's header: the header names the thread, so the row does not. */
  inGroup?: boolean
  /** „Wie vorgeschlagen ablegen“ for this one mail; offered only on a ready row outside a group. */
  onFileAsSuggested?: () => void
  /** That press is in flight. */
  filingAsSuggested?: boolean
}

export function InboundMailRow({
  mail,
  href,
  open,
  focused,
  checked,
  onCheckedChange,
  selecting,
  onFocusRow,
  inGroup = false,
  onFileAsSuggested,
  filingAsSuggested = false,
}: InboundMailRowProps): JSX.Element {
  const t = useTranslations('inboundMail')
  const { locale } = useLocale()
  const subject = displaySubject(mail.subject) ?? t('row.noSubject')
  const who = mail.senderName?.trim() || mail.senderDomain || '—'
  const waiting = mail.status === 'waiting'
  const outcomes = (['filed', 'dismissed', 'expired'] as const).filter((outcome) => mail.outcomes[outcome] > 0)
  // A follow appended the text; its attachments still wait for a person (D31).
  const textFollowed = waiting && mail.followedBy !== null
  // A mail posing as someone is said in words on its row, and never joins a bulk decision.
  const impersonating = mail.riskLevel === 'impersonation'
  // Why it is not „Bereit“, the server's reason; null when one press files it as suggested.
  const reason = waiting ? fileableReason(mail) : null
  const offerFile = waiting && reason === null && !inGroup && onFileAsSuggested !== undefined

  return (
    <li
      className={cn(
        'group/row relative flex items-start gap-3 px-3 py-3 transition-colors duration-snap ease-out motion-reduce:transition-none sm:px-4',
        'hover:bg-accent/40 pointer-coarse:min-h-11',
        // The open row lifts to the card surface and wears the ink bar: a tinted fill
        // took its muted lines under 4.5:1.
        open && 'bg-card hover:bg-card',
        focused && !open && 'bg-accent/40'
      )}
      data-mail-id={mail.id}
      data-testid={`inbound-mail-row-${mail.id}`}
      data-open={open || undefined}
      data-focused={focused || undefined}
    >
      {/* The open row and the keyboard's row are marked by a bar of ink on the leading edge, never by chroma. */}
      {(focused || open) && (
        <span aria-hidden className={cn('absolute inset-y-2 left-0 w-0.5 rounded-full', open ? 'bg-foreground' : 'bg-foreground/40')} />
      )}
      {/* Above the link's full-row press area, so a tap on the box selects instead of opening. */}
      <div className="relative z-10 flex h-8 w-4 shrink-0 items-center">
        {bulkSelectable(mail) && (
          <Checkbox
            checked={checked}
            onCheckedChange={(value) => onCheckedChange(value === true)}
            aria-label={t('row.select', { subject })}
            data-testid="inbound-mail-row-checkbox"
            className={cn(
              'transition-opacity duration-quick',
              !selecting && !checked && 'opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100'
            )}
          />
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <Link
          href={href}
          onFocus={onFocusRow}
          aria-current={open ? 'page' : undefined}
          data-testid="inbound-mail-row-link"
          className="flex min-w-0 flex-1 items-start gap-3 rounded-sm outline-none after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring/60"
        >
          <PersonAvatar
            person={{ userId: mail.senderDomain ?? who, name: who }}
            size="sm"
            className="mt-0.5 shrink-0"
          />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex min-w-0 items-baseline gap-2">
              <p className={cn('min-w-0 flex-1 truncate text-sm', waiting ? 'text-foreground font-medium' : 'text-muted-foreground')} title={mail.subject ?? undefined}>
                {subject}
              </p>
              <TimeAgo date={mail.receivedAt} locale={locale} className="text-muted-foreground shrink-0 text-xs tabular-nums" />
            </div>
            <p className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
              {mail.automatic ? <Bot className="size-3.5 shrink-0" aria-label={t('row.automatic')} /> : <SenderTrustGlyph trust={mail.senderTrust} flags={mail.senderFlags} impersonation={mail.impersonation} />}
              <span className="min-w-0 truncate">
                {who}
                {mail.senderDomain && mail.senderName && <span> · {mail.senderDomain}</span>}
              </span>
              {mail.attachments > 0 && (
                <span className="inline-flex shrink-0 items-center gap-1">
                  <span aria-hidden>·</span>
                  <Paperclip className="size-3" aria-hidden />
                  {t('row.attachments', { count: mail.attachments })}
                </span>
              )}
            </p>
            {waiting && impersonating && (
              <p className="text-error flex min-w-0 items-center gap-1 text-xs font-medium" data-testid="inbound-mail-row-impersonation">
                <ShieldAlert className="size-3.5 shrink-0" aria-hidden />
                <span className="min-w-0 truncate">{t('row.impersonation', { name: who })}</span>
              </p>
            )}
            {waiting && reason !== null && !impersonating && (
              <p className="text-muted-foreground flex min-w-0 items-center gap-1 text-xs" data-testid="inbound-mail-row-reason" data-reason={reason}>
                <CircleDashed className="size-3 shrink-0" aria-hidden />
                <span className="min-w-0 truncate">{t(`row.needs.${reason}`)}</span>
              </p>
            )}
            {waiting && mail.thread && !inGroup && !textFollowed && (
              <p
                className="text-muted-foreground min-w-0 truncate text-xs"
                data-testid="inbound-mail-row-thread"
                title={t('row.thread', { name: mail.thread.name, version: mail.thread.nextVersion })}
              >
                <span aria-hidden>→ </span>
                {t('row.thread', { name: mail.thread.name, version: mail.thread.nextVersion })}
              </p>
            )}
            {textFollowed && (
              <p className="text-muted-foreground flex items-center gap-1 text-xs">
                <Repeat2 className="size-3" aria-hidden />
                {t('row.textFollowed')}
              </p>
            )}
            {!waiting && outcomes.length > 0 && (
              <p className="text-muted-foreground text-xs" data-testid="inbound-mail-row-outcome">
                {outcomes.map((outcome) => t(`row.outcome.${outcome}`, { count: mail.outcomes[outcome] })).join(' · ')}
                {mail.restorableUntil && ` · ${t('row.restorableUntil', { date: formatCalendarDate(mail.restorableUntil, locale) })}`}
              </p>
            )}
          </div>
        </Link>
        {offerFile && (
          // Above the link's full-row press area, like the checkbox; aligned with the text column, past the disc.
          <div className="relative z-10 pl-10">
            <BusyButton
              type="button"
              size="sm"
              variant="outline"
              className="h-7 px-2.5 text-xs pointer-coarse:h-9"
              busy={filingAsSuggested}
              busyLabel={t('bulk.fileSuggestedBusy')}
              icon={<FileInput aria-hidden />}
              onClick={onFileAsSuggested}
              aria-label={t('row.fileAsSuggested', { subject })}
              data-testid="inbound-mail-row-file"
            >
              {t('bulk.fileSuggested')}
            </BusyButton>
          </div>
        )}
      </div>
    </li>
  )
}
