'use client'

/**
 * One of the three sections of „Was Piloti tut": a label with its count over
 * the rows, or, when there are none, an empty state that says so. The section
 * stays on the page when empty: a missing „Läuft gerade" would read as a view
 * that failed to load.
 *
 * `truncated` is said in words and never as a number. A server cap cut rows
 * off, so the count is „at least"; the pill carries a „+" and a line under the
 * rows says there is more.
 */

import type { JSX, ReactNode } from 'react'
import { useId } from 'react'
import { CountPill } from '@/components/ui/count-pill'
import { EmptyState } from '@/components/ui/empty-state'
import { ItemList } from '@/components/ui/item'
import { SectionLabel } from '@/components/ui/section-label'
import { useTranslations } from '@/i18n'

export interface ActivitySectionProps {
  title: string
  /** How many things the rows stand for; shown while above zero. */
  count: number
  truncated: boolean
  empty: { title: string; description?: string }
  /** The rows (`ActivityRow`s); none renders the empty state. */
  children: ReactNode[]
  'data-testid'?: string
}

export function ActivitySection({
  title,
  count,
  truncated,
  empty,
  children,
  'data-testid': testId,
}: ActivitySectionProps): JSX.Element {
  const t = useTranslations('settings')
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2" data-testid={testId}>
      <div className="flex items-center gap-2">
        <SectionLabel as="h3" id={headingId}>
          {title}
        </SectionLabel>
        {count > 0 && <CountPill>{truncated ? `${count}+` : count}</CountPill>}
      </div>
      {children.length > 0 ? (
        <ItemList as="ul">{children}</ItemList>
      ) : (
        <EmptyState title={empty.title} description={empty.description} className="py-6" />
      )}
      {truncated && (
        <p className="text-muted-foreground text-xs" data-testid="piloti-activity-truncated">
          {t('project.pilotiActivity.truncated')}
        </p>
      )}
    </section>
  )
}
