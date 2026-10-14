'use client'

import type { JSX } from 'react'
import { Check, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { BusyButton } from '@/components/ui/busy-button'
import { InspectorSection } from '@/components/ui/inspector-group'
import { Item, ItemActions, ItemContent, ItemList } from '@/components/ui/item'
import { useTranslations } from '@/i18n'
import type { IntakeDecision, Suggestion, SuggestionGroup } from '@/lib/project-intake/types'
import { usePressed } from '../hooks/use-pressed'
import { ContestedBadge, DecisiveBadge, IntakeSection } from './intake-atoms'
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
  return (
    <IntakeSection label={t('review.heading')} description={t('review.description')} testId="intake-review">
      {groups.length === 0 ? (
        <p className="text-muted-foreground rounded-lg border border-dashed px-4 py-6 text-center text-sm">
          {t('review.empty')}
        </p>
      ) : (
        <div className="space-y-5">
          {groups.map((group) => (
            <ReviewGroup key={group.stage} group={group} canDecide={canDecide} busy={busy} onDecide={onDecide} />
          ))}
        </div>
      )}
    </IntakeSection>
  )
}

function ReviewGroup({
  group,
  canDecide,
  busy,
  onDecide,
}: {
  group: SuggestionGroup
  canDecide: boolean
  busy: boolean
  onDecide: (decisions: IntakeDecision[]) => Promise<boolean>
}): JSX.Element {
  const t = useTranslations('projectIntake')
  const [pressed, press] = usePressed()
  const all = confirmAllDecisions(group)
  return (
    <InspectorSection
      label={group.title}
      data-testid={`intake-group-${group.stage}`}
      action={
        canDecide && all.length > 0 ? (
          <BusyButton
            type="button"
            size="sm"
            variant="ghost"
            icon={<Check aria-hidden />}
            busy={pressed}
            blocked={busy}
            busyLabel={t('busy.confirm')}
            aria-label={t('review.confirmAllAria', { count: all.length, group: group.title })}
            onClick={() => press(() => onDecide(all))}
          >
            {t('review.confirmAll')}
          </BusyButton>
        ) : undefined
      }
    >
      <ItemList as="ul" className="bg-card">
        {group.items.map((item) => (
          <SuggestionRow key={item.key} item={item} canDecide={canDecide} busy={busy} onDecide={onDecide} />
        ))}
      </ItemList>
    </InspectorSection>
  )
}

function SuggestionRow({
  item,
  canDecide,
  busy,
  onDecide,
}: {
  item: Suggestion
  canDecide: boolean
  busy: boolean
  onDecide: (decisions: IntakeDecision[]) => Promise<boolean>
}): JSX.Element {
  const t = useTranslations('projectIntake')
  const [confirming, confirm] = usePressed()
  const [dismissing, dismiss] = usePressed()
  return (
    <Item as="li" className="flex-col items-start sm:flex-row" data-testid={`intake-suggestion-${item.key}`}>
      <ItemContent className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-muted-foreground text-xs">{item.label}</p>
          {item.decisive && <DecisiveBadge label={t('review.decisive')} title={t('review.decisiveHint')} />}
          {item.state === 'confirmed' && <Badge variant="success">{t('review.confirmed')}</Badge>}
          {item.state === 'contested' && <ContestedBadge label={t('review.contested')} />}
        </div>
        <p className="text-sm font-medium break-words hyphens-auto">{item.display}</p>
        <EvidenceChips evidence={item.evidence} />
      </ItemContent>
      {canDecide && item.state === 'suggested' && (
        <ItemActions className="ml-0 sm:ml-auto">
          <BusyButton
            type="button"
            size="sm"
            variant="outline"
            icon={<Check aria-hidden />}
            busy={confirming}
            blocked={busy}
            busyLabel={t('busy.confirm')}
            aria-label={t('review.confirmAria', { value: item.display, label: item.label })}
            onClick={() => confirm(() => onDecide([{ key: item.key, action: 'confirm' }]))}
          >
            {t('review.confirm')}
          </BusyButton>
          <BusyButton
            type="button"
            size="sm"
            variant="ghost"
            icon={<X aria-hidden />}
            busy={dismissing}
            blocked={busy}
            busyLabel={t('busy.dismiss')}
            aria-label={t('review.dismissAria', { value: item.display, label: item.label })}
            onClick={() => dismiss(() => onDecide([{ key: item.key, action: 'dismiss' }]))}
          >
            {t('review.dismiss')}
          </BusyButton>
        </ItemActions>
      )}
    </Item>
  )
}
