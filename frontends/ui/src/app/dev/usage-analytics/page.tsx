'use client'

/**
 * Dev preview for the usage-analytics opt-out card on the profile page: the
 * REAL `UsageAnalyticsSettings`, marked available. No PostHog runs here, so the
 * switch only moves its own state; what it calls on the SDK is pinned by the
 * component spec. 404s outside development (see `../layout.tsx`).
 *
 *   /dev/usage-analytics            German (the product's primary language)
 *   /dev/usage-analytics?lang=en    English
 */

import { Suspense, type JSX } from 'react'
import { useSearchParams } from 'next/navigation'

import { I18nProvider, type Locale } from '@/i18n'
import { UsageAnalyticsSettings } from '@/app/app/(shell)/profile/usage-analytics-settings'

export default function UsageAnalyticsPreviewPage(): JSX.Element {
  return (
    <Suspense>
      <Preview />
    </Suspense>
  )
}

function Preview(): JSX.Element {
  const lang = useSearchParams().get('lang')
  const locale: Locale = lang === 'en' ? 'en' : 'de'

  return (
    <I18nProvider initialLocale={locale} fixedLocale>
      <main className="min-h-dvh bg-background px-4 py-10" data-testid="usage-analytics-preview">
        <h1 className="mx-auto mb-6 max-w-2xl font-mono text-xs text-muted-foreground">
          /dev/usage-analytics — Nutzungsanalyse ({locale})
        </h1>
        <div className="mx-auto max-w-2xl">
          <UsageAnalyticsSettings available />
        </div>
      </main>
    </I18nProvider>
  )
}
