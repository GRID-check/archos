'use client'

import type { JSX } from 'react'
import { CompleteFooter } from '../complete-footer'
import { ContradictionSection } from '../contradiction-section'
import { DerivationSection } from '../derivation-section'
import { ReviewSection } from '../review-section'
import type { SetupStepProps } from './types'

export interface ProfileStepProps extends SetupStepProps {
  onComplete: () => Promise<boolean>
}

/**
 * Step 5, Steckbrief (stub): contradictions first, the decisive values one by
 * one, the rest at once, the derivations, finishing. Owned by the step-5 build.
 */
export function ProfileStep({ view, canDecide, busy, onDecide, onComplete, onGoTo }: ProfileStepProps): JSX.Element {
  const decide = { canDecide, busy, onDecide }
  return (
    <div className="space-y-8" data-testid="setup-step-profile">
      <ContradictionSection items={view.contradictions} {...decide} />
      <ReviewSection groups={view.groups} {...decide} />
      <DerivationSection derivations={view.derivations} {...decide} />
      <CompleteFooter view={view} busy={busy} onComplete={onComplete} onResolve={() => onGoTo('questions')} />
    </div>
  )
}
