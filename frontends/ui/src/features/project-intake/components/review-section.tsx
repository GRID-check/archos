'use client'

import type { JSX } from 'react'
import { Check, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { InspectorSection } from '@/components/ui/inspector-group'
import { Item, ItemActions, ItemContent, ItemList } from '@/components/ui/item'
import { useTranslations } from '@/i18n'
import type { IntakeDecision, Suggestion, SuggestionGroup } from '@/lib/project-intake/types'
import { DecisiveBadge, IntakeSection } from './intake-atoms'
import { EvidenceChips } from './evidence-chips'

/** The decisions that confirm every suggestion of a group. Contested and confirmed values are not suggestions. */
export function confirmAllDecisions(group: SuggestionGroup): IntakeDecision[] {
  return group.items
    .filter((item) => item.state === 'suggested')
    .map((item): IntakeDecision => ({ key: item.key, action: 'confirm' }))
}

/**
 * Prüfen: what Piloti found, grouped by the modules of the wizard. Each
 * suggestion is confirmed or dismissed on its own, or a whole module is
 * confirmed in one call. A value that decides the Gebäudeklasse says so.
 */
export function ReviewSection({
  groups,
  canDecide,
  busy,
  onDecide,
}: {
  groups: readonly SuggestionGroup[]
  canDecide: boolean
  busy: boolean
  onDecide: (decisions: IntakeDecision[]) => Promise<boolean>
}): JSX.Element {
  const t = useTranslations('projectIntake')
  const locked = !canDecide || busy
  return (
    <IntakeSection label={t('review.heading')} description={t('review.description')} testId="intake-review">
      {groups.length === 0 ? (
        <p className="text-muted-foreground rounded-lg border border-dashed px-4 py-6 text-center text-sm">
          {t('review.empty')}
        </p>
      ) : (
        <div className="space-y-5">
          {groups.map((group) => {
            const all = confirmAllDecisions(group)
            return (
              <InspectorSection
                key={group.stage}
                label={group.title}
                data-testid={`intake-group-${group.stage}`}
                action={
                  canDecide && all.length > 0 ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={locked}
                      aria-label={t('review.confirmAllAria', { count: all.length, group: group.title })}
                      onClick={() => void onDecide(all)}
                    >
                      <Check aria-hidden />
                      {t('review.confirmAll')}
                    </Button>
                  ) : undefined
                }
              >
                <ItemList as="ul" className="bg-card">
                  {group.items.map((item) => (
                    <SuggestionRow key={item.key} item={item} canDecide={canDecide} locked={locked} onDecide={onDecide} />
                  ))}
                </ItemList>
              </InspectorSection>
            )
          })}
        </div>
      )}
    </IntakeSection>
  )
}

function SuggestionRow({
  item,
  canDecide,
  locked,
  onDecide,
}: {
  item: Suggestion
  canDecide: boolean
  locked: boolean
  onDecide: (decisions: IntakeDecision[]) => Promise<boolean>
}): JSX.Element {
  const t = useTranslations('projectIntake')
  return (
    <Item as="li" className="items-start" data-testid={`intake-suggestion-${item.key}`}>
      <ItemContent className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-muted-foreground text-xs">{item.label}</p>
          {item.decisive && <DecisiveBadge label={t('review.decisive')} title={t('review.decisiveHint')} />}
          {item.state === 'confirmed' && <Badge variant="success">{t('review.confirmed')}</Badge>}
          {item.state === 'contested' && <Badge variant="warning">{t('review.contested')}</Badge>}
        </div>
        <p className="text-sm font-medium break-words">{item.display}</p>
        <EvidenceChips evidence={item.evidence} />
      </ItemContent>
      {canDecide && item.state === 'suggested' && (
        <ItemActions>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={locked}
            aria-label={t('review.confirmAria', { value: item.display, label: item.label })}
            onClick={() => void onDecide([{ key: item.key, action: 'confirm' }])}
          >
            <Check aria-hidden />
            {t('review.confirm')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={locked}
            aria-label={t('review.dismissAria', { value: item.display, label: item.label })}
            onClick={() => void onDecide([{ key: item.key, action: 'dismiss' }])}
          >
            <X aria-hidden />
            {t('review.dismiss')}
          </Button>
        </ItemActions>
      )}
    </Item>
  )
}
