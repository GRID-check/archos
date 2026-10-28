/**
 * Loading state for the intercepted Postfach sheet: the scrim and panel appear
 * immediately over the page the reader is on, so the click lands before the
 * session round-trip resolves.
 */

import type { JSX } from 'react'
import { PageSheetSkeleton } from '@/components/shell/page-sheet-skeleton'
import { getTranslations } from '@/i18n/server'
import { commonCopy } from '@/i18n/namespaces/common'

export default async function InboxOverlayLoading(): Promise<JSX.Element> {
  const t = await getTranslations(commonCopy)
  return <PageSheetSkeleton loadingLabel={t('states.loading')} />
}
