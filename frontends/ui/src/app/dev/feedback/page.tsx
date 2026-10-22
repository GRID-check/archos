'use client'

/**
 * Dev preview for the feedback form — the real `FeedbackDialog`, open, with a
 * fake submit so the form, the validation, the error and the thank-you state
 * can be reviewed and screenshotted without a backend. 404s outside
 * development (see `../layout.tsx`).
 *
 *   /dev/feedback                  the form, a bug pre-selected
 *   /dev/feedback?kind=idea        another kind pre-selected
 *   /dev/feedback?variant=error    sending fails
 *   /dev/feedback?variant=sent     the thank-you state after a send
 *   /dev/feedback?lang=en          English (German is the default)
 *
 * Also renders the org header with the provider mounted, so the entry point
 * next to the inbox (and the avatar's dot for a waiting reply) is in the
 * capture, and „Chat öffnen" after sending opens the real „Mein Feedback"
 * sheet on the fake backend (`../_fixtures/feedback-threads.ts`).
 */

import type { JSX } from 'react'
import * as React from 'react'
import { useSearchParams } from 'next/navigation'

import { I18nProvider } from '@/i18n'
import { OrgHeader } from '@/components/shell/org-header'
import { FeedbackProvider, useOpenFeedback } from '@/features/product-feedback/components'
import type { SubmitProductFeedbackResult } from '@/lib/product-feedback/client'
import { PRODUCT_FEEDBACK_KINDS, type ProductFeedbackKind } from '@/lib/product-feedback/types'
import { FEEDBACK_PREVIEW_REPORTS, feedbackPreviewApi } from '../_fixtures/feedback-threads'

const MESSAGE =
  'Beim Hochladen eines 80-MB-Plans bleibt der Fortschritt bei 99 % stehen. Nach einem Neuladen ist die Datei nicht im Projekt.'

function Preview(): JSX.Element {
  const params = useSearchParams()
  const variant = params.get('variant')
  const kindParam = params.get('kind')
  const kind: ProductFeedbackKind = PRODUCT_FEEDBACK_KINDS.includes(kindParam as ProductFeedbackKind)
    ? (kindParam as ProductFeedbackKind)
    : 'bug'
  const threadsApi = React.useMemo(() => feedbackPreviewApi('thread'), [])

  const submit = React.useCallback(async (): Promise<SubmitProductFeedbackResult> => {
    await new Promise((resolve) => setTimeout(resolve, 400))
    return variant === 'error'
      ? { ok: false, reason: 'failed' }
      : // The report „Chat öffnen" then opens is one the fake thread knows.
        { ok: true, report: { id: FEEDBACK_PREVIEW_REPORTS[0]!.id, kind, createdAt: new Date().toISOString() } }
  }, [variant, kind])

  // For the `sent` and `error` captures: fill and send once the dialog is up.
  React.useEffect(() => {
    if (variant !== 'sent' && variant !== 'error') return
    const timer = window.setTimeout(() => {
      const textarea = document.querySelector<HTMLTextAreaElement>('[data-testid="feedback-message"]')
      if (!textarea) return
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(textarea, MESSAGE)
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      window.setTimeout(() => document.querySelector<HTMLButtonElement>('[data-testid="feedback-send"]')?.click(), 50)
    }, 300)
    return () => window.clearTimeout(timer)
  }, [variant])

  return (
    // The shell's own provider, with the fakes: the form is the provider's, so
    // „Chat öffnen" after sending runs the real hand-off into „Mein Feedback",
    // and the avatar carries the dot for the reply waiting there.
    <FeedbackProvider userEmail="maria.huber@buero-nord.at" threadsApi={threadsApi} submit={submit}>
      <OpenOnMount kind={kind} />
      <OrgHeader
        user={{ name: 'Maria Huber', email: 'maria.huber@buero-nord.at' }}
        organizationName="Architekturbüro Nord"
        authRequired={false}
        canManageOrganization={false}
        canViewOrganization
        canManagePlatform={false}
        canAccessOfficeShelf
        canAccessInbox={false}
      />
      <main className="text-muted-foreground p-8 text-sm">Projekte …</main>
    </FeedbackProvider>
  )
}

/** Opens the provider's form once, as the avatar menu's „Feedback senden" would. */
function OpenOnMount({ kind }: { kind: ProductFeedbackKind }): null {
  const openFeedback = useOpenFeedback()
  React.useEffect(() => openFeedback(kind), [openFeedback, kind])
  return null
}

export default function FeedbackDevPage(): JSX.Element {
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
