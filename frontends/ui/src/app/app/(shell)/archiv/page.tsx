/**
 * Org-wide Archiv — the hard-load arrival of the Archiv sheet (ADR-0024).
 *
 * A soft navigation never reaches this page: the `(shell)/@overlay/(.)archiv`
 * interception renders the sheet above the current page instead. This page
 * serves the shareable URL — a refresh, a pasted link — where there is no page
 * underneath to cover, so the same sheet stands alone over the org chrome and
 * closing it lands on the projects home.
 */

import type { JSX } from 'react'
import { type Metadata } from 'next'
import { getTranslations } from '@/i18n/server'
import { OfficeShelfSheet } from './office-shelf-sheet'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('officeShelf')
  return { title: t('title') }
}

export default function OfficeShelfPage(): JSX.Element {
  return <OfficeShelfSheet standalone />
}
