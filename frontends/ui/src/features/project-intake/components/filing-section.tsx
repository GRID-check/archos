'use client'

import type { JSX } from 'react'
import { FilingBar } from '@/features/documents/components/filing-bar'
import type { FilingFolderSuggestion } from '@/features/documents/lib/filing-suggestions'
import { useTranslations } from '@/i18n'
import { IntakeSection } from './intake-atoms'

/**
 * Ablage: where Piloti would file the project's documents, one line per target
 * folder. Drawn by the same `FilingBar` as above a folder in Dateien and in the
 * upload tray, so applying or dismissing one is the same call to the proposals
 * service and the same record as a click there. The page shows no cards to
 * light, so each line names its files. A secondary section: the quiet bar,
 * never a card, so the page's one focal point stays the review above it.
 *
 * Nothing renders without an open suggestion.
 */
export function FilingSection({
  entries,
  onSettled,
}: {
  entries: readonly FilingFolderSuggestion[]
  /** A suggestion was decided: re-read the open ones. */
  onSettled: () => void
}): JSX.Element | null {
  const t = useTranslations('projectIntake')
  if (entries.length === 0) return null
  return (
    <IntakeSection label={t('filing.heading')} description={t('filing.description')} testId="intake-filing">
      {/* `grid-cols-1`: the panel is a grid, and its implicit `auto` column grows
          to the widest file name in its lines (the detail line truncates, but
          only inside a column that is allowed to be narrower than it), which
          pushed the whole page 27px past a phone's edge. */}
      <FilingBar entries={entries} onSettled={onSettled} showNames className="grid-cols-1" />
    </IntakeSection>
  )
}
