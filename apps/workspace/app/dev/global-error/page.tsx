'use client'

/**
 * Dev preview of the last error boundary (`app/global-error.tsx`): the screen
 * shown when the root layout itself crashes, so its copy and its two actions
 * are screenshot-reviewable without breaking the layout. 404s outside
 * development.
 *
 *   /dev/global-error          German, the default for our users
 *   /dev/global-error?lang=en  English
 */

import { notFound, useSearchParams } from 'next/navigation'

import { GlobalErrorScreen } from '@/app/global-error'
import { isLocale } from '@/i18n'

export default function GlobalErrorPreviewPage() {
  const params = useSearchParams()
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }
  const lang = params.get('lang') ?? 'de'
  return (
    <div data-testid="global-error-preview">
      <GlobalErrorScreen locale={isLocale(lang) ? lang : 'de'} retry={() => {}} />
    </div>
  )
}
