'use client'

import type { JSX, ReactNode } from 'react'
import { useMemo, useState } from 'react'
import { ArrowRight } from 'lucide-react'
import { BusyButton } from '@/components/ui/busy-button'
import { Button } from '@/components/ui/button'
import { RaisedCard, RaisedCardBody } from '@/components/ui/raised-card'
import { QuestionControl } from '@/features/projects/components/intake-question-field'
import { useTranslations } from '@/i18n'
import { isIntakeAnswerProvided } from '@/lib/project-profile/intake-conditions'
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

/**
 * One need's answer: the wizard's own control for its question, where the
 * value is usually found, „Übernehmen", and (unless the caller offers it for
 * several needs at once) „Nicht bekannt". Shared by the question card and a
 * document request, which may hold more than one need.
 */
export function NeedAnswer({
  need,
  canDecide,
  busy,
  onDecide,
  withUnknown = true,
  showFoundIn = true,
  trailing,
}: {
  need: Need
  canDecide: boolean
  busy: boolean
  onDecide: (decisions: IntakeDecision[]) => Promise<boolean>
  /** Offer „Nicht bekannt" for this need alone. */
  withUnknown?: boolean
  /** Say where the value is usually found; off where the document is already named. */
  showFoundIn?: boolean
  /** A further control in the row (the interview's „Überspringen"). */
  trailing?: ReactNode
}): JSX.Element {
  const t = useTranslations('projectIntake')
  const question = useMemo(() => questionOfNeed(need), [need])
  const [draft, setDraft] = useState<ProjectPrimitiveValue>(need.type === 'multi_select' ? [] : '')
  const [answering, answer] = usePressed()
  const [markingUnknown, markUnknown] = usePressed()

  return (
    <div className="space-y-3" data-testid={`intake-need-${need.key}`}>
      <QuestionControl
        question={question}
        answerKey={need.key}
        answers={{ [need.key]: draft }}
        error={null}
        onSetAnswer={(_key, value) => setDraft(value)}
        onSetMode={() => undefined}
      />
      {showFoundIn && need.foundIn.length > 0 && (
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
        {withUnknown && (
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
        )}
        {trailing}
      </div>
    </div>
  )
}

export function QuestionCard({
  need,
  canDecide,
  busy,
  onDecide,
  onFiles,
  onSkip,
  position,
}: {
  need: Need
  canDecide: boolean
  busy: boolean
  onDecide: (decisions: IntakeDecision[]) => Promise<boolean>
  /** Where the answer's document may be handed in; absent, the card offers none. */
  onFiles?: (files: File[], info?: DropInfo) => void
  /** Leave the question for later without saying anything about it. */
  onSkip?: () => void
  /** „Frage 2 von 9", when the card is one of a series. */
  position?: string
}): JSX.Element {
  const t = useTranslations('projectIntake')
  return (
    <RaisedCard data-testid={`intake-question-${need.key}`}>
      <RaisedCardBody className="divide-border divide-y p-0">
        <div className="space-y-3 px-4 pt-3.5 pb-3">
          {position && <p className="text-muted-foreground text-xs tabular-nums">{position}</p>}
          <NeedAnswer
            need={need}
            canDecide={canDecide}
            busy={busy}
            onDecide={onDecide}
            trailing={
              onSkip && (
                <Button type="button" size="sm" variant="ghost" className="sm:ml-auto" onClick={onSkip}>
                  {t('interview.skip')}
                  <ArrowRight aria-hidden />
                </Button>
              )
            }
          />
        </div>
        {onFiles && (
          <div className="px-2 py-1.5">
            <DocumentHandIn label={need.label} onFiles={onFiles} disabled={!canDecide} />
          </div>
        )}
      </RaisedCardBody>
    </RaisedCard>
  )
}

/**
 * Weitere Angaben: every need no document and no person has answered that
 * decides no class, asked one at a time in the wizard's order. This is the
 * interview: with no documents at all it is how a project is set up by hand,
 * so creating a project needs no choice between Piloti and the wizard. Each
 * question can be answered, marked unknown, or skipped for now; an answered
 * one leaves the list when the review is read again, a skipped one only for
 * this visit.
 */
export function InterviewSection({
  needs,
  canDecide,
  busy,
  onDecide,
  bare = false,
}: {
  needs: readonly Need[]
  canDecide: boolean
  busy: boolean
  onDecide: (decisions: IntakeDecision[]) => Promise<boolean>
  /** Without its own heading: the caller frames it (step 4 folds it away). */
  bare?: boolean
}): JSX.Element | null {
  const t = useTranslations('projectIntake')
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(() => new Set())
  const waiting = needs.filter((need) => !skipped.has(need.key))
  if (needs.length === 0) return null
  const current = waiting[0]
  const answered = needs.length - waiting.length
  const body = (
    <>
      {current ? (
        // Keyed by the question: a new one starts with an empty draft.
        <QuestionCard
          key={current.key}
          need={current}
          canDecide={canDecide}
          busy={busy}
          onDecide={onDecide}
          onSkip={() => setSkipped((previous) => new Set(previous).add(current.key))}
          position={t('interview.position', { index: answered + 1, total: needs.length })}
        />
      ) : (
        <p className="text-muted-foreground rounded-lg border border-dashed px-4 py-5 text-sm" data-testid="intake-interview-skipped">
          {t('interview.allSkipped', { count: skipped.size })}{' '}
          <Button type="button" variant="link" className="h-auto p-0 text-sm" onClick={() => setSkipped(new Set())}>
            {t('interview.again')}
          </Button>
        </p>
      )}
    </>
  )
  if (bare) return <div data-testid="intake-interview">{body}</div>
  return (
    <IntakeSection
      label={t('interview.heading')}
      count={needs.length}
      description={t('interview.description')}
      testId="intake-interview"
    >
      {body}
    </IntakeSection>
  )
}
