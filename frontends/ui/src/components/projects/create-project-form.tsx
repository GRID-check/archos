'use client'

/**
 * Creating a project: a name, an address, a line about it, whether it is
 * running or already over, and who sets it up.
 *
 * Piloti sets the project up (ADR-0111): the address seeds the profile, „Worum
 * geht es?" tells the reading what the project is, and a project folder dropped
 * on the dialog names the project and is filed once it exists. That is not a
 * choice the dialog asks for; one link under the fields switches to „Selbst
 * ausfüllen", the wizard exactly as before, which asks for none of that here.
 *
 * A closed project is how an office brings a past project in as a reference
 * (ADR-0098): it is created closed, with the facts a close would have asked
 * for (how it ended, Beginn, Abschluss), rather than created running and then
 * walked through the three-step close dialog. Those facts reuse the close
 * dialog's rules and wording: the outcome is chosen, never preselected, and the
 * Abschluss is bounded by `abschlussBounds`.
 */

import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { useStore } from '@tanstack/react-form'
import { Archive, CircleCheck, CircleSlash, FolderInput, PencilLine, PlayCircle, Sparkles, X } from 'lucide-react'
import { z } from 'zod'
import { useAppForm } from '@/components/form'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { ChoiceCard, ChoiceCardGroup } from '@/components/ui/choice-card'
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible'
import { DialogFooter } from '@/components/ui/dialog'
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { MonthInput } from '@/components/ui/month-input'
import { AddressField, type AddressFieldProps, type AddressValue } from './address-field'
import { createProject } from '@/app/app/(shell)/projects/actions'
import { FileDropOverlay, useWindowDragGuard } from '@/features/documents/components/file-drop-overlay'
import { useFileDragDrop } from '@/features/documents/hooks/use-file-drag-drop'
import {
  discardDroppedFiles,
  handOverDroppedFiles,
  NEW_PROJECT_DROP_KEY,
} from '@/features/documents/lib/dropped-file-handover'
import { useLocale, useTranslations } from '@/i18n'
import { capturePosthog } from '@/lib/analytics/posthog'
import { MAX_INTAKE_DESCRIPTION_LENGTH } from '@/lib/project-intake/types'
import type { ProjectSetup } from '@/lib/projects/create-project-schema'
import { currentMonth, isMonth, type Month } from '@/lib/projects/month'
import { abschlussBounds, abschlussProblem, defaultAbschluss, type ProjectOutcome } from '@/lib/projects/project-status'

export type CreateProjectState = 'active' | 'closed'
type AbschlussProblem = ReturnType<typeof abschlussProblem>

export interface CreateProjectFormProps {
  /** Leaves without creating anything; the dialog closes itself. */
  onCancel?: () => void
  /** The address lookups; the real ones unless the `/dev` preview brings fixtures. */
  addressClients?: Pick<AddressFieldProps, 'client' | 'sameAddressClient'>
}

/** What the server action may name as the reason a closed project was refused. */
const SERVER_REASONS: Readonly<Record<string, Exclude<AbschlussProblem, null>>> = {
  'abschluss-in-future': 'future',
  'abschluss-before-beginn': 'beforeStart',
}

const startedOnOf = (value: string): Month | null => (isMonth(value) ? value : null)

/** What was dropped on the dialog: the folder's name, and how many files wait for the project. */
interface DroppedFolder {
  name: string | null
  count: number
}

/** The name a dropped folder (or a lone ZIP) gives a project: its top folder, else the archive's name. */
export function folderNameOf(files: readonly File[]): string | null {
  const pathOf = (file: File): string => file.webkitRelativePath ?? ''
  const nested = files.find((file) => pathOf(file).includes('/'))
  if (nested) return pathOf(nested).split('/')[0] || null
  if (files.length === 1 && /\.zip$/i.test(files[0].name)) return files[0].name.replace(/\.zip$/i, '')
  return null
}

export function CreateProjectForm({ onCancel, addressClients }: CreateProjectFormProps): JSX.Element {
  const t = useTranslations('projects')
  const tFiles = useTranslations('files')
  const [thisMonth] = useState(() => currentMonth())
  const [serverError, setServerError] = useState<string | null>(null)
  const [serverAbschluss, setServerAbschluss] = useState<AbschlussProblem>(null)
  const [dropped, setDropped] = useState<DroppedFolder | null>(null)
  // A drop is held for the setup page only while the dialog may still create the
  // project; closing it any other way discards the files.
  const created = useRef(false)
  // Focusing the name opens the soft keyboard the moment the dialog appears, on
  // top of the fields and the action. Only a fine pointer is taken to be at a
  // keyboard already; where the media query cannot be asked (an old engine, a
  // test renderer) the desktop behaviour stays.
  const [focusNameOnOpen] = useState(() =>
    typeof window === 'undefined' || typeof window.matchMedia !== 'function'
      ? true
      : window.matchMedia('(pointer: fine)').matches,
  )

  // On the name field, not the form: a form-level validator re-runs when the
  // Stand changes, and the blur of choosing a card would flag an untouched,
  // empty name as an error. The submit button stays disabled until it is set.
  const nameSchema = z.string().trim().min(1, t('form.nameRequired')).max(255, t('form.nameTooLong'))

  const form = useAppForm({
    defaultValues: {
      name: '',
      setup: 'piloti' as ProjectSetup,
      address: { text: '', place: null } as AddressValue,
      description: '',
      state: 'active' as CreateProjectState,
      outcome: '' as ProjectOutcome | '',
      startedOn: '',
      endedOn: defaultAbschluss(null, null, thisMonth) as string,
    },
    onSubmit: async ({ value }) => {
      setServerError(null)
      setServerAbschluss(null)
      // Only a project Piloti sets up has a setup page to take a drop: one held
      // for a project the person fills in would wait for the NEXT project
      // Piloti reads, and be filed there.
      if (value.setup === 'self') forgetDrop()
      created.current = true
      const result = await createProject({}, toFormData(value))
      if (!result?.error) {
        capturePosthog('project_created', { state: value.state, setup: value.setup })
        return
      }
      created.current = false
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

  useEffect(
    () => () => {
      if (!created.current) discardDroppedFiles(NEW_PROJECT_DROP_KEY)
    },
    []
  )
  /** Let go of a held drop, and of the note that names it. */
  function forgetDrop(): void {
    discardDroppedFiles(NEW_PROJECT_DROP_KEY)
    setDropped(null)
  }

  const values = useStore(form.store, (state) => state.values)
  const isSubmitting = useStore(form.store, (state) => state.isSubmitting)
  const closed = values.state === 'closed'
  const piloti = values.setup === 'piloti'
  const abschlussError =
    serverAbschluss ?? abschlussProblem(values.endedOn, startedOnOf(values.startedOn), thisMonth)
  const nameValid = values.name.trim().length > 0 && values.name.trim().length <= 255
  const ready = nameValid && (!closed || (values.outcome !== '' && abschlussError === null))

  // A project folder dropped on the dialog names the project (when it has no
  // name yet) and waits, with its files, for the project to exist. Dropping it
  // is asking for Piloti to read it, so the setup follows.
  const takeDrop = (files: File[]): void => {
    if (files.length === 0) return
    const folder = folderNameOf(files)
    handOverDroppedFiles(NEW_PROJECT_DROP_KEY, files)
    setDropped((previous) => ({ name: folder ?? previous?.name ?? null, count: (previous?.count ?? 0) + files.length }))
    form.setFieldValue('setup', 'piloti')
    if (folder && form.getFieldValue('name').trim() === '') form.setFieldValue('name', folder)
  }
  const { isDragging, isUnsupportedDrag, dragHandlers } = useFileDragDrop({
    onDrop: takeDrop,
    disabled: isSubmitting,
    acceptZip: true,
  })
  useWindowDragGuard()

  return (
    <div className="relative" {...dragHandlers} data-testid="create-project-drop">
      {isDragging && (
        <FileDropOverlay
          isUnsupported={isUnsupportedDrag}
          uploadLabel={t('form.drop.overlay')}
          unsupportedLabel={tFiles('workspace.dropUnsupported')}
          testId="create-project-drop-overlay"
        />
      )}
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
              autoFocus={focusNameOnOpen}
              autoComplete="off"
              disabled={isSubmitting}
            />
          )}
        </form.AppField>

        <Collapsible open={piloti}>
          <CollapsibleContent>
            <FieldGroup className="gap-5" data-testid="create-project-piloti-fields">
              <form.Field name="address">
                {(address) => (
                  <AddressField
                    value={address.state.value}
                    onChange={address.handleChange}
                    disabled={isSubmitting}
                    {...addressClients}
                  />
                )}
              </form.Field>
              <form.AppField name="description" validators={{ onChange: z.string().max(MAX_INTAKE_DESCRIPTION_LENGTH) }}>
                {(field) => (
                  <field.TextAreaField
                    label={t('form.description.label')}
                    description={t('form.description.help')}
                    placeholder={t('form.description.placeholder')}
                    maxLength={MAX_INTAKE_DESCRIPTION_LENGTH}
                    rows={3}
                    disabled={isSubmitting}
                  />
                )}
              </form.AppField>
            </FieldGroup>
          </CollapsibleContent>
        </Collapsible>

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
                {piloti ? t('form.closed.readOnlyPiloti') : t('form.closed.readOnly')}
              </p>
            </FieldGroup>
          </CollapsibleContent>
        </Collapsible>

        {dropped && (
          <DroppedFolderNote
            dropped={dropped}
            onRemove={forgetDrop}
          />
        )}

        {/* Who sets the project up is not a question for the person creating
            it: Piloti does, and the next page is where the documents go. The
            wizard stays one quiet switch away, for an office that would rather
            answer the questions itself (pilot onboardings, 2026-10). */}
        <form.Field name="setup">
          {(field) => (
            <SetupLine
              setup={field.state.value}
              showDropHint={!dropped}
              disabled={isSubmitting}
              onChange={(next) => {
                // Filling it in oneself asks for no reading, so a held folder
                // is let go of here, where the reader sees its note go.
                if (next === 'self') forgetDrop()
                field.handleChange(next)
              }}
            />
          )}
        </form.Field>

        {serverError && (
          <Alert variant="destructive">
            <AlertDescription>{serverError}</AlertDescription>
          </Alert>
        )}

        {/* On a phone `DialogContent` pins the footer to the bottom edge while
            the fields scroll: the form is longer than the viewport once Piloti
            sets it up. Cancel and the action share one row (the action takes
            the width) so the bar costs one button's height. */}
        <DialogFooter className="pt-1 phone:pt-3 max-sm:flex-row max-sm:items-center max-sm:gap-3 max-sm:[&>:last-child]:flex-1">
          {onCancel && (
            <Button type="button" variant="ghost" onClick={onCancel} disabled={isSubmitting}>
              {t('form.cancel')}
            </Button>
          )}
          <form.AppForm>
            <form.SubmitButton disabled={!ready}>
              {closed && !piloti ? t('form.submitClosed') : t('form.submit')}
            </form.SubmitButton>
          </form.AppForm>
        </DialogFooter>
      </form>
    </div>
  )
}

/**
 * How the project gets set up, as one line rather than a choice to make: Piloti
 * reads the documents (with the hint that a folder may be dropped here), or the
 * person answers the wizard's questions. Each says how to switch to the other.
 */
function SetupLine({
  setup,
  showDropHint,
  disabled,
  onChange,
}: {
  setup: ProjectSetup
  showDropHint: boolean
  disabled: boolean
  onChange: (next: ProjectSetup) => void
}): JSX.Element {
  const t = useTranslations('projects')
  const piloti = setup === 'piloti'
  const Icon = piloti ? Sparkles : PencilLine
  return (
    <div className="text-muted-foreground flex items-start gap-2.5 text-xs" data-testid="create-project-setup">
      <Icon className="mt-px size-3.5 shrink-0" aria-hidden />
      <p className="min-w-0 leading-relaxed">
        {piloti ? t('form.setup.pilotiLine') : t('form.setup.selfLine')}
        {piloti && showDropHint && (
          // Dragging a folder onto the window is a desktop gesture; on a touch
          // device the sentence describes something the reader cannot do.
          <span className="pointer-coarse:hidden" data-testid="create-project-drop-hint">
            {' '}
            {t('form.drop.hint')}
          </span>
        )}{' '}
        <Button
          type="button"
          variant="link"
          className="text-foreground h-auto p-0 text-xs font-medium"
          disabled={disabled}
          onClick={() => onChange(piloti ? 'self' : 'piloti')}
        >
          {piloti ? t('form.setup.switchToSelf') : t('form.setup.switchToPiloti')}
        </Button>
      </p>
    </div>
  )
}

function DroppedFolderNote({ dropped, onRemove }: { dropped: DroppedFolder; onRemove: () => void }): JSX.Element {
  const t = useTranslations('projects')
  return (
    <div
      className="bg-muted/50 border-border flex items-center gap-3 rounded-lg border px-3.5 py-2.5"
      data-testid="create-project-dropped"
    >
      <FolderInput className="text-muted-foreground size-4 shrink-0" aria-hidden />
      <p className="min-w-0 flex-1 text-sm">
        {dropped.name
          ? t('form.drop.held', { name: dropped.name, count: dropped.count })
          : t('form.drop.heldNoName', { count: dropped.count })}
      </p>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={onRemove}
        aria-label={t('form.drop.remove')}
        title={t('form.drop.remove')}
      >
        <X aria-hidden />
      </Button>
    </div>
  )
}

/**
 * The action's fields. `name`, `state` and `setup` always; the closed project's facts only when it is
 * closed; the address (the chosen hit, else the typed line) and the description only when Piloti sets it up.
 */
function toFormData(value: {
  name: string
  setup: ProjectSetup
  address: AddressValue
  description: string
  state: CreateProjectState
  outcome: string
  startedOn: string
  endedOn: string
}): FormData {
  const formData = new FormData()
  formData.set('name', value.name.trim())
  formData.set('state', value.state)
  formData.set('setup', value.setup)
  if (value.setup === 'piloti') {
    if (value.description.trim() !== '') formData.set('description', value.description.trim())
    if (value.address.place) formData.set('location', JSON.stringify(value.address.place))
    else if (value.address.text.trim() !== '') formData.set('address', value.address.text.trim())
  }
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
    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 sm:gap-4">
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
