'use client'

import type { JSX } from 'react'
import { Circle, CircleAlert, CircleCheck, CircleDashed, type LucideIcon } from 'lucide-react'
import { Item, ItemContent, ItemDescription, ItemList, ItemMedia, ItemTitle } from '@/components/ui/item'
import { Progress } from '@/components/ui/progress'
import { useTranslations } from '@/i18n'
import type { Translator } from '@/i18n/translate'
import { cn } from '@/lib/utils'
import type { MilestoneState, ReadingMilestone } from './reading-milestones'

/**
 * The state's mark: a glyph, and the word for a screen reader. Never a colour
 * alone, and nothing that spins: an active milestone is a dashed ring, and the
 * documents row carries the one determinate bar.
 */
const STATE_ICON: Record<MilestoneState, { icon: LucideIcon; tone: string }> = {
  done: { icon: CircleCheck, tone: 'text-success' },
  active: { icon: CircleDashed, tone: 'text-foreground' },
  pending: { icon: Circle, tone: 'text-muted-foreground/60' },
  attention: { icon: CircleAlert, tone: 'text-warning' },
}

interface MilestoneWords {
  title: string
  detail?: string
}

function siteWords(milestone: Extract<ReadingMilestone, { id: 'site' }>, t: Translator): MilestoneWords {
  const { site, state } = milestone
  if (state === 'active') return { title: t('milestones.site.searching'), detail: t('milestones.site.searchingDetail') }
  if (state === 'attention') return { title: t('milestones.site.open'), detail: t('milestones.site.openDetail') }
  if (!site.source) return { title: t('milestones.site.open') }
  const place = [site.bundesland, site.gemeinde !== site.bundesland ? site.gemeinde : null, site.address]
    .filter((part): part is string => Boolean(part))
    .join(' · ')
  const sourceKey = site.source === 'document' && !site.confirmed ? 'documentSuggested' : site.source
  return { title: t('milestones.site.done'), detail: [place, t(`milestones.site.sources.${sourceKey}`)].join(' · ') }
}

function documentsWords(milestone: Extract<ReadingMilestone, { id: 'documents' }>, t: Translator): MilestoneWords {
  const { read, total, state } = milestone
  if (total === null) {
    return { title: read > 0 ? t('milestones.documents.all', { count: read }) : t('milestones.documents.none') }
  }
  const rest = total - read
  return {
    title: t('milestones.documents.title', { read, total }),
    detail: state !== 'active' && rest > 0 ? t('milestones.documents.rest', { count: rest }) : undefined,
  }
}

function countWords(
  milestone: Extract<ReadingMilestone, { id: 'values' | 'contradictions' | 'gaps' }>,
  t: Translator
): MilestoneWords {
  const { id, count, state } = milestone
  if (count > 0) return { title: t(`milestones.${id}.title`, { count }), detail: t(`milestones.${id}.detail`) }
  const noneDetail = id === 'gaps' && state === 'done' ? t('milestones.gaps.noneDetail') : undefined
  return { title: t(`milestones.${id}.none`), detail: noneDetail }
}

function wordsOf(milestone: ReadingMilestone, t: Translator): MilestoneWords {
  switch (milestone.id) {
    case 'site':
      return siteWords(milestone, t)
    case 'documents':
      return documentsWords(milestone, t)
    default:
      return countWords(milestone, t)
  }
}

/**
 * The reading's milestones as one connected list, one row each: the state's
 * mark, what stands, and a line on what it means. The documents row carries a
 * determinate bar while the reading runs. The list is a live region, so a
 * screen reader hears a milestone change without being interrupted.
 */
export function ReadingMilestoneList({ milestones }: { milestones: readonly ReadingMilestone[] }): JSX.Element {
  const t = useTranslations('intakeReadingStep')
  return (
    <ItemList as="ol" aria-label={t('milestones.label')} aria-live="polite" className="bg-card" data-testid="reading-milestones">
      {milestones.map((milestone) => {
        const { icon: Icon, tone } = STATE_ICON[milestone.state]
        const words = wordsOf(milestone, t)
        const bar = milestone.id === 'documents' && milestone.state === 'active' && milestone.total !== null
        return (
          <Item
            as="li"
            key={milestone.id}
            className="items-start hover:bg-transparent"
            data-testid={`reading-milestone-${milestone.id}`}
            data-state={milestone.state}
          >
            <ItemMedia className="size-5">
              <Icon aria-hidden className={cn('size-5', tone)} />
            </ItemMedia>
            <ItemContent className="space-y-1">
              <ItemTitle className="whitespace-normal tabular-nums">
                {words.title}
                <span className="sr-only"> ({t(`milestones.states.${milestone.state}`)})</span>
              </ItemTitle>
              {words.detail && <ItemDescription className="whitespace-normal">{words.detail}</ItemDescription>}
              {bar && milestone.id === 'documents' && milestone.total !== null && (
                <Progress
                  className="mt-2 max-w-xs"
                  value={milestone.total > 0 ? Math.round((milestone.read / milestone.total) * 100) : 0}
                  aria-label={t('milestones.documents.aria', { read: milestone.read, total: milestone.total })}
                />
              )}
            </ItemContent>
          </Item>
        )
      })}
    </ItemList>
  )
}
