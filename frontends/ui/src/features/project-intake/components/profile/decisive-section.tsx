'use client'

import type { JSX } from 'react'
import { Check, X } from 'lucide-react'
import { BusyButton } from '@/components/ui/busy-button'
import { RaisedCard, RaisedCardBody } from '@/components/ui/raised-card'
import { useTranslations } from '@/i18n'
import type { IntakeDecision, Suggestion, SuggestionGroup } from '@/lib/project-intake/types'
import { usePressed } from '../../hooks/use-pressed'
import { bauwerkNumber } from '../../lib/display'
import { DecisiveBadge, IntakeSection } from '../intake-atoms'
import { ValueEvidence } from './value-evidence'

/** The suggestions that decide a Gebäudeklasse, in the modules' order: each is decided on its own. */
export function decisiveSuggestions(groups: readonly SuggestionGroup[]): Suggestion[] {
  return groups.flatMap((group) => group.items).filter((item) => item.state === 'suggested' && item.decisive)
}

/**
 * Die klassifizierungsrelevanten Werte, einzeln (ticket 26): each suggestion
 * that could change a Gebäudeklasse on a card of its own, with how sure it is,
 * where it was found and the excerpt of that page already open, and its own
 * Übernehmen and Verwerfen. Nothing here is taken in bulk: a wrong storey count
 * taken with forty others is a wrong class nobody looked at.
 */
export function DecisiveSection({
  groups,
  canDecide,
  busy,
  onDecide,
}: {
  groups: readonly SuggestionGroup[]
  canDecide: boolean
  busy: boolean
  onDecide: (decisions: IntakeDecision[]) => Promise<boolean>
}): JSX.Element | null {
  const t = useTranslations('intakeProfileStep')
  const items = decisiveSuggestions(groups)
  if (items.length === 0) return null
  return (
    <IntakeSection
      label={t('decisive.heading')}
      count={items.length}
      description={t('decisive.description')}
      testId="profile-decisive"
    >
      <ol className="space-y-3">
        {items.map((item, index) => (
          <li key={item.key}>
            <DecisiveCard
              item={item}
              position={t('decisive.position', { index: index + 1, total: items.length })}
              canDecide={canDecide}
              busy={busy}
              onDecide={onDecide}
            />
          </li>
        ))}
      </ol>
    </IntakeSection>
  )
}

function DecisiveCard({
  item,
  position,
  canDecide,
  busy,
  onDecide,
}: {
  item: Suggestion
  position: string
  canDecide: boolean
  busy: boolean
  onDecide: (decisions: IntakeDecision[]) => Promise<boolean>
}): JSX.Element {
  const t = useTranslations('intakeProfileStep')
  const tIntake = useTranslations('projectIntake')
  const [confirming, confirm] = usePressed()
  const [dismissing, dismiss] = usePressed()
  const bauwerk = item.bauwerkId ? tIntake('derivations.bauwerk', { number: bauwerkNumber(item.bauwerkId) }) : null
  return (
    <RaisedCard data-testid={`profile-decisive-${item.key}`}>
      <RaisedCardBody className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-muted-foreground text-xs tabular-nums">
              {[position, bauwerk].filter(Boolean).join(' · ')}
            </p>
            <DecisiveBadge label={tIntake('review.decisive')} title={tIntake('review.decisiveHint')} />
          </div>
          <div>
            <p className="text-muted-foreground text-sm break-words hyphens-auto">{item.label}</p>
            <p className="text-2xl font-semibold tracking-tight break-words hyphens-auto">{item.display}</p>
          </div>
          <ValueEvidence item={item} excerptOpen />
        </div>
        {canDecide && (
          <div className="flex flex-wrap gap-2 sm:shrink-0 sm:justify-end">
            <BusyButton
              type="button"
              size="sm"
              icon={<Check aria-hidden />}
              busy={confirming}
              blocked={busy}
              busyLabel={tIntake('busy.confirm')}
              aria-label={t('decisive.confirmAria', { value: item.display, label: item.label })}
              onClick={() => confirm(() => onDecide([{ key: item.key, action: 'confirm' }]))}
            >
              {t('decisive.confirm')}
            </BusyButton>
            <BusyButton
              type="button"
              size="sm"
              variant="ghost"
              icon={<X aria-hidden />}
              busy={dismissing}
              blocked={busy}
              busyLabel={tIntake('busy.dismiss')}
              aria-label={t('decisive.dismissAria', { value: item.display, label: item.label })}
              onClick={() => dismiss(() => onDecide([{ key: item.key, action: 'dismiss' }]))}
            >
              {t('decisive.dismiss')}
            </BusyButton>
          </div>
        )}
      </RaisedCardBody>
    </RaisedCard>
  )
}
