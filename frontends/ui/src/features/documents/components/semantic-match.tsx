'use client'

import { Quote } from 'lucide-react'
import { useTranslations } from '@/i18n'

/**
 * Match-evidence block for a search result card — the transparent "why it
 * matched" cue the product requires: the passage that matched and the page it
 * came from. The search ranks and shows no score (ADR-0133): the order of the
 * cards is the ranking. A document found by its name or by what it is carries
 * no passage, and then nothing is drawn. Rendered inside both the project and
 * Archiv file cards, so its labels live in the shared `files` namespace.
 * Visually distinct (primary tint) from the plain filename filter so the user
 * always knows they are seeing search results.
 */
export function SemanticMatch({ snippet, page }: { snippet: string; page: number | null }) {
  const t = useTranslations('files')
  if (snippet === '' && page === null) return null

  return (
    <div
      className="mt-2 space-y-1.5 rounded-lg border border-primary/20 bg-primary/5 px-2.5 py-2"
      data-testid="semantic-match"
    >
      {snippet !== '' && (
        <p className="line-clamp-3 text-xs leading-[1.45] text-foreground/80" title={snippet}>
          <Quote className="mr-1 inline size-3 -translate-y-px text-primary/60" aria-hidden />
          {snippet}
        </p>
      )}
      {page !== null && (
        <div className="text-xs text-muted-foreground">
          <span className="font-medium tabular-nums" data-testid="semantic-page">
            {t('browser.semantic.page', { page: String(page) })}
          </span>
        </div>
      )}
    </div>
  )
}
