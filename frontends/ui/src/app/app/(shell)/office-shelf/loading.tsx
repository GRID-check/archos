/**
 * Route-level loading state for the org Archiv's hard-load page.
 *
 * The page resolves a session and feature flags before it renders anything —
 * without this, a pasted `/app/office-shelf` link showed a blank frame until the
 * sheet arrived. Sheet-shaped, so the skeleton and the surface replacing it
 * are the same box (soft navigations render the intercepted overlay instead,
 * which has its own loading file).
 */

import type { JSX } from 'react'
import { PageSheetSkeleton } from '@/components/shell/page-sheet-skeleton'
import { getTranslations } from '@/i18n/server'
import { commonCopy } from '@/i18n/namespaces/common'

export default async function OfficeShelfLoading(): Promise<JSX.Element> {
  const t = await getTranslations(commonCopy)
  return <PageSheetSkeleton loadingLabel={t('states.loading')} />
}
