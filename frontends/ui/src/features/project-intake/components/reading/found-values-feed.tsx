'use client'

import type { JSX } from 'react'
import { Button } from '@/components/ui/button'
import { SectionLabel } from '@/components/ui/section-label'
import { useTranslations } from '@/i18n'
import { intakeReadingStepCopy } from '@/i18n/namespaces/intake-reading-step'
import type { FoundValue } from './found-values'

/**
 * „Gerade gefunden": a few values the reading found, each with the document
 * and page it stands on. The heading says which kind of list it is: values
 * that arrived while the page was open („Gerade gefunden"), a sample while it
 * still reads („Bisher gefunden"), or a sample of a finished reading. The
 * rest are a link away, on the Steckbrief.
 */
export function FoundValuesFeed({
  values,
  heading,
  total,
  onShowAll,
}: {
  values: readonly FoundValue[]
  heading: string
  /** Every value found; more than shown makes the link to the Steckbrief. */
  total: number
  onShowAll: () => void
}): JSX.Element {
  const t = useTranslations(intakeReadingStepCopy)
  return (
    <section aria-labelledby="reading-found-heading" data-testid="reading-found">
      <div className="flex items-baseline justify-between gap-3">
        <SectionLabel as="h2" id="reading-found-heading" className="text-xs">
          {heading}
        </SectionLabel>
        {total > values.length && (
          <Button type="button" variant="inline" className="text-muted-foreground text-[13px] font-normal" onClick={onShowAll}>
            {t('found.all', { count: total })}
          </Button>
        )}
      </div>
      <ul className="divide-border/70 mt-1.5 divide-y">
        {values.map((value) => (
          <li
            key={value.key}
            className="flex items-baseline gap-2.5 py-2 text-[13px]"
            data-testid="reading-found-value"
            data-fresh={value.fresh || undefined}
          >
            <span className="text-muted-foreground line-clamp-2 w-[112px] shrink-0 hyphens-auto break-words md:w-[200px]" title={value.label}>
              {value.label}
            </span>
            <span className="min-w-0 flex-1 md:flex md:items-baseline md:gap-2.5">
              <span className="block break-words font-medium">{value.display}</span>
              <span
                className="text-muted-foreground block truncate text-xs md:ml-auto md:max-w-[50%] md:shrink-0"
                title={value.source.fileName}
              >
                {value.source.page === null
                  ? value.source.name
                  : t('found.source', { name: value.source.name, page: value.source.page })}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
