'use client'

/**
 * Creating a project: a name, and whether it is running or already over.
 *
 * A closed project is how an office brings a past project in as a reference
 * (ADR-0098): it is created closed, with the facts a close would have asked
 * for (how it ended, Beginn, Abschluss), rather than created running and then
 * walked through the three-step close dialog. Those facts reuse the close
 * dialog's rules and wording: the outcome is chosen, never preselected, and the
 * Abschluss is bounded by `abschlussBounds`.
 */

import type { JSX } from 'react'
import { useState } from 'react'
import { useStore } from '@tanstack/react-form'
import { Archive, CircleCheck, CircleSlash, PlayCircle } from 'lucide-react'
import { z } from 'zod'
import { useAppForm } from '@/components/form'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { ChoiceCard, ChoiceCardGroup } from '@/components/ui/choice-card'
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible'
import { DialogFooter } from '@/components/ui/dialog'
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { MonthInput } from '@/components/ui/month-input'
import { createProject } from '@/app/app/(shell)/projects/actions'
import { useLocale, useTranslations } from '@/i18n'
import { capturePosthog } from '@/lib/analytics/posthog'
import { currentMonth, isMonth, type Month } from '@/lib/projects/month'
import { abschlussBounds, abschlussProblem, defaultAbschluss, type ProjectOutcome } from '@/lib/projects/project-status'

export type CreateProjectState = 'active' | 'closed'
type AbschlussProblem = ReturnType<typeof abschlussProblem>

export interface CreateProjectFormProps {
  /** Leaves without creating anything; the dialog closes itself. */
  onCancel?: () => void
}

/** What the server action may name as the reason a closed project was refused. */
const SERVER_REASONS: Readonly<Record<string, Exclude<AbschlussProblem, null>>> = {
  'abschluss-in-future': 'future',
  'abschluss-before-beginn': 'beforeStart',
}

const startedOnOf = (value: string): Month | null => (isMonth(value) ? value : null)

export function CreateProjectForm({ onCancel }: CreateProjectFormProps): JSX.Element {
  const t = useTranslations('projects')
  const [thisMonth] = useState(() => currentMonth())
  const [serverError, setServerError] = useState<string | null>(null)
  const [serverAbschluss, setServerAbschluss] = useState<AbschlussProblem>(null)

  // On the name field, not the form: a form-level validator re-runs when the
  // Stand changes, and the blur of choosing a card would flag an untouched,
  // empty name as an error. The submit button stays disabled until it is set.
  const nameSchema = z.string().trim().min(1, t('form.nameRequired')).max(255, t('form.nameTooLong'))

  const form = useAppForm({
    defaultValues: {
      name: '',
      state: 'active' as CreateProjectState,
      outcome: '' as ProjectOutcome | '',
      startedOn: '',
      endedOn: defaultAbschluss(null, null, thisMonth) as string,
    },
    onSubmit: async ({ value }) => {
      setServerError(null)
      setServerAbschluss(null)
      const result = await createProject({}, toFormData(value))
      if (!result?.error) {
        capturePosthog('project_created', { state: value.state })
        return
      }
      const reason = result.reason ? SERVER_REASONS[result.reason] : undefined
      if (reason) {
        setServerAbschluss(reason)
        return
      }
      console.error('[CreateProjectForm] create failed:', result.error)
      // The server action can surface vendor/database exception text. Never
      // show that to an architect: log it, show a calm message.
      setServerError(t('form.createError'))
    },
  })

  const values = useStore(form.store, (state) => state.values)
  const isSubmitting = useStore(form.store, (state) => state.isSubmitting)
  const closed = values.state === 'closed'
  const abschlussError =
    serverAbschluss ?? abschlussProblem(values.endedOn, startedOnOf(values.startedOn), thisMonth)
  const nameValid = values.name.trim().length > 0 && values.name.trim().length <= 255
  const ready = nameValid && (!closed || (values.outcome !== '' && abschlussError === null))

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        event.stopPropagation()
        if (ready) void form.handleSubmit()
      }}
      className="flex flex-col gap-5"
      noValidate
    >
      <form.AppField name="name" validators={{ onChange: nameSchema }}>
        {(field) => (
          <field.TextField
            label={t('form.nameLabel')}
            placeholder={t('form.namePlaceholder')}
            autoFocus
            autoComplete="off"
            disabled={isSubmitting}
          />
        )}
      </form.AppField>

      <form.Field name="state">
        {(field) => (
          <Field>
            <FieldLabel id="create-project-state-label">{t('form.state.label')}</FieldLabel>
            <ChoiceCardGroup
              value={field.state.value}
              onValueChange={(next) => field.handleChange(next === 'closed' ? 'closed' : 'active')}
              aria-labelledby="create-project-state-label"
              disabled={isSubmitting}
              className="sm:grid-cols-2"
            >
              <ChoiceCard
                value="active"
                icon={PlayCircle}
                label={t('form.state.active')}
                hint={t('form.state.activeHint')}
              />
              <ChoiceCard
                value="closed"
                icon={Archive}
                label={t('form.state.closed')}
                hint={t('form.state.closedHint')}
              />
            </ChoiceCardGroup>
          </Field>
        )}
      </form.Field>

      <Collapsible open={closed}>
        <CollapsibleContent>
          <FieldGroup className="gap-5" data-testid="create-project-closed">
            <form.Field name="outcome">
              {(field) => (
                <OutcomeField
                  value={field.state.value}
                  onChange={(next) => field.handleChange(next)}
                  disabled={isSubmitting}
                />
              )}
            </form.Field>
            <PeriodFields
              startedOn={values.startedOn}
              endedOn={values.endedOn}
              thisMonth={thisMonth}
              problem={abschlussError}
              disabled={isSubmitting}
              onStartedOn={(next) => {
                setServerAbschluss(null)
                form.setFieldValue('startedOn', next)
              }}
              onEndedOn={(next) => {
                setServerAbschluss(null)
                form.setFieldValue('endedOn', next)
              }}
            />
            <p className="text-muted-foreground text-sm" data-testid="create-project-closed-note">
              {t('form.closed.readOnly')}
            </p>
          </FieldGroup>
        </CollapsibleContent>
      </Collapsible>

      {serverError && (
        <Alert variant="destructive">
          <AlertDescription>{serverError}</AlertDescription>
        </Alert>
      )}

      <DialogFooter className="pt-1">
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel} disabled={isSubmitting}>
            {t('form.cancel')}
          </Button>
        )}
        <form.AppForm>
          <form.SubmitButton disabled={!ready}>
            {closed ? t('form.submitClosed') : t('form.submit')}
          </form.SubmitButton>
        </form.AppForm>
      </DialogFooter>
    </form>
  )
}

/** The action's fields: `name` and `state` always; a closed project's facts only when it is closed. */
function toFormData(value: {
  name: string
  state: CreateProjectState
  outcome: string
  startedOn: string
  endedOn: string
}): FormData {
  const formData = new FormData()
  formData.set('name', value.name.trim())
  formData.set('state', value.state)
  if (value.state !== 'closed') return formData
  formData.set('outcome', value.outcome)
  formData.set('startedOn', value.startedOn)
  formData.set('endedOn', value.endedOn)
  return formData
}

function OutcomeField({
  value,
  onChange,
  disabled,
}: {
  value: ProjectOutcome | ''
  onChange: (value: ProjectOutcome) => void
  disabled: boolean
}): JSX.Element {
  const t = useTranslations('projects')
  return (
    <Field>
      <FieldLabel id="create-project-outcome-label">{t('lifecycle.closeDialog.outcome.label')}</FieldLabel>
      <ChoiceCardGroup
        value={value}
        onValueChange={(next) => onChange(next === 'cancelled' ? 'cancelled' : 'completed')}
        aria-labelledby="create-project-outcome-label"
        aria-required
        disabled={disabled}
        className="sm:grid-cols-2"
      >
        <ChoiceCard
          value="completed"
          icon={CircleCheck}
          label={t('lifecycle.outcome.completed')}
          hint={t('lifecycle.closeDialog.outcome.completedHint')}
        />
        <ChoiceCard
          value="cancelled"
          icon={CircleSlash}
          label={t('lifecycle.outcome.cancelled')}
          hint={t('lifecycle.closeDialog.outcome.cancelledHint')}
        />
      </ChoiceCardGroup>
    </Field>
  )
}

interface PeriodFieldsProps {
  startedOn: string
  endedOn: string
  thisMonth: Month
  problem: AbschlussProblem
  disabled: boolean
  onStartedOn: (value: string) => void
  onEndedOn: (value: string) => void
}

/** Beginn (optional) and Abschluss (required), side by side from `sm` up. */
function PeriodFields({
  startedOn,
  endedOn,
  thisMonth,
  problem,
  disabled,
  onStartedOn,
  onEndedOn,
}: PeriodFieldsProps): JSX.Element {
  const t = useTranslations('projects')
  const { locale } = useLocale()
  const bounds = abschlussBounds(startedOnOf(startedOn), thisMonth)
  const placeholder = { month: t('steckbrief.month'), year: t('steckbrief.year') }
  const problemCopy =
    problem === 'beforeStart' ? t('form.closed.endedOnBeforeStart') : problem ? t(`lifecycle.closeDialog.endedOn.${problem}`) : null

  return (
    <div className="grid gap-5 sm:grid-cols-2 sm:gap-4">
      <Field>
        <FieldLabel htmlFor="create-project-started-on">
          {t('form.closed.startedOn')}
          <span className="text-muted-foreground font-normal">({t('form.closed.optional')})</span>
        </FieldLabel>
        <MonthInput
          id="create-project-started-on"
          value={startedOn}
          onChange={onStartedOn}
          locale={locale}
          monthLabel={`${t('form.closed.startedOn')}, ${t('steckbrief.month')}`}
          yearLabel={`${t('form.closed.startedOn')}, ${t('steckbrief.year')}`}
          placeholder={placeholder}
          clearLabel={t('form.closed.clearStartedOn')}
          toYear={Number(thisMonth.slice(0, 4))}
          disabled={disabled}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="create-project-ended-on">{t('lifecycle.closeDialog.endedOn.label')}</FieldLabel>
        <MonthInput
          id="create-project-ended-on"
          value={endedOn}
          onChange={onEndedOn}
          locale={locale}
          monthLabel={`${t('lifecycle.closeDialog.endedOn.label')}, ${t('steckbrief.month')}`}
          yearLabel={`${t('lifecycle.closeDialog.endedOn.label')}, ${t('steckbrief.year')}`}
          placeholder={placeholder}
          fromYear={bounds.min ? Number(bounds.min.slice(0, 4)) : undefined}
          toYear={Number(bounds.max.slice(0, 4))}
          invalid={problem !== null}
          disabled={disabled}
        />
        {problemCopy && <FieldError id="create-project-ended-on-error">{problemCopy}</FieldError>}
      </Field>
    </div>
  )
}
