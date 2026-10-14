'use client'

import type { JSX } from 'react'
import { FilingSuggestion } from '@/features/documents/components/filing-suggestion'
import type { FilingFolderSuggestion } from '@/features/documents/lib/filing-suggestions'
import { useTranslations } from '@/i18n'
import { IntakeSection } from './intake-atoms'

/**
 * Ablage: where Piloti would file the project's documents, one line per target
 * folder with the files that go there. The same proposals as in Dateien, drawn
 * by the same `FilingSuggestion`, so applying or dismissing one is the same
 * call to the proposals service and the same record as a click in the file
 * list. A secondary section: the quiet line, never a card, so the page's one
 * focal point stays the review above it.
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
      <ul className="space-y-3">
        {entries.map(({ suggestion, documents }) => {
          const names = documents.map((document) => document.name).join(', ')
          return (
            <li key={suggestion.proposalId} className="min-w-0 space-y-1" data-testid="intake-filing-entry">
              <p className="text-muted-foreground truncate text-xs" title={names}>
                {names}
              </p>
              <FilingSuggestion suggestion={suggestion} onSettled={onSettled} />
            </li>
          )
        })}
      </ul>
    </IntakeSection>
  )
}
