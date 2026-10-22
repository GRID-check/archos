'use client'

/**
 * Which mail brought a Fassung (D36, `mailOrigins`): „Kam mit der E-Mail von
 * Mag. Huber am 14.10.2026 · Domain bestätigt: ma37.wien.gv.at · Im
 * E-Mail-Verlauf ansehen“. The same line in two places: under the preview's
 * header for the Fassung in front of the reader, and on each row of the
 * Fassung timeline a mail brought.
 *
 * The sender is never more than the wire says: a display name (an archived or
 * an unconfirmed one included, never as an authority) and how far its domain
 * was confirmed, in the words the E-Mail-Verlauf uses
 * (`filedSenderTrust`). Glyph and words travel together; an unconfirmed
 * domain wears the warning glyph, its words stay ink.
 *
 * „Im E-Mail-Verlauf ansehen“ opens the thread document in Dateien at the
 * entry (`?doc=…&mailEntry=…`). An origin carries the thread's id, not its
 * document's, so the press reads the thread first (`mail-thread-get`, which
 * also re-checks the reader may still see it).
 */

import type { JSX } from 'react'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Mail, ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react'
import { useLocale, useTranslations } from '@/i18n'
import { formatCalendarDate } from '@/lib/format'
import type { MailOriginView } from '@/lib/inbound-mail/inbound-mail-wire'
import { cn } from '@/lib/utils'
import { documentFilesHref } from '../../lib/document-question'
import type { MailThreadClient } from './client'
import { MAIL_ENTRY_PARAM, filedSenderTrust } from './mail-thread-model'

/** Dateien at the thread document, its „E-Mails“ tab scrolled to the entry. */
export function mailEntryHref(projectId: string, threadDocumentId: string, entryId: string): string {
  return `${documentFilesHref(projectId, threadDocumentId)}&${MAIL_ENTRY_PARAM}=${encodeURIComponent(entryId)}`
}

/** The press of „Im E-Mail-Verlauf ansehen“: resolve the thread's document and go there. */
export function useOpenMailOrigin(projectId: string, client: Pick<MailThreadClient, 'get'>): (origin: MailOriginView) => Promise<void> {
  const router = useRouter()
  const t = useTranslations('mailThread')
  return async (origin) => {
    try {
      const thread = await client.get(projectId, origin.threadId)
      router.push(mailEntryHref(projectId, thread.documentId, origin.entryId))
    } catch {
      toast.error(t('provenance.openFailed'))
    }
  }
}

export interface MailOriginLineProps {
  /** The mails that brought this Fassung, oldest first; the first is named, the rest counted. */
  origins: readonly MailOriginView[]
  /** Absent where nothing can open the thread (no project): the line is said without the link. */
  onOpen?: (origin: MailOriginView) => Promise<void>
  /** `row` under the header, `timeline` inside a Fassung row of the rail. */
  variant?: 'row' | 'timeline'
  className?: string
}

export function MailOriginLine({ origins, onOpen, variant = 'timeline', className }: MailOriginLineProps): JSX.Element | null {
  const t = useTranslations('mailThread')
  const { locale } = useLocale()
  const [opening, setOpening] = useState(false)
  const origin = origins[0]
  if (!origin) return null
  const date = formatCalendarDate(origin.receivedAt, locale)
  const name = origin.fromName?.trim()
  const trust = filedSenderTrust(origin.senderTrust)
  const TrustIcon = trust === 'verified' ? ShieldCheck : trust === 'unverified' ? ShieldAlert : ShieldQuestion
  const trustWords =
    trust === 'verified'
      ? origin.signerDomain
        ? t('entry.trust.verified', { domain: origin.signerDomain })
        : t('entry.trust.verifiedNoDomain')
      : trust === 'unverified'
        ? t('entry.trust.unverified')
        : t('entry.trust.notChecked')

  const open = async (): Promise<void> => {
    if (!onOpen) return
    setOpening(true)
    try {
      await onOpen(origin)
    } finally {
      setOpening(false)
    }
  }

  return (
    <div
      className={cn(
        'flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs leading-snug',
        variant === 'row' ? 'text-foreground' : 'text-muted-foreground',
        className,
      )}
      data-testid="mail-origin"
      data-trust={trust}
    >
      <span className="inline-flex min-w-0 items-start gap-1.5">
        <Mail className="mt-px size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 [overflow-wrap:anywhere]">
          {name ? t('provenance.cameWith', { name, date }) : t('provenance.cameWithAnonymous', { date })}
          {origins.length > 1 && <span className="text-muted-foreground"> {t('provenance.more', { count: origins.length - 1 })}</span>}
        </span>
      </span>
      <span
        className={cn('inline-flex min-w-0 items-start gap-1.5', trust === 'unverified' && 'text-foreground font-medium')}
        data-testid="mail-origin-trust"
      >
        <TrustIcon className={cn('mt-px size-3.5 shrink-0', trust === 'unverified' && 'text-warning')} aria-hidden />
        <span className="min-w-0 [overflow-wrap:anywhere]">{trustWords}</span>
      </span>
      {onOpen && (
        <button
          type="button"
          onClick={() => void open()}
          disabled={opening}
          aria-label={t('provenance.openLabel', { date })}
          className="text-foreground touch-target rounded-sm font-medium underline underline-offset-2 outline-none hover:no-underline focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-60"
          data-testid="mail-origin-open"
        >
          {t('provenance.open')}
        </button>
      )}
    </div>
  )
}
