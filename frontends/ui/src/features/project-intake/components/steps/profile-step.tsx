'use client'

import type { JSX } from 'react'
import { useRef } from 'react'
import { useTranslations } from '@/i18n'
import { CompleteFooter } from '../complete-footer'
import { ContradictionSection } from '../contradiction-section'
import { DerivationSection } from '../derivation-section'
import { DecisiveSection } from '../profile/decisive-section'
import { RulesSection } from '../profile/rules-section'
import { ReadingSkeleton } from '../reading-skeleton'
import { ReviewSection } from '../review-section'
import type { SetupStepProps } from './types'

export interface ProfileStepProps extends SetupStepProps {
  onComplete: () => Promise<boolean>
}

/**
 * Step 5, Steckbrief (ticket 26, `docs/design/project-setup-five-steps.md`), in
 * the ticket's order: Widersprüche first; then the values that decide a
 * Gebäudeklasse, one by one; then the rest by topic, taken in one go after
 * discarding what is wrong; then the derivations (the class per Bauwerk, the
 * Hochhaus) to confirm; then which Richtlinien apply, computed from what is
 * confirmed; and the finish, which says what stays open and where it goes.
 * Every value carries its source, its confidence in words and the excerpt of
 * the page it was read from.
 *
 * Nothing here is set for the person: each value is a suggestion until they
 * take it, the class included („Vorschlagen, nicht setzen“).
 */
export function ProfileStep({ view, canDecide, busy, onDecide, onComplete, onGoTo }: ProfileStepProps): JSX.Element {
  const t = useTranslations('intakeProfileStep')
  const top = useRef<HTMLDivElement | null>(null)
  const decide = { canDecide, busy, onDecide }
  // A Rückfrage is answered in its own step; a contradiction here, at the top.
  const resolve = () => {
    if (view.questions.length > 0) onGoTo('questions')
    else top.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
  }
  return (
    <div className="space-y-8" data-testid="setup-step-profile">
      <div ref={top} className="scroll-mt-24">
        <ContradictionSection items={view.contradictions} {...decide} />
      </div>
      <DecisiveSection groups={view.groups} {...decide} />
      <ReviewSection
        groups={view.groups}
        apart
        label={t('rest.heading')}
        description={t('rest.description')}
        {...decide}
      />
      {view.status === 'reading' && <ReadingSkeleton />}
      <DerivationSection derivations={view.derivations} {...decide} />
      <RulesSection view={view} />
      <CompleteFooter view={view} busy={busy} onComplete={onComplete} onResolve={resolve} />
    </div>
  )
}
