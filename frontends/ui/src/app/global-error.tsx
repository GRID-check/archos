'use client'

import { useEffect, useSyncExternalStore } from 'react'

import { StatusScreen } from '@/components/brand/status-screen'
import { Button } from '@/components/ui/button'
import { defaultLocale, getActiveLocale, getDictionary } from '@/i18n'
import { createTranslator } from '@/i18n/translate'
import { capturePosthogException } from '@/lib/analytics/posthog'
import { THEME_BOOT_SCRIPT } from './theme-boot'
import './globals.css'

/**
 * The last boundary: an error in the root layout itself, which `error.tsx`
 * sits below and so cannot catch.
 *
 * Next replaces the whole document while this is shown (`<html>` and `<body>`
 * are ours to render, and none of the layout's providers exist), so this file
 * is built from what needs no provider: the stylesheet and the theme boot
 * script are imported again, copy comes from the bundled dictionaries by the
 * locale cookie (`getActiveLocale`) instead of `useTranslations`, and the
 * escape is a plain anchor rather than `next/link`, because the router context
 * may be what broke. The copy is `errors.appError`, the same screen
 * `error.tsx` shows, so there is one wording to translate.
 *
 * Reporting follows `error.tsx`: client-side errors go to PostHog here, one
 * thrown on the server carries a `digest` and was already reported by
 * `onRequestError`. PostHog is started by the layout's providers, so if they
 * are what failed to mount, the report is a silent no-op and only the server
 * side sees it.
 */
export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string }
  retry: () => void
}) {
  // The server render has no cookie, so it says English; the client re-reads
  // the cookie after hydration without a mismatch (`useSyncExternalStore`).
  const locale = useSyncExternalStore(
    () => () => {},
    getActiveLocale,
    () => defaultLocale,
  )
  const t = createTranslator(getDictionary(locale), 'errors')

  useEffect(() => {
    console.error('[global error]', error)
    if (error.digest) return
    capturePosthogException(error, { source: 'global-error-boundary' })
  }, [error])

  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body className="bg-surface-base text-foreground font-sans antialiased">
        <StatusScreen
          code={t('appError.code')}
          title={t('appError.title')}
          description={t('appError.description')}
          actions={
            <>
              <Button variant="outline" onClick={retry}>
                {t('appError.action')}
              </Button>
              <Button asChild>
                {/* A plain anchor on purpose: see the header. */}
                <a href="/app/projects">{t('appError.backAction')}</a>
              </Button>
            </>
          }
        />
      </body>
    </html>
  )
}
