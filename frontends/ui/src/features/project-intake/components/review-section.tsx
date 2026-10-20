'use client'

import type { JSX } from 'react'
import { Check, CheckCheck, X } from 'lucide-react'
import { BusyButton } from '@/components/ui/busy-button'
import { InspectorSection } from '@/components/ui/inspector-group'
import { Item, ItemActions, ItemContent, ItemList } from '@/components/ui/item'
import { useTranslations } from '@/i18n'
import type { IntakeDecision, Suggestion, SuggestionGroup } from '@/lib/project-intake/types'
import { usePressed } from '../hooks/use-pressed'
import { ContestedBadge, DecisiveBadge, IntakeSection } from './intake-atoms'
import { ValueEvidence } from './profile/value-evidence'

/**
 * The decisions the review confirms in one call: every suggestion that does not
 * decide a Gebäudeklasse. A decisive one is confirmed on its own, where its
 * Fundstelle is read; contested and confirmed values are not suggestions.
 */
export function confirmRestDecisions(groups: readonly SuggestionGroup[]): IntakeDecision[] {
  return groups
    .flatMap((group) => group.items)
    .filter((item) => item.state === 'suggested' && !item.decisive)
    .map((item): IntakeDecision => ({ key: item.key, action: 'confirm' }))
}

/**
 * A value the Steckbrief shows elsewhere: a contradiction is resolved at the
 * top, and a decisive suggestion is decided on its own card
 * (`profile/decisive-section.tsx`).
 */
export function isShownApart(item: Suggestion): boolean {
  return item.state === 'contested' || (item.state === 'suggested' && item.decisive)
}

/** The groups without the values shown apart; a group left empty is left out. */
export function restGroups(groups: readonly SuggestionGroup[]): SuggestionGroup[] {
  return groups
    .map((group) => ({ ...group, items: group.items.filter((item) => !isShownApart(item)) }))
    .filter((group) => group.items.length > 0)
}

/**
 * Prüfen: what Piloti found, grouped by the modules of the wizard. A value that
 * decides the Gebäudeklasse is confirmed or dismissed on its own; the rest is
 * taken in one call from the section's heading, after a wrong one is dismissed.
 * Forty values with two buttons each was the page a pilot office called a form
 * again (ticket 26: „Widersprüche zuerst, dann klassifizierungsrelevante Werte
 * einzeln, dann der Rest per Sammelbestätigung").
 */
export function ReviewSection({
  groups: allGroups,
  canDecide,
  busy,
  onDecide,
  apart = false,
  label,
  description,
}: {
  groups: readonly SuggestionGroup[]
  canDecide: boolean
  busy: boolean
  onDecide: (decisions: IntakeDecision[]) => Promise<boolean>
  /**
   * The Steckbrief's order (ticket 26): contradictions and decisive
   * suggestions are shown before this section, so it holds only the rest.
   */
  apart?: boolean
  label?: string
  description?: string
}): JSX.Element | null {
  const t = useTranslations('projectIntake')
  const [pressed, press] = usePressed()
  const groups = apart ? restGroups(allGroups) : allGroups
  const rest = confirmRestDecisions(groups)
  // Everything is shown above (contradictions, decisive values): no empty "nothing found" here.
  if (apart && groups.length === 0 && allGroups.length > 0) return null
  return (
    <IntakeSection
      label={label ?? t('review.heading')}
      description={description ?? t('review.description')}
      testId="intake-review"
      action={
        canDecide && rest.length > 0 ? (
          <BusyButton
            type="button"
            size="sm"
            icon={<CheckCheck aria-hidden />}
            busy={pressed}
            blocked={busy}
            busyLabel={t('busy.confirm')}
            onClick={() => press(() => onDecide(rest))}
          >
            {t('review.confirmRest', { count: rest.length })}
          </BusyButton>
        ) : undefined
      }
    >
      {groups.length === 0 ? (
        <p className="text-muted-foreground rounded-lg border border-dashed px-4 py-6 text-center text-sm">
          {t('review.empty')}
        </p>
      ) : (
        <div className="space-y-5">
          {groups.map((group) => (
            <InspectorSection
              key={group.stage}
              label={group.title}
              data-testid={`intake-group-${group.stage}`}
            >
              <ItemList as="ul" className="bg-card">
                {group.items.map((item) => (
                  <SuggestionRow
                    key={item.key}
                    item={item}
                    canDecide={canDecide}
                    busy={busy}
                    onDecide={onDecide}
                  />
                ))}
              </ItemList>
            </InspectorSection>
          ))}
        </div>
      )}
    </IntakeSection>
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
    <Item
      as="li"
      className="flex-col items-start sm:flex-row"
      data-testid={`intake-suggestion-${item.key}`}
    >
      <ItemContent className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-muted-foreground text-xs">{item.label}</p>
          {item.decisive && (
            <DecisiveBadge label={t('review.decisive')} title={t('review.decisiveHint')} />
          )}
          {item.state === 'contested' && <ContestedBadge label={t('review.contested')} />}
        </div>
        <p className="hyphens-auto break-words text-sm font-medium">{item.display}</p>
        <ValueEvidence item={item} />
      </ItemContent>
      {canDecide && item.state === 'suggested' && (
        <ItemActions className="ml-0 sm:ml-auto">
          {item.decisive && (
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
          )}
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
