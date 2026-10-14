'use client'

import type { JSX } from 'react'
import { Button } from '@/components/ui/button'
import { RaisedCard, RaisedCardBody } from '@/components/ui/raised-card'
import { useTranslations } from '@/i18n'
import type { IntakeDecision, ProfileEvidence, Suggestion } from '@/lib/project-intake/types'
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
 * Widersprüche first: every key whose documents disagree, its values side by
 * side, each with where it was found. Choosing one confirms it (the profile's
 * own value, or the alternative at its index); an alternative can also be
 * discarded, which Piloti remembers so it is not suggested again.
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
  const locked = !canDecide || busy

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
              <RaisedCardBody>
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-semibold">{item.label}</h3>
                  {item.decisive && (
                    <DecisiveBadge label={t('review.decisive')} title={t('review.decisiveHint')} />
                  )}
                </div>
                <ul className="mt-3 divide-y sm:grid sm:auto-cols-fr sm:grid-flow-col sm:divide-y-0">
                  {optionsOf(item).map((option) => (
                    <li
                      key={option.alternativeIndex ?? 'current'}
                      className="flex min-w-0 flex-col items-start gap-2 py-3 first:pt-0 last:pb-0 sm:border-l sm:py-0 sm:pl-5 sm:pr-3 sm:first:border-l-0 sm:first:pl-0"
                    >
                      <p className="text-muted-foreground text-xs">
                        {option.alternativeIndex === undefined ? t('contradictions.current') : t('contradictions.found')}
                      </p>
                      <p className="text-base font-medium break-words">{option.display}</p>
                      <EvidenceChips evidence={option.evidence} />
                      <div className="mt-auto flex flex-wrap gap-2 pt-1">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={locked}
                          aria-label={t('contradictions.useAria', { value: option.display, label: item.label })}
                          onClick={() =>
                            void onDecide([
                              {
                                key: item.key,
                                action: 'confirm',
                                ...(option.alternativeIndex === undefined
                                  ? {}
                                  : { alternativeIndex: option.alternativeIndex }),
                              },
                            ])
                          }
                        >
                          {t('contradictions.use')}
                        </Button>
                        {option.alternativeIndex !== undefined && (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            disabled={locked}
                            aria-label={t('contradictions.discardAria', { value: option.display, label: item.label })}
                            onClick={() =>
                              void onDecide([
                                { key: item.key, action: 'dismiss', alternativeIndex: option.alternativeIndex },
                              ])
                            }
                          >
                            {t('contradictions.discard')}
                          </Button>
                        )}
                      </div>
                    </li>
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
