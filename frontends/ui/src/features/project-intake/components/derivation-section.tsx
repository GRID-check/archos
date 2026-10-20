'use client'

import type { JSX } from 'react'
import { Check } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { BusyButton } from '@/components/ui/busy-button'
import { Chip, ChipLabel } from '@/components/ui/chip'
import { RaisedCard, RaisedCardBody, RaisedCardFooter } from '@/components/ui/raised-card'
import { useTranslations } from '@/i18n'
import type { DerivationReview, IntakeDecision } from '@/lib/project-intake/types'
import { buildingNumber, displayValue, keyLabel } from '../lib/display'
import { usePressed } from '../hooks/use-pressed'
import { IntakeSection } from './intake-atoms'

/**
 * Ableitungen: the building class of each building, with the inputs it was read
 * from (the ones only suggested are marked), its Fundstelle, and what it still
 * lacks. Confirming it is deciding on the suggestion `building_class@bldgN`,
 * which the derivation carries: the review's modules leave the derived class
 * out, so this is the one way to write it.
 */
export function DerivationSection({
  derivations,
  canDecide,
  busy,
  onDecide,
}: {
  derivations: readonly DerivationReview[]
  canDecide: boolean
  busy: boolean
  onDecide: (decisions: IntakeDecision[]) => Promise<boolean>
}): JSX.Element | null {
  const t = useTranslations('projectIntake')
  if (derivations.length === 0) return null
  return (
    <IntakeSection
      label={t('derivations.heading')}
      description={t('derivations.description')}
      testId="intake-derivations"
    >
      <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {derivations.map((derivation) => (
          <li key={derivation.bauwerkId} className="min-w-0">
            <DerivationCard
              derivation={derivation}
              suggestion={derivation.suggestion}
              canDecide={canDecide}
              busy={busy}
              onDecide={onDecide}
            />
          </li>
        ))}
      </ul>
    </IntakeSection>
  )
}

/** „Anzahl oberirdischer Geschoße: 6 · vorgeschlagen": an input, and whether it is only suggested. */
function inputText(input: DerivationReview['inputs'][number], suggestedMark: string): string {
  const text = `${keyLabel(input.key)}: ${displayValue(input.key, input.value)}`
  return input.suggested ? `${text} · ${suggestedMark}` : text
}

function DerivationCard({
  derivation,
  suggestion,
  canDecide,
  busy,
  onDecide,
}: {
  derivation: DerivationReview
  suggestion: DerivationReview['suggestion']
  canDecide: boolean
  busy: boolean
  onDecide: (decisions: IntakeDecision[]) => Promise<boolean>
}): JSX.Element {
  const t = useTranslations('projectIntake')
  const [confirming, confirm] = usePressed()
  const building = t('derivations.building', { number: buildingNumber(derivation.bauwerkId) })
  const value = derivation.value === null ? null : t('derivations.value', { value: derivation.value })

  return (
    <RaisedCard data-testid={`intake-derivation-${derivation.bauwerkId}`}>
      <RaisedCardBody className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-muted-foreground text-xs">
              {building} · {t('derivations.rule')}
            </p>
            <p className="mt-0.5 text-2xl font-semibold tracking-tight tabular-nums">
              {value ?? (derivation.hochhaus ? '—' : t('derivations.open'))}
            </p>
          </div>
          {suggestion?.state === 'confirmed' && <Badge variant="success">{t('derivations.confirmed')}</Badge>}
          {suggestion?.state === 'suggested' && (
            <BusyButton
              type="button"
              size="sm"
              variant="outline"
              icon={<Check aria-hidden />}
              disabled={!canDecide}
              busy={confirming}
              blocked={busy}
              busyLabel={t('busy.confirm')}
              aria-label={t('derivations.confirmAria', { value: value ?? '', building })}
              onClick={() => confirm(() => onDecide([{ key: suggestion.key, action: 'confirm' }]))}
            >
              {t('derivations.confirm')}
            </BusyButton>
          )}
        </div>

        {derivation.hochhaus && <p className="text-sm">{t('derivations.hochhaus')}</p>}
        {derivation.value === null && !derivation.hochhaus && derivation.missing.length > 0 && (
          <p className="text-sm">
            {t('derivations.missing', { inputs: derivation.missing.map((key) => keyLabel(key)).join(', ') })}
          </p>
        )}

        {derivation.inputs.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-muted-foreground text-xs">{t('derivations.inputs')}</p>
            <ul className="flex flex-wrap gap-1.5">
              {derivation.inputs.map((input) => (
                <li key={input.key} className="min-w-0 max-w-full">
                  <Chip variant="muted" title={inputText(input, t('derivations.suggestedMark'))}>
                    <ChipLabel>{inputText(input, t('derivations.suggestedMark'))}</ChipLabel>
                  </Chip>
                </li>
              ))}
            </ul>
          </div>
        )}
      </RaisedCardBody>
      <RaisedCardFooter>{derivation.citation}</RaisedCardFooter>
    </RaisedCard>
  )
}
