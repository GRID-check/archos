'use client'

/**
 * The wizard's field renderer, one control per question type: text, number,
 * number with its answer mode, yes/no, select, chips. Lifted out of
 * `project-intake-wizard.tsx` unchanged so the setup page's Rückfragen
 * (`features/project-intake`) ask a question with the very same control the
 * wizard does, and the two cannot drift.
 */

import { useId, useState } from 'react'
import { HelpCircle } from 'lucide-react'
import { motion, springGlide } from '@/components/motion'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { modeKeyFor } from '@/lib/project-profile/intake-definition'
import type { IntakeAnswerMode, ProjectIntakeQuestion } from '@/lib/project-profile/intake-definition'
import type { ProjectPrimitiveValue } from '@/lib/project-profile/types'
import { useTranslations } from '@/i18n'

type Answers = Record<string, ProjectPrimitiveValue>

/**
 * The control a question is answered with, by its type, with its label and its
 * „Warum fragen wir das?". The wizard's field and the setup page's Rückfragen
 * render the very same one.
 */
export function QuestionControl({
  question,
  answerKey,
  answers,
  error,
  onSetAnswer,
  onSetMode,
}: {
  question: ProjectIntakeQuestion
  answerKey: string
  answers: Answers
  error: string | null
  onSetAnswer: (key: string, value: ProjectPrimitiveValue) => void
  onSetMode: (key: string, mode: IntakeAnswerMode) => void
}) {
  const t = useTranslations('projects')
  const value = answers[answerKey]
  const domId = `q-${answerKey}`
  const header = <QuestionHeader question={question} domId={domId} />
  const errorText = error ? (
    <p id={`${domId}-error`} className="text-destructive text-sm">
      {error}
    </p>
  ) : null

  switch (question.type) {
    case 'text':
      return (
        <div className="flex flex-col gap-2">
          {header}
          <Input
            id={domId}
            type="text"
            value={typeof value === 'string' ? value : ''}
            placeholder={question.placeholder}
            aria-invalid={error ? true : undefined}
            // Return is „Weiter“ here (the form's submit goes to the next
            // module), and the key says so.
            enterKeyHint="next"
            onChange={(e) => onSetAnswer(answerKey, e.target.value)}
            className="max-w-md"
          />
          {errorText}
        </div>
      )
    case 'textarea':
      return (
        <div className="flex flex-col gap-2">
          {header}
          <Textarea
            id={domId}
            value={typeof value === 'string' ? value : ''}
            placeholder={question.placeholder}
            onChange={(e) => onSetAnswer(answerKey, e.target.value)}
            className="min-h-24 max-w-2xl"
          />
          {errorText}
        </div>
      )
    case 'number':
      return (
        <div className="flex flex-col gap-2">
          {header}
          <div className="flex items-center gap-2">
            <Input
              id={domId}
              type="number"
              inputMode="decimal"
              placeholder={question.placeholder}
              value={typeof value === 'number' ? value : typeof value === 'string' ? value : ''}
              aria-invalid={error ? true : undefined}
              onChange={(e) => {
                const raw = e.target.value
                if (raw === '') return onSetAnswer(answerKey, '')
                const parsed = Number(raw)
                onSetAnswer(answerKey, Number.isFinite(parsed) ? parsed : raw)
              }}
              className="max-w-40"
            />
            {/* The unit beside the field: „1250“ alone does not say m² or m. */}
            {question.unit && <span className="text-muted-foreground text-sm">{question.unit}</span>}
          </div>
          {errorText}
        </div>
      )
    case 'number_tri':
      return (
        <div className="flex flex-col gap-2">
          {header}
          <NumberTriControl
            domId={domId}
            question={question}
            value={value}
            mode={(answers[modeKeyFor(answerKey)] as IntakeAnswerMode) ?? 'value'}
            onValue={(v) => onSetAnswer(answerKey, v)}
            onMode={(m) => onSetMode(answerKey, m)}
          />
          {errorText}
        </div>
      )
    case 'yes_no_open':
      return (
        <div className="flex flex-col gap-2">
          {header}
          <Segmented
            ariaLabel={question.label}
            value={typeof value === 'string' ? value : ''}
            options={[
              { value: 'yes', label: t('intake.yes') },
              { value: 'no', label: t('intake.no') },
              { value: 'open', label: t('intake.open'), tone: 'muted' },
            ]}
            onChange={(v) => onSetAnswer(answerKey, v)}
          />
          {errorText}
        </div>
      )
    case 'boolean':
      return (
        <div className="flex flex-col gap-2">
          {header}
          <Segmented
            ariaLabel={question.label}
            value={value === true ? 'yes' : value === false ? 'no' : ''}
            options={[
              { value: 'yes', label: t('intake.yes') },
              { value: 'no', label: t('intake.no') },
            ]}
            onChange={(v) => onSetAnswer(answerKey, v === 'yes')}
          />
          {errorText}
        </div>
      )
    case 'single_select':
      return (
        <div className="flex flex-col gap-2">
          {header}
          <Select
            value={typeof value === 'string' ? value : ''}
            onValueChange={(v) => onSetAnswer(answerKey, v)}
          >
            <SelectTrigger
              id={domId}
              className="w-full max-w-md"
              aria-invalid={error ? true : undefined}
            >
              <SelectValue placeholder={t('intake.selectPlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              {(question.options ?? []).map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {errorText}
        </div>
      )
    case 'multi_select':
      return (
        <div className="flex flex-col gap-2">
          {header}
          <ChipMultiSelect
            question={question}
            value={Array.isArray(value) ? value : []}
            onChange={(next) => onSetAnswer(answerKey, next)}
          />
          {errorText}
        </div>
      )
    default:
      return null
  }
}

export function QuestionHeader({ question, domId }: { question: ProjectIntakeQuestion; domId: string }) {
  const t = useTranslations('projects')
  const [whyOpen, setWhyOpen] = useState(false)
  const whyId = `${domId}-why`
  return (
    <div className="flex flex-col gap-1">
      {/* `items-center` on touch: the rationale glyph beside the label is a full
          44px control there, and baseline alignment would hang it off the label's
          text baseline instead of centring it in the row it now defines. */}
      <div className="flex items-baseline gap-2 pointer-coarse:items-center">
        <Label htmlFor={domId} className="text-sm font-medium">
          {question.label}
          {/* Mark the handful of hard-required fields so they're distinguishable
              from the ~90 soft ones BEFORE Next is pressed (error prevention),
              mirroring the FieldShell required marker used elsewhere. */}
          {question.required && (
            <span aria-hidden className="text-destructive">
              {' '}
              *
            </span>
          )}
        </Label>
        {question.optional && (
          <span className="text-muted-foreground text-xs font-normal">{t('intake.optional')}</span>
        )}
        {/* The rationale rides ON the label row as a glyph rather than under it
            as its own "Warum fragen wir das?" line. Nearly every question in the
            catalog carries a `why`, so a per-field row put a second, louder
            control beside every label — an accordion the length of the form
            competing with the questions it annotates. */}
        {question.why && (
          <button
            type="button"
            onClick={() => setWhyOpen((previous) => !previous)}
            aria-expanded={whyOpen}
            aria-controls={whyId}
            aria-label={t('intake.why')}
            title={t('intake.why')}
            // 44px of REAL layout space, not a negative-margin overhang.
            //
            // The overhang is the tempting version — it grows the target and
            // moves nothing — and it is wrong here because this control has
            // neighbours on every side it would grow into: the `<Label>` is 8px
            // to its left and the field it annotates is 4px below. A 14px
            // overhang therefore covers the end of the label (which focuses the
            // field) and the top edge of the field itself, so the two taps a
            // reader is most likely to make in this row would both open the
            // rationale instead. A target that big by theft is worse than a
            // small one: it is wrong on purpose rather than by omission.
            //
            // The cost is the honest one — the label row is 44px tall on touch.
            // `pointer-coarse:items-center` below keeps the glyph and the label
            // aligned once the row is taller than its baseline.
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/40 pointer-coarse:size-11 inline-flex size-4 shrink-0 items-center justify-center self-center rounded-full outline-none transition-colors duration-quick ease-out focus-visible:ring-2 motion-reduce:transition-none"
          >
            <HelpCircle className="size-3.5" aria-hidden />
          </button>
        )}
      </div>
      {question.why && whyOpen && (
        // A quiet tinted surface with the card radius, rather than a second
        // differently-alpha'd action ink, and no side stripe
        // (grid-design-language.md, "Emphasis without a stripe").
        <p
          id={whyId}
          className="bg-muted text-muted-foreground max-w-prose rounded-md px-3 py-2 text-xs"
        >
          {question.why}
        </p>
      )}
      {question.help && <p className="text-muted-foreground text-xs">{question.help}</p>}
    </div>
  )
}

/** Number input with a value/estimate/open answer-mode segmented control. */
export function NumberTriControl({
  domId,
  question,
  value,
  mode,
  onValue,
  onMode,
}: {
  domId: string
  question: ProjectIntakeQuestion
  value: ProjectPrimitiveValue
  mode: IntakeAnswerMode
  onValue: (v: ProjectPrimitiveValue) => void
  onMode: (m: IntakeAnswerMode) => void
}) {
  const t = useTranslations('projects')
  const disabled = mode === 'open'
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={domId}
          type="number"
          inputMode="decimal"
          disabled={disabled}
          placeholder={question.placeholder}
          value={typeof value === 'number' ? value : typeof value === 'string' ? value : ''}
          onChange={(e) => {
            const raw = e.target.value
            if (raw === '') return onValue('')
            const parsed = Number(raw)
            onValue(Number.isFinite(parsed) ? parsed : raw)
          }}
          className="max-w-32 font-mono"
        />
        {question.unit && (
          <span className="text-muted-foreground font-mono text-xs">{question.unit}</span>
        )}
        <Segmented
          ariaLabel={t('intake.mode.aria')}
          size="sm"
          value={mode}
          options={[
            { value: 'value', label: t('intake.mode.wert') },
            { value: 'estimated', label: t('intake.mode.geschaetzt'), tone: 'warning' },
            { value: 'open', label: t('intake.mode.offen'), tone: 'muted' },
          ]}
          onChange={(v) => onMode(v as IntakeAnswerMode)}
        />
      </div>
      {question.hint && <p className="text-muted-foreground max-w-xl text-xs">{question.hint}</p>}
    </div>
  )
}

type SegmentTone = 'default' | 'warning' | 'muted'

/** A compact segmented single-choice control (yes/no/open, answer modes). */
export function Segmented({
  value,
  options,
  onChange,
  ariaLabel,
  size = 'md',
}: {
  value: string
  options: { value: string; label: string; tone?: SegmentTone }[]
  onChange: (value: string) => void
  ariaLabel: string
  size?: 'sm' | 'md'
}) {
  // One pill per control: several Segmented share a page, so the shared-layout
  // id is scoped to this instance or the fill would fly between questions.
  const pillId = useId()
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="border-border inline-flex w-fit flex-wrap self-start overflow-hidden rounded-lg border"
    >
      {options.map((opt, i) => {
        const active = value === opt.value
        const tone = opt.tone ?? 'default'
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(opt.value)}
            className={cn(
              'border-border relative isolate inline-flex items-center justify-center transition-colors duration-quick ease-out motion-reduce:transition-none',
              i > 0 && 'border-l',
              // The pointer decides, not the width: a finger gets 44px on a phone
              // and on a tablet past `md` alike, a cursor gets the dense size on
              // a narrow desktop window too. (`sm` was 36px on a phone, and a
              // segment beside a number field is exactly where a thumb lands.)
              size === 'sm'
                ? 'min-h-8 px-2.5 text-[11px] font-medium pointer-coarse:min-h-11 pointer-coarse:px-3.5 pointer-coarse:text-xs'
                : 'min-h-9 px-3.5 text-sm pointer-coarse:min-h-11 pointer-coarse:px-4',
              !active && 'bg-card text-foreground hover:bg-muted',
              active && tone === 'default' && 'text-primary-foreground',
              active && tone === 'warning' && 'text-white',
              active && tone === 'muted' && 'text-background'
            )}
          >
            {active && (
              <motion.span
                layoutId={pillId}
                transition={springGlide}
                aria-hidden="true"
                className={cn(
                  'absolute inset-0 -z-10',
                  tone === 'default' && 'bg-primary',
                  tone === 'warning' && 'bg-warning',
                  tone === 'muted' && 'bg-muted-foreground'
                )}
              />
            )}
            <span className="relative">{opt.label}</span>
          </button>
        )
      })}
    </div>
  )
}

/** Multi-select rendered as toggleable chips. */
export function ChipMultiSelect({
  question,
  value,
  onChange,
}: {
  question: ProjectIntakeQuestion
  value: string[]
  onChange: (next: string[]) => void
}) {
  return (
    <div className="flex max-w-2xl flex-wrap gap-2">
      {(question.options ?? []).map((opt) => {
        const active = value.includes(opt.value)
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={active}
            onClick={() =>
              onChange(active ? value.filter((v) => v !== opt.value) : [...value, opt.value])
            }
            className={cn(
              'inline-flex min-h-9 items-center justify-center rounded-full border px-3.5 py-1.5 text-sm transition-colors duration-quick ease-out motion-reduce:transition-none pointer-coarse:min-h-11 pointer-coarse:px-4',
              active
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border bg-card text-foreground hover:border-primary/50 hover:bg-primary/5'
            )}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}
