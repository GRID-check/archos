'use client'

import type { JSX, ReactNode } from 'react'
import { Check } from 'lucide-react'
import { Item, ItemList } from '@/components/ui/item'
import { useTranslations } from '@/i18n'
import type { Translator } from '@/i18n/translate'
import { cn } from '@/lib/utils'
import type { MilestoneState, ReadingMilestone } from './reading-milestones'

/**
 * The state's mark: a glyph, and the word for a screen reader. Never a colour
 * alone, and nothing that spins: what still moves is a dashed ring.
 */
function StateMark({ state }: { state: MilestoneState }): JSX.Element {
  if (state === 'done') {
    return (
      <span aria-hidden className="bg-success-subtle text-success flex size-5 shrink-0 items-center justify-center rounded-full">
        <Check className="size-3" strokeWidth={3} />
      </span>
    )
  }
  if (state === 'attention') {
    return (
      <span
        aria-hidden
        className="bg-warning-subtle text-warning flex size-5 shrink-0 items-center justify-center rounded-full text-[12px] font-bold leading-none"
      >
        !
      </span>
    )
  }
  return <span aria-hidden className="border-muted-foreground/45 size-5 shrink-0 rounded-full border-[1.5px] border-dashed" />
}

interface RowWords {
  label: string
  /** What stands at the right: a number, a place, or a quiet word. */
  value: ReactNode
  quiet: boolean
}

function place(site: Extract<ReadingMilestone, { id: 'site' }>['site']): string {
  return [site.bundesland, site.gemeinde && site.gemeinde !== site.bundesland ? site.gemeinde : null]
    .filter((part): part is string => Boolean(part))
    .join(' · ')
}

function siteWords(milestone: Extract<ReadingMilestone, { id: 'site' }>, t: Translator): RowWords {
  const { site, state } = milestone
  if (state === 'active') return { label: t('milestones.site.searching'), value: t('milestones.later'), quiet: true }
  if (state === 'attention') return { label: t('milestones.site.open'), value: t('milestones.site.asked'), quiet: false }
  if (!site.source) return { label: t('milestones.site.open'), value: t('milestones.later'), quiet: true }
  const unconfirmed = site.source === 'document' && !site.confirmed
  return {
    label: unconfirmed ? t('milestones.site.suggested') : t('milestones.site.done'),
    value: unconfirmed ? `${place(site)} · ${t('milestones.site.toConfirm')}` : place(site),
    quiet: false,
  }
}

function countWords(
  milestone: Extract<ReadingMilestone, { id: 'values' | 'contradictions' | 'gaps' }>,
  t: Translator
): RowWords {
  const { id, count, state } = milestone
  const label = t(`milestones.${id}.label`)
  if (state === 'pending' && id === 'gaps') return { label, value: t('milestones.later'), quiet: true }
  if (count > 0) return { label, value: count, quiet: false }
  // Nothing yet while it reads; nothing at all once it is over.
  return { label, value: state === 'done' ? t('milestones.none') : t('milestones.noneYet'), quiet: true }
}

function wordsOf(milestone: ReadingMilestone, t: Translator): RowWords {
  return milestone.id === 'site' ? siteWords(milestone, t) : countWords(milestone, t)
}

/**
 * The reading's milestones as one card, one row each: the state's mark, what
 * it is, and what stands at the right. The list is a live region, so a screen
 * reader hears a milestone change without being interrupted.
 */
export function ReadingMilestoneCard({ milestones }: { milestones: readonly ReadingMilestone[] }): JSX.Element {
  const t = useTranslations('intakeReadingStep')
  return (
    <ItemList
      as="ol"
      aria-label={t('milestones.label')}
      aria-live="polite"
      className="bg-card border-border divide-border/70 rounded-[14px]"
      data-testid="reading-milestones"
    >
      {milestones.map((milestone) => {
        const words = wordsOf(milestone, t)
        const number = typeof words.value === 'number'
        return (
          <Item
            as="li"
            key={milestone.id}
            className="min-h-12 gap-3 px-4 py-3 text-sm hover:bg-transparent md:px-[18px]"
            data-testid={`reading-milestone-${milestone.id}`}
            data-state={milestone.state}
          >
            <StateMark state={milestone.state} />
            <span className={cn('min-w-0 flex-1', milestone.state === 'pending' && 'text-muted-foreground')}>
              {words.label}
              <span className="sr-only"> ({t(`milestones.states.${milestone.state}`)})</span>
            </span>
            <span
              className={cn(
                'text-right tabular-nums',
                number ? 'shrink-0 text-sm font-medium' : 'min-w-0 max-w-[60%] text-[13px]',
                words.quiet || !number ? 'text-muted-foreground' : 'text-foreground'
              )}
            >
              {words.value}
            </span>
          </Item>
        )
      })}
    </ItemList>
  )
}
