'use client'

import type { JSX, ReactNode } from 'react'
import { useMemo, useState } from 'react'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import type { DropInfo } from '@/features/documents/hooks/use-file-drag-drop'
import { QuestionControl } from '@/features/projects/components/intake-question-field'
import { useTranslations } from '@/i18n'
import { isIntakeAnswerProvided } from '@/lib/project-profile/intake-conditions'
import type { ProjectPrimitiveValue } from '@/lib/project-profile/types'
import type { DocumentRequest, IntakeDecision, Need, ProfileEvidence, Suggestion } from '@/lib/project-intake/types'
import { cn } from '@/lib/utils'
import { usePressed } from '../../hooks/use-pressed'
import { displayValue, questionOfNeed } from '../../lib/display'
import { EvidenceChips } from '../evidence-chips'
import { HandInRow } from './hand-in-row'
import { QuestionShell, type QuestionPosition, type RoundFooter } from './question-shell'

/** What every kind of question is handed by the step. */
interface RoundQuestionProps {
  position: QuestionPosition
  footer: RoundFooter
  canDecide: boolean
  busy: boolean
  onDecide: (decisions: IntakeDecision[]) => Promise<boolean>
  /** Where a document is handed in; absent where the project takes none. */
  onFiles?: (files: File[], info?: DropInfo) => void
  /** The question is settled here: what was given, for the list. */
  onDone: (value: string) => void
  /** Put the question off for this visit and go on. */
  onPutOff: () => void
  after?: ReactNode
}

const emptyDraft = (need: Need): ProjectPrimitiveValue => (need.type === 'multi_select' ? [] : '')

/**
 * The wizard's own control for a need (`intake-question-field.tsx`), with its
 * label row hidden from sight where the card's heading already asks the
 * question. The row stays for a screen reader: it is the field's label. The
 * rationale glyph is left out, since the card says why in words. Choices are
 * drawn at the mockup's size: 48px tall, wide enough to hit, full width on a
 * phone.
 */
function NeedControl({
  need,
  value,
  onChange,
  labelled,
}: {
  need: Need
  value: ProjectPrimitiveValue
  onChange: (value: ProjectPrimitiveValue) => void
  /** Show the field's own label (a request asks several); hidden where the heading is the question. */
  labelled: boolean
}): JSX.Element {
  const question = useMemo(() => {
    const { why: _why, ...rest } = questionOfNeed(need)
    return rest
  }, [need])
  return (
    <div
      data-testid={`intake-need-${need.key}`}
      className={cn(
        '[&_[aria-pressed]]:min-h-12 [&_[aria-pressed]]:min-w-[120px] [&_[aria-pressed]]:text-[15px]',
        'max-md:[&_[aria-pressed]]:flex-1 max-md:[&_[role=group]]:w-full',
        !labelled && '[&>div>div:first-child]:sr-only'
      )}
    >
      <QuestionControl
        question={question}
        answerKey={need.key}
        answers={{ [need.key]: value }}
        error={null}
        onSetAnswer={(_key, next) => onChange(next)}
        onSetMode={() => undefined}
      />
    </div>
  )
}

/** „Einreichplan (Grundriss) oder Baubeschreibung": where an answer usually stands, at most two. */
function useWhere(): (documents: readonly string[]) => string | null {
  const t = useTranslations('intakeQuestionsStep')
  return (documents) => (documents.length === 0 ? null : documents.slice(0, 2).join(` ${t('or')} `))
}

/** A need no document answered: the decisive ones, and the register's own (Bundesland, Vorhaben). */
export function NeedQuestion({ need, ...props }: RoundQuestionProps & { need: Need }): JSX.Element {
  const t = useTranslations('intakeQuestionsStep')
  const where = useWhere()
  const [draft, setDraft] = useState<ProjectPrimitiveValue>(() => emptyDraft(need))
  const [submitting, submit] = usePressed()
  const [skipping, skip] = usePressed()
  const { onDecide, onDone, onFiles } = props
  return (
    <QuestionShell
      testId={`intake-question-${need.key}`}
      position={props.position}
      title={need.label}
      description={need.why}
      footer={props.footer}
      after={props.after}
      actions={{
        canDecide: props.canDecide,
        busy: props.busy,
        canSubmit: isIntakeAnswerProvided(draft),
        submitting,
        onSubmit: () =>
          submit(async () => {
            if (await onDecide([{ key: need.key, action: 'answer', value: draft }])) onDone(displayValue(need.key, draft))
          }),
        skipLabel: t('card.unknown'),
        skipBusyLabel: t('card.unknownBusy'),
        skipAria: t('card.unknownAria', { label: need.label }),
        skipping,
        onSkip: () =>
          skip(async () => {
            if (await onDecide([{ key: need.key, action: 'unknown' }])) onDone(t('value.unknown'))
          }),
      }}
      handIn={
        onFiles && (
          <HandInRow
            where={where(need.foundIn)}
            label={need.label}
            onFiles={onFiles}
            onHandedIn={() => onDone(t('value.handedIn'))}
            disabled={!props.canDecide}
          />
        )
      }
    >
      <NeedControl need={need} value={draft} onChange={setDraft} labelled={false} />
    </QuestionShell>
  )
}

/**
 * A document the location register asks for: the document by its name, why
 * (for this Bundesland and Gemeinde), the law it rests on, its values to
 * state directly with the wizard's controls, and the hand-in. „Weiß ich
 * nicht" marks every open value of it as not known in one decision.
 */
export function RequestQuestion({
  request,
  ...props
}: RoundQuestionProps & { request: DocumentRequest }): JSX.Element {
  const t = useTranslations('intakeQuestionsStep')
  const [drafts, setDrafts] = useState<Readonly<Record<string, ProjectPrimitiveValue>>>({})
  const [submitting, submit] = usePressed()
  const [skipping, skip] = usePressed()
  const { onDecide, onDone, onFiles, onPutOff } = props
  const needs = request.needs
  const draftOf = (need: Need): ProjectPrimitiveValue => drafts[need.key] ?? emptyDraft(need)
  const given = needs.filter((need) => isIntakeAnswerProvided(draftOf(need)))
  const sources = request.sources.map((source) => source.title).join(' · ')
  return (
    <QuestionShell
      testId={`document-request-${request.determinant}`}
      position={props.position}
      title={request.document}
      description={request.reason}
      meta={sources ? t('request.sources', { sources }) : undefined}
      footer={props.footer}
      after={props.after}
      actions={{
        canDecide: props.canDecide,
        busy: props.busy,
        canSubmit: given.length > 0,
        submitting,
        onSubmit: () =>
          submit(async () => {
            const ok = await onDecide(given.map((need) => ({ key: need.key, action: 'answer', value: draftOf(need) })))
            // Settled only when every value is given; the rest stays asked here.
            if (ok && given.length === needs.length) {
              onDone(given.map((need) => displayValue(need.key, draftOf(need))).join(' · '))
            }
          }),
        skipLabel: t('card.unknown'),
        skipBusyLabel: t('card.unknownBusy'),
        skipAria: t('request.unknownAria', { label: request.label }),
        skipping,
        onSkip: () => {
          if (needs.length === 0) return onPutOff()
          skip(async () => {
            if (await onDecide(needs.map((need) => ({ key: need.key, action: 'unknown' })))) onDone(t('value.unknown'))
          })
        },
      }}
      handIn={
        onFiles && (
          <HandInRow
            where={request.document}
            label={request.label}
            onFiles={onFiles}
            onHandedIn={() => onDone(t('value.handedIn'))}
            disabled={!props.canDecide}
          />
        )
      }
    >
      {needs.length > 0 ? (
        <div className="space-y-5">
          {needs.map((need) => (
            <NeedControl
              key={need.key}
              need={need}
              value={draftOf(need)}
              onChange={(value) => setDrafts((previous) => ({ ...previous, [need.key]: value }))}
              labelled
            />
          ))}
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">{t('request.documentOnly')}</p>
      )}
    </QuestionShell>
  )
}

/** One value a contradiction offers: the value on the profile, or an alternative found beside it. */
interface ContradictionOption {
  id: string
  display: string
  evidence: readonly ProfileEvidence[]
  alternativeIndex?: number
}

function optionsOf(item: Suggestion): ContradictionOption[] {
  return [
    { id: 'current', display: item.display, evidence: item.evidence },
    ...item.alternatives.map((alternative, alternativeIndex) => ({
      id: String(alternativeIndex),
      display: displayValue(item.key, alternative.value),
      evidence: alternative.evidence,
      alternativeIndex,
    })),
  ]
}

/** „Anzahl oberirdischer Geschoße: 6 oder 7?": a contradiction as the question it is. */
export function useContradictionTitle(): (item: Suggestion) => string {
  const t = useTranslations('intakeQuestionsStep')
  return (item) => {
    const values = optionsOf(item).map((option) => option.display)
    const last = values.pop() ?? ''
    const choice = values.length > 0 ? `${values.join(', ')} ${t('or')} ${last}` : last
    return t('contradiction.title', { label: item.label, values: choice })
  }
}

/**
 * Two documents disagree: each value with where it was found, and the person
 * picks the one that holds, which confirms it (the profile's own value, or the
 * alternative at its index). Put off, it stays open for the Steckbrief.
 */
export function ContradictionQuestion({
  item,
  ...props
}: RoundQuestionProps & { item: Suggestion }): JSX.Element {
  const t = useTranslations('intakeQuestionsStep')
  const title = useContradictionTitle()
  const options = optionsOf(item)
  const [picked, setPicked] = useState<string>('')
  const [submitting, submit] = usePressed()
  const { onDecide, onDone, onPutOff } = props
  const chosen = options.find((option) => option.id === picked)
  return (
    <QuestionShell
      testId={`intake-contradiction-${item.key}`}
      position={props.position}
      title={title(item)}
      description={t('contradiction.description')}
      footer={props.footer}
      after={props.after}
      actions={{
        canDecide: props.canDecide,
        busy: props.busy,
        canSubmit: chosen !== undefined,
        submitting,
        onSubmit: () =>
          submit(async () => {
            if (!chosen) return
            const decision: IntakeDecision = {
              key: item.key,
              action: 'confirm',
              ...(chosen.alternativeIndex === undefined ? {} : { alternativeIndex: chosen.alternativeIndex }),
            }
            if (await onDecide([decision])) onDone(chosen.display)
          }),
        skipLabel: t('card.later'),
        skipBusyLabel: t('card.later'),
        skipAria: t('card.laterAria', { label: item.label }),
        skipping: false,
        onSkip: onPutOff,
      }}
    >
      <RadioGroup
        value={picked}
        onValueChange={setPicked}
        aria-label={t('contradiction.choose')}
        className="gap-2.5"
        disabled={!props.canDecide}
      >
        {options.map((option) => {
          const id = `${item.key}-${option.id}`
          return (
            <div
              key={option.id}
              className={cn(
                'border-border bg-card flex min-h-12 items-start gap-3 rounded-[10px] border px-4 py-3',
                'transition-colors duration-quick ease-out motion-reduce:transition-none',
                picked === option.id && 'border-primary ring-primary ring-1'
              )}
            >
              <RadioGroupItem value={option.id} id={id} className="mt-1" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <label htmlFor={id} className="block cursor-pointer text-[15px] font-medium">
                  {option.display}
                  <span className="text-muted-foreground ml-2 text-xs font-normal">
                    {option.alternativeIndex === undefined ? t('contradiction.current') : t('contradiction.found')}
                  </span>
                </label>
                <EvidenceChips evidence={option.evidence} />
              </div>
            </div>
          )
        })}
      </RadioGroup>
    </QuestionShell>
  )
}
