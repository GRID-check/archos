'use client'

/**
 * „Original (.eml)“ of one filed mail (ADR-0134, D6): evidence kept beside its
 * section, downloaded by whoever may read the thread.
 *
 * What the entry knows decides the first word: an archive entry has no
 * original („Kein Original: aus dem E-Mail-Archiv übernommen“, the route's
 * `gone`), an infected one is said and offers nothing, a scan still running
 * says so. A clean one is a button, and the download is a fetch: the route
 * scans the whole message again on every request, so a 409
 * `original_not_clean` (a signature that arrived since) or `gone` comes back
 * as a sentence in place of the button, not as a JSON file in the downloads
 * folder. Its warning is said before the press: it opens in a mail program,
 * which loads images from outside.
 */

import type { JSX } from 'react'
import { useId, useState } from 'react'
import { toast } from 'sonner'
import { Archive, Download, ShieldAlert, Timer } from 'lucide-react'
import { BusyButton } from '@/components/ui/busy-button'
import { useTranslations } from '@/i18n'
import type { MailThreadEntryView } from '@/lib/mail-thread/mail-thread-wire'

/** What the original of an entry is, before and after a download asked the route. */
export type OriginalState = 'available' | 'not_clean' | 'scanning' | 'gone'

export function originalState(entry: Pick<MailThreadEntryView, 'original'>): OriginalState {
  if (entry.original === null) return 'gone'
  switch (entry.original.scanStatus) {
    case 'clean':
      return 'available'
    case 'infected':
      return 'not_clean'
    case 'pending':
    case 'failed':
      return 'scanning'
  }
}

export interface EntryOriginalProps {
  entry: Pick<MailThreadEntryView, 'original'>
  download: () => Promise<{ saved: true } | { saved: false; status: number | null; reason: string | null }>
}

export function EntryOriginal({ entry, download }: EntryOriginalProps): JSX.Element {
  const t = useTranslations('mailThread')
  // The route's answer outranks what the entry said when it was read.
  const [answered, setAnswered] = useState<OriginalState | null>(null)
  const [busy, setBusy] = useState(false)
  const hintId = useId()
  const state = answered ?? originalState(entry)

  const press = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await download()
      if (result.saved) return
      if (result.reason === 'original_not_clean') setAnswered('not_clean')
      else if (result.reason === 'gone') setAnswered('gone')
      else toast.error(t('original.failed'))
    } finally {
      setBusy(false)
    }
  }

  if (state === 'not_clean') {
    return (
      <p className="text-error flex min-w-0 items-start gap-1.5 text-xs leading-snug" data-testid="mail-entry-original" data-state="not_clean">
        <ShieldAlert className="mt-px size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0">{t('original.notClean')}</span>
      </p>
    )
  }
  if (state === 'gone' || state === 'scanning') {
    const Icon = state === 'gone' ? Archive : Timer
    return (
      <p className="text-muted-foreground flex min-w-0 items-start gap-1.5 text-xs leading-snug" data-testid="mail-entry-original" data-state={state}>
        <Icon className="mt-px size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0">{t(state === 'gone' ? 'original.gone' : 'original.scanning')}</span>
      </p>
    )
  }
  return (
    <span className="inline-flex">
      <BusyButton
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs"
        busy={busy}
        busyLabel={t('original.downloading')}
        icon={<Download aria-hidden />}
        title={t('original.hint')}
        aria-describedby={hintId}
        onClick={() => void press()}
        data-testid="mail-entry-original"
        data-state="available"
      >
        {t('original.download')}
      </BusyButton>
      {/* The warning before the press: a screen reader hears it with the button, a pointer reads it as the title. */}
      <span id={hintId} className="sr-only">
        {t('original.hint')}
      </span>
    </span>
  )
}
