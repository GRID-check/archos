'use client'

import type { JSX } from 'react'
import { BusyButton } from '@/components/ui/busy-button'
import { RaisedCard, RaisedCardBody } from '@/components/ui/raised-card'
import { useTranslations } from '@/i18n'
import type { IntakeDecision, ProfileEvidence, Suggestion } from '@/lib/project-intake/types'
import { usePressed } from '../hooks/use-pressed'
import { displayValue } from '../lib/display'
import { DecisiveBadge, IntakeSection } from './intake-atoms'
import { EvidenceChips } from './evidence-chips'

/** One value a contradiction offers: the value on the profile, or an alternative found beside it. */
interface Option {
  display: string
  evidence: readonly ProfileEvidence[]
  /** Absent for the value on the profile; the alternative's index otherwise. */
  alternativeIndex?: number
}

function optionsOf(item: Suggestion): Option[] {
  return [
    { display: item.display, evidence: item.evidence },
    ...item.alternatives.map((alternative, alternativeIndex) => ({
      display: displayValue(item.key, alternative.value),
      evidence: alternative.evidence,
      alternativeIndex,
    })),
  ]
}

/**
 * Widersprüche first: every key whose documents disagree, its values one under
 * the other, each with where it was found. Choosing one confirms it (the
 * profile's own value, or the alternative at its index); an alternative can
 * also be discarded, which Piloti remembers so it is not suggested again.
 * One card per key, its values divided by hairlines: no box inside the box.
 */
export function ContradictionSection({
  items,
  canDecide,
  busy,
  onDecide,
}: {
  items: readonly Suggestion[]
  canDecide: boolean
  busy: boolean
  onDecide: (decisions: IntakeDecision[]) => Promise<boolean>
}): JSX.Element | null {
  const t = useTranslations('projectIntake')
  if (items.length === 0) return null

  return (
    <IntakeSection
      label={t('contradictions.heading')}
      count={items.length}
      description={t('contradictions.description')}
      testId="intake-contradictions"
    >
      <ul className="space-y-3">
        {items.map((item) => (
          <li key={item.key}>
            <RaisedCard>
              <RaisedCardBody className="p-0">
                <div className="flex flex-wrap items-center gap-2 px-4 pt-3.5 pb-3">
                  <h3 className="text-sm font-semibold break-words hyphens-auto">{item.label}</h3>
                  {item.decisive && (
                    <DecisiveBadge label={t('review.decisive')} title={t('review.decisiveHint')} />
                  )}
                </div>
                <ul className="divide-border divide-y border-t">
                  {optionsOf(item).map((option) => (
                    <OptionRow
                      key={option.alternativeIndex ?? 'current'}
                      item={item}
                      option={option}
                      canDecide={canDecide}
                      busy={busy}
                      onDecide={onDecide}
                    />
                  ))}
                </ul>
              </RaisedCardBody>
            </RaisedCard>
          </li>
        ))}
      </ul>
    </IntakeSection>
  )
}

function OptionRow({
  item,
  option,
  canDecide,
  busy,
  onDecide,
}: {
  item: Suggestion
  option: Option
  canDecide: boolean
  busy: boolean
  onDecide: (decisions: IntakeDecision[]) => Promise<boolean>
}): JSX.Element {
  const t = useTranslations('projectIntake')
  const [using, use] = usePressed()
  const [discarding, discard] = usePressed()
  const { alternativeIndex } = option
  return (
    <li className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="flex min-w-0 flex-col items-start gap-1.5">
        <p className="text-muted-foreground text-xs">
          {alternativeIndex === undefined ? t('contradictions.current') : t('contradictions.found')}
        </p>
        <p className="text-base font-medium break-words hyphens-auto">{option.display}</p>
        <EvidenceChips evidence={option.evidence} />
      </div>
      <div className="flex flex-wrap gap-2 sm:shrink-0 sm:justify-end">
        <BusyButton
          type="button"
          size="sm"
          variant="outline"
          disabled={!canDecide}
          busy={using}
          blocked={busy}
          busyLabel={t('busy.confirm')}
          aria-label={t('contradictions.useAria', { value: option.display, label: item.label })}
          onClick={() =>
            use(() =>
              onDecide([
                {
                  key: item.key,
                  action: 'confirm',
                  ...(alternativeIndex === undefined ? {} : { alternativeIndex }),
                },
              ])
            )
          }
        >
          {t('contradictions.use')}
        </BusyButton>
        {alternativeIndex !== undefined && (
          <BusyButton
            type="button"
            size="sm"
            variant="ghost"
            disabled={!canDecide}
            busy={discarding}
            blocked={busy}
            busyLabel={t('busy.dismiss')}
            aria-label={t('contradictions.discardAria', { value: option.display, label: item.label })}
            onClick={() => discard(() => onDecide([{ key: item.key, action: 'dismiss', alternativeIndex }]))}
          >
            {t('contradictions.discard')}
          </BusyButton>
        )}
      </div>
    </li>
  )
}
