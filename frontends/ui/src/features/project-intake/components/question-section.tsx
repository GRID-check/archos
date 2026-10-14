'use client'

import type { JSX } from 'react'
import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { RaisedCard, RaisedCardBody } from '@/components/ui/raised-card'
import { QuestionControl } from '@/features/projects/components/intake-question-field'
import { useTranslations } from '@/i18n'
import { isIntakeAnswerProvided } from '@/lib/project-profile/intake-definition'
import type { ProjectPrimitiveValue } from '@/lib/project-profile/types'
import type { IntakeDecision, Need } from '@/lib/project-intake/types'
import { questionOfNeed } from '../lib/display'
import { DocumentHandIn } from './document-hand-in'
import { IntakeSection } from './intake-atoms'

/**
 * Rückfragen: the decisive needs no document has answered. Each is the
 * wizard's own control for that question (`QuestionControl`), with why Piloti
 * asks, where the answer is usually found, a „Nicht bekannt", and a place to
 * hand in the document that has it.
 */
export function QuestionSection({
  questions,
  canDecide,
  busy,
  onDecide,
  onFiles,
}: {
  questions: readonly Need[]
  canDecide: boolean
  busy: boolean
  onDecide: (decisions: IntakeDecision[]) => Promise<boolean>
  onFiles: (files: File[]) => void
}): JSX.Element | null {
  const t = useTranslations('projectIntake')
  if (questions.length === 0) return null
  return (
    <IntakeSection
      label={t('questions.heading')}
      count={questions.length}
      description={t('questions.description')}
      testId="intake-questions"
    >
      <ul className="space-y-3">
        {questions.map((need) => (
          <li key={need.key}>
            <QuestionCard need={need} canDecide={canDecide} busy={busy} onDecide={onDecide} onFiles={onFiles} />
          </li>
        ))}
      </ul>
    </IntakeSection>
  )
}

function QuestionCard({
  need,
  canDecide,
  busy,
  onDecide,
  onFiles,
}: {
  need: Need
  canDecide: boolean
  busy: boolean
  onDecide: (decisions: IntakeDecision[]) => Promise<boolean>
  onFiles: (files: File[]) => void
}): JSX.Element {
  const t = useTranslations('projectIntake')
  const question = useMemo(() => questionOfNeed(need), [need])
  const [draft, setDraft] = useState<ProjectPrimitiveValue>(need.type === 'multi_select' ? [] : '')
  const locked = !canDecide || busy

  return (
    <RaisedCard data-testid={`intake-question-${need.key}`}>
      <RaisedCardBody className="space-y-3">
        <QuestionControl
          question={question}
          answerKey={need.key}
          answers={{ [need.key]: draft }}
          error={null}
          onSetAnswer={(_key, value) => setDraft(value)}
          onSetMode={() => undefined}
        />
        {need.foundIn.length > 0 && (
          <p className="text-muted-foreground text-xs">
            {t('questions.foundIn', { documents: need.foundIn.join(', ') })}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            disabled={locked || !isIntakeAnswerProvided(draft)}
            aria-label={t('questions.answerAria', { label: need.label })}
            onClick={() => void onDecide([{ key: need.key, action: 'answer', value: draft }])}
          >
            {t('questions.answer')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={locked}
            aria-label={t('questions.unknownAria', { label: need.label })}
            onClick={() => void onDecide([{ key: need.key, action: 'unknown' }])}
          >
            {t('questions.unknown')}
          </Button>
        </div>
        <DocumentHandIn label={need.label} onFiles={onFiles} disabled={!canDecide} />
      </RaisedCardBody>
    </RaisedCard>
  )
}
