'use client'

import type { JSX } from 'react'
import { Check } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Chip, ChipLabel } from '@/components/ui/chip'
import { RaisedCard, RaisedCardBody, RaisedCardFooter } from '@/components/ui/raised-card'
import { useTranslations } from '@/i18n'
import type { DerivationView, IntakeDecision, SuggestionGroup } from '@/lib/project-intake/types'
import { bauwerkNumber, displayValue, keyLabel } from '../lib/display'
import { IntakeSection } from './intake-atoms'

/** The profile key a Bauwerk's class is stored under, and so decided on. */
export const gebaeudeklasseKeyOf = (bauwerkId: string): string => `gebaeudeklasse@${bauwerkId}`

/**
 * Ableitungen: the Gebäudeklasse of each Bauwerk, with the inputs it was read
 * from (the ones only suggested are marked), its Fundstelle, and what it still
 * lacks. Confirming it is deciding on the suggestion `gebaeudeklasse@bwN`, the
 * same row the review lists, so there is one way to write it.
 */
export function DerivationSection({
  derivations,
  groups,
  canDecide,
  busy,
  onDecide,
}: {
  derivations: readonly DerivationView[]
  groups: readonly SuggestionGroup[]
  canDecide: boolean
  busy: boolean
  onDecide: (decisions: IntakeDecision[]) => Promise<boolean>
}): JSX.Element | null {
  const t = useTranslations('projectIntake')
  if (derivations.length === 0) return null
  const rows = groups.flatMap((group) => group.items)
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
              suggestion={rows.find((row) => row.key === gebaeudeklasseKeyOf(derivation.bauwerkId))}
              locked={!canDecide || busy}
              onDecide={onDecide}
            />
          </li>
        ))}
      </ul>
    </IntakeSection>
  )
}

/** „Anzahl oberirdischer Geschoße: 6 · vorgeschlagen": an input, and whether it is only suggested. */
function inputText(input: DerivationView['inputs'][number], suggestedMark: string): string {
  const text = `${keyLabel(input.key)}: ${displayValue(input.key, input.value)}`
  return input.suggested ? `${text} · ${suggestedMark}` : text
}

function DerivationCard({
  derivation,
  suggestion,
  locked,
  onDecide,
}: {
  derivation: DerivationView
  suggestion: SuggestionGroup['items'][number] | undefined
  locked: boolean
  onDecide: (decisions: IntakeDecision[]) => Promise<boolean>
}): JSX.Element {
  const t = useTranslations('projectIntake')
  const bauwerk = t('derivations.bauwerk', { number: bauwerkNumber(derivation.bauwerkId) })
  const value = derivation.value === null ? null : t('derivations.value', { value: derivation.value })

  return (
    <RaisedCard data-testid={`intake-derivation-${derivation.bauwerkId}`}>
      <RaisedCardBody className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-muted-foreground text-xs">
              {bauwerk} · {t('derivations.rule')}
            </p>
            <p className="mt-0.5 text-2xl font-semibold tracking-tight tabular-nums">
              {value ?? (derivation.hochhaus ? '—' : t('derivations.open'))}
            </p>
          </div>
          {suggestion?.state === 'confirmed' && <Badge variant="success">{t('derivations.confirmed')}</Badge>}
          {suggestion?.state === 'suggested' && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={locked}
              aria-label={t('derivations.confirmAria', { value: value ?? '', bauwerk })}
              onClick={() => void onDecide([{ key: suggestion.key, action: 'confirm' }])}
            >
              <Check aria-hidden />
              {t('derivations.confirm')}
            </Button>
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
                  <Chip variant={input.suggested ? 'warning' : 'muted'} title={inputText(input, t('derivations.suggestedMark'))}>
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
