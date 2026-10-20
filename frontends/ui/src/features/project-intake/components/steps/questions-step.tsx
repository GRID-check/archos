'use client'

import type { JSX } from 'react'
import { InterviewSection, QuestionSection } from '../question-section'
import type { SetupStepProps } from './types'

/**
 * Step 4, Rückfragen (stub): what the classification still needs, and the
 * documents to hand in. Owned by the step-4 build.
 */
export function QuestionsStep({ view, canDecide, busy, onDecide, onFiles }: SetupStepProps): JSX.Element {
  const decide = { canDecide, busy, onDecide }
  return (
    <div className="space-y-8" data-testid="setup-step-questions">
      <QuestionSection questions={view.questions} {...decide} onFiles={onFiles} />
      <InterviewSection needs={view.openQuestions} {...decide} />
    </div>
  )
}
