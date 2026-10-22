'use client'

/**
 * Dev preview for „Mein Feedback" — the real `FeedbackThreadsSheet`, open,
 * with a fake API so the list, a conversation with the team, the reply and the
 * degraded states can be reviewed and screenshotted without PostHog. 404s
 * outside development (see `../layout.tsx`).
 *
 *   /dev/feedback-threads                  the list, one thread with news
 *   /dev/feedback-threads?view=thread      the conversation on a bug report
 *   /dev/feedback-threads?view=waiting     a thread the team has not answered yet
 *   /dev/feedback-threads?view=readonly    a report filed before replies were possible
 *   /dev/feedback-threads?view=offline     PostHog unreadable: only the report
 *   /dev/feedback-threads?view=empty       no feedback sent yet
 *   /dev/feedback-threads?lang=en          English (German is the default)
 *
 * Sending a reply in the preview appends it to the fake thread.
 */

import type { JSX } from 'react'
import * as React from 'react'
import { useSearchParams } from 'next/navigation'

import { I18nProvider } from '@/i18n'
import { FeedbackThreadsSheet, type FeedbackThreadsApi } from '@/features/product-feedback/components'
import type {
  OwnProductFeedbackMessage,
  OwnProductFeedbackSummary,
  OwnProductFeedbackThread,
} from '@/lib/product-feedback/types'

const minutesAgo = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString()

const REPORTS: OwnProductFeedbackSummary[] = [
  {
    id: '0b1c2d3e-4f50-4617-8899-aabbccddee01',
    kind: 'bug',
    excerpt: 'Beim Hochladen eines 80-MB-Plans bleibt der Fortschritt bei 99 % stehen. Nach einem Neuladen ist die Datei nicht im Projekt.',
    createdAt: minutesAgo(180),
    status: 'pending',
    hasUpdate: true,
    canReply: true,
  },
  {
    id: '0b1c2d3e-4f50-4617-8899-aabbccddee02',
    kind: 'idea',
    excerpt: 'Eine Exportfunktion für den Prüfbericht als Word-Datei wäre für die Einreichung sehr hilfreich.',
    createdAt: minutesAgo(60 * 26),
    status: 'new',
    hasUpdate: false,
    canReply: true,
  },
  {
    id: '0b1c2d3e-4f50-4617-8899-aabbccddee03',
    kind: 'praise',
    excerpt: 'Die Zitate mit Fundstelle im OIB-Leitfaden sparen mir jeden Tag Zeit. Danke!',
    createdAt: minutesAgo(60 * 24 * 9),
    status: 'resolved',
    hasUpdate: false,
    canReply: false,
  },
]

const CONVERSATION: OwnProductFeedbackMessage[] = [
  {
    id: 'm1',
    author: 'me',
    authorName: null,
    content:
      'Beim Hochladen eines 80-MB-Plans bleibt der Fortschritt bei 99 % stehen. Nach einem Neuladen ist die Datei nicht im Projekt.',
    createdAt: minutesAgo(180),
  },
  {
    id: 'm2',
    author: 'team',
    authorName: 'Matthias',
    content:
      'Danke für die genaue Beschreibung! Wir sehen den Abbruch in den Logs. Passiert das auch mit kleineren Dateien, oder nur ab einer bestimmten Größe?',
    createdAt: minutesAgo(42),
  },
]

function threadFor(id: string, view: string | null, extra: OwnProductFeedbackMessage[]): OwnProductFeedbackThread {
  const report = REPORTS.find((candidate) => candidate.id === id) ?? REPORTS[0]!
  if (view === 'offline') {
    return { report: { ...report, status: null, hasUpdate: false }, messages: CONVERSATION.slice(0, 1), live: false }
  }
  if (view === 'waiting' || report.id !== REPORTS[0]!.id) {
    const first = { ...CONVERSATION[0]!, content: report.excerpt, createdAt: report.createdAt }
    return { report: { ...report, hasUpdate: false }, messages: [first, ...extra], live: true }
  }
  if (view === 'readonly') {
    return { report: { ...report, canReply: false, hasUpdate: false }, messages: CONVERSATION, live: true }
  }
  return { report: { ...report, hasUpdate: false }, messages: [...CONVERSATION, ...extra], live: true }
}

function Preview(): JSX.Element {
  const view = useSearchParams().get('view')
  const [open, setOpen] = React.useState(true)
  const extra = React.useRef<OwnProductFeedbackMessage[]>([])

  const api = React.useMemo<FeedbackThreadsApi>(
    () => ({
      list: async () => {
        await new Promise((resolve) => setTimeout(resolve, 250))
        const reports = view === 'empty' ? [] : REPORTS
        return { reports, updatedCount: reports.filter((r) => r.hasUpdate).length, live: true, nextCursor: null }
      },
      thread: async (id) => {
        await new Promise((resolve) => setTimeout(resolve, 250))
        return threadFor(id, view, extra.current)
      },
      reply: async (id, message) => {
        await new Promise((resolve) => setTimeout(resolve, 400))
        extra.current = [
          ...extra.current,
          { id: `r${extra.current.length}`, author: 'me', authorName: null, content: message, createdAt: new Date().toISOString() },
        ]
        return { ok: true, thread: threadFor(id, view, extra.current) }
      },
    }),
    [view],
  )

  const startOn = view && view !== 'empty' ? REPORTS[view === 'waiting' ? 1 : 0]!.id : null
  return (
    <>
      <main className="text-muted-foreground p-8 text-sm">Projekte …</main>
      <FeedbackThreadsSheet open={open} onOpenChange={setOpen} initialReportId={startOn} api={api} onNewFeedback={() => undefined} />
    </>
  )
}

export default function FeedbackThreadsDevPage(): JSX.Element {
  return (
    <React.Suspense>
      <LocalePinned />
    </React.Suspense>
  )
}

function LocalePinned(): JSX.Element {
  const lang = useSearchParams().get('lang') === 'en' ? 'en' : 'de'
  return (
    <I18nProvider initialLocale={lang} fixedLocale>
      <div className="bg-background min-h-dvh">
        <Preview />
      </div>
    </I18nProvider>
  )
}
