'use client'

/**
 * Dev preview for „Mein Feedback" — the real `FeedbackThreadsDialog`, open,
 * with a fake API (`../_fixtures/feedback-threads.ts`) so the cases, a
 * conversation with the team, the reply, the form for a new report, the office
 * view and the degraded states can be reviewed and screenshotted without
 * PostHog. Two panes from `md:` up, one pane at a time on a phone. 404s outside
 * development (see `../layout.tsx`).
 *
 *   /dev/feedback-threads                  the member's cases, active first, one with news; the office switch shown
 *   /dev/feedback-threads?view=compose     „Neues Feedback": the form in the modal; sending opens the new case
 *   /dev/feedback-threads?view=thread      the conversation on a bug report
 *   /dev/feedback-threads?view=long        a long conversation: the newest message in view
 *   /dev/feedback-threads?view=waiting     a case the team has not answered yet
 *   /dev/feedback-threads?view=readonly    a report filed before replies were possible
 *   /dev/feedback-threads?view=offline     PostHog unreadable: only the report
 *   /dev/feedback-threads?view=empty       no feedback sent yet
 *   /dev/feedback-threads?view=office      „Unser Büro": every case of the office
 *   /dev/feedback-threads?view=colleague   a colleague's case, read-only
 *   /dev/feedback-threads?lang=en          English (German is the default)
 *
 * Sending a reply in the preview appends it to the fake thread; sending the
 * form files a new case at the top of the list and opens its thread.
 */

import type { JSX } from 'react'
import * as React from 'react'
import { useSearchParams } from 'next/navigation'

import { I18nProvider } from '@/i18n'
import { FeedbackThreadsDialog } from '@/features/product-feedback/components'
import { feedbackPreviewApi, feedbackPreviewStart, parseFeedbackPreviewView } from '../_fixtures/feedback-threads'

function Preview(): JSX.Element {
  const view = parseFeedbackPreviewView(useSearchParams().get('view'))
  const [open, setOpen] = React.useState(true)
  const api = React.useMemo(() => feedbackPreviewApi(view), [view])
  return (
    <>
      <main className="text-muted-foreground p-8 text-sm">Projekte …</main>
      <FeedbackThreadsDialog
        open={open}
        onOpenChange={setOpen}
        initialReportId={feedbackPreviewStart(view)}
        initialCompose={view === 'compose' ? 'bug' : null}
        initialScope={view === 'office' ? 'office' : 'mine'}
        userEmail="maria.huber@buero-nord.at"
        api={api}
      />
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
