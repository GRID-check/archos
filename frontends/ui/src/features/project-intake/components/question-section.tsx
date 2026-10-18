'use client'

import type { JSX } from 'react'
import { useMemo, useState } from 'react'
import { BusyButton } from '@/components/ui/busy-button'
import { RaisedCard, RaisedCardBody } from '@/components/ui/raised-card'
import { QuestionControl } from '@/features/projects/components/intake-question-field'
import { useTranslations } from '@/i18n'
import { isIntakeAnswerProvided } from '@/lib/project-profile/intake-definition'
import type { ProjectPrimitiveValue } from '@/lib/project-profile/types'
import type { IntakeDecision, Need } from '@/lib/project-intake/types'
import { usePressed } from '../hooks/use-pressed'
import { questionOfNeed } from '../lib/display'
import { DocumentHandIn } from './document-hand-in'
import { IntakeSection } from './intake-atoms'
import type { DropInfo } from '@/features/documents/hooks/use-file-drag-drop'

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
  onFiles: (files: File[], info?: DropInfo) => void
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
  onFiles: (files: File[], info?: DropInfo) => void
}): JSX.Element {
  const t = useTranslations('projectIntake')
  const question = useMemo(() => questionOfNeed(need), [need])
  const [draft, setDraft] = useState<ProjectPrimitiveValue>(need.type === 'multi_select' ? [] : '')
  const [answering, answer] = usePressed()
  const [markingUnknown, markUnknown] = usePressed()

  return (
    <RaisedCard data-testid={`intake-question-${need.key}`}>
      <RaisedCardBody className="divide-border divide-y p-0">
        <div className="space-y-3 px-4 pt-3.5 pb-3">
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
            <BusyButton
              type="button"
              size="sm"
              disabled={!canDecide || !isIntakeAnswerProvided(draft)}
              busy={answering}
              blocked={busy}
              busyLabel={t('busy.confirm')}
              aria-label={t('questions.answerAria', { label: need.label })}
              onClick={() => answer(() => onDecide([{ key: need.key, action: 'answer', value: draft }]))}
            >
              {t('questions.answer')}
            </BusyButton>
            <BusyButton
              type="button"
              size="sm"
              variant="ghost"
              disabled={!canDecide}
              busy={markingUnknown}
              blocked={busy}
              busyLabel={t('busy.unknown')}
              aria-label={t('questions.unknownAria', { label: need.label })}
              onClick={() => markUnknown(() => onDecide([{ key: need.key, action: 'unknown' }]))}
            >
              {t('questions.unknown')}
            </BusyButton>
          </div>
        </div>
        <div className="px-2 py-1.5">
          <DocumentHandIn label={need.label} onFiles={onFiles} disabled={!canDecide} />
        </div>
      </RaisedCardBody>
    </RaisedCard>
  )
}
