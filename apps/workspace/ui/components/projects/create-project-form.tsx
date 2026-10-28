'use client'

/**
 * Creating a project: a name, an address, a line about it, and whether it is
 * running or already over. Nothing about how it is set up.
 *
 * Every project lands on its setup (ADR-0111): the documents, the questions
 * they leave open, the profile to confirm. Answering the questions without any
 * documents is how a project is filled in by hand, so the dialog no longer asks
 * „Piloti richtet ein" or „Selbst ausfüllen" (pilot onboardings, 2026-10: a
 * choice the person could not judge yet, and the wrong one led to a different
 * tool). The address seeds the profile, „Worum geht es?" tells the reading what
 * the project is, and a project folder dropped on the dialog names the project
 * and is filed once it exists.
 *
 * Laid out as the approved mockup (2026-10): name, address, the state as a
 * segmented control, a zone for the project folder (dropped anywhere on the
 * dialog, or chosen), and „Worum geht es?" folded behind a line.
 *
 * A closed project is how an office brings a past project in as a reference
 * (ADR-0098): it is created closed, with the facts a close would have asked
 * for (how it ended, Beginn, Abschluss), rather than created running and then
 * walked through the three-step close dialog. Those facts reuse the close
 * dialog's rules and wording: the outcome is chosen, never preselected, and the
 * Abschluss is bounded by `closingBounds`.
 */

import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { useStore } from '@tanstack/react-form'
import { FolderUp, Plus, X } from 'lucide-react'
import { z } from 'zod'
import { useAppForm } from '@/components/form'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible'
import { DialogFooter } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { MonthInput } from '@/components/ui/month-input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { AddressField, type AddressFieldProps, type AddressValue } from './address-field'
import { createProject } from '@/app/app/(shell)/projects/actions'
import {
  FileDropOverlay,
  useWindowDragGuard,
} from '@/features/documents/components/file-drop-overlay'
import { useFileDragDrop } from '@/features/documents/hooks/use-file-drag-drop'
import {
  discardDroppedFiles,
  handOverDroppedFiles,
  newProjectDropKey,
} from '@/features/documents/lib/dropped-file-handover'
import { useLocale, useTranslations } from '@/i18n'
import { filesCopy } from '@/i18n/namespaces/files'
import { projectsCopy } from '@/i18n/namespaces/projects'
import { capturePosthog } from '@/lib/analytics/posthog'
import { MAX_INTAKE_DESCRIPTION_LENGTH } from '@/lib/project-intake/types'
import { currentMonth, isMonth, type Month } from '@/lib/projects/month'
import {
  closingBounds,
  closingProblem,
  defaultClosing,
  type ProjectOutcome,
} from '@/lib/projects/project-status'
import { isRedirectSignal } from '@/lib/utils/redirect-signal'

export type CreateProjectState = 'active' | 'closed'
type AbschlussProblem = ReturnType<typeof closingProblem>

export interface CreateProjectFormProps {
  /** Leaves without creating anything; the dialog closes itself. */
  onCancel?: () => void
  /** The address lookups; the real ones unless the `/dev` preview brings fixtures. */
  addressClients?: Pick<AddressFieldProps, 'client' | 'sameAddressClient'>
  /** What the fields start with; the `/dev` preview shows the dialog filled in. */
  initial?: { name?: string; address?: string; description?: string }
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
  if (files.length === 1 && /\.zip$/i.test(files[0].name))
    return files[0].name.replace(/\.zip$/i, '')
  return null
}

export function CreateProjectForm({
  onCancel,
  addressClients,
  initial,
}: CreateProjectFormProps): JSX.Element {
  const t = useTranslations(projectsCopy)
  const tFiles = useTranslations(filesCopy)
  const [thisMonth] = useState(() => currentMonth())
  const [serverError, setServerError] = useState<string | null>(null)
  const [serverAbschluss, setServerAbschluss] = useState<AbschlussProblem>(null)
  const [dropped, setDropped] = useState<DroppedFolder | null>(null)
  const [describing, setDescribing] = useState(Boolean(initial?.description))
  // The key this dialog holds a drop under, and the one the created project's
  // setup page is sent to take it by: no other project can.
  const [dropKey] = useState(newProjectDropKey)
  // Whether files wait under it; a ref, because the form's submit handler is
  // made once and would read the first render's state.
  const holding = useRef(false)
  // A drop is held for the setup page only while the dialog may still create the
  // project; closing it any other way discards the files.
  const created = useRef(false)
  // Focusing the name opens the soft keyboard the moment the dialog appears, on
  // top of the fields and the action. Only a fine pointer is taken to be at a
  // keyboard already (and to drag folders); where the media query cannot be
  // asked (an old engine, a test renderer) the desktop behaviour stays.
  const [finePointer] = useState(() =>
    typeof window === 'undefined' || typeof window.matchMedia !== 'function'
      ? true
      : window.matchMedia('(pointer: fine)').matches
  )

  // On the name field, not the form: a form-level validator re-runs when the
  // Stand changes, and the blur of choosing a card would flag an untouched,
  // empty name as an error. The submit button stays disabled until it is set.
  const nameSchema = z
    .string()
    .trim()
    .min(1, t('form.nameRequired'))
    .max(255, t('form.nameTooLong'))

  const form = useAppForm({
    defaultValues: {
      name: initial?.name ?? '',
      address: { text: initial?.address ?? '', place: null } as AddressValue,
      description: initial?.description ?? '',
      state: 'active' as CreateProjectState,
      outcome: '' as ProjectOutcome | '',
      startedOn: '',
      endedOn: defaultClosing(null, null, thisMonth) as string,
    },
    onSubmit: async ({ value }) => {
      setServerError(null)
      setServerAbschluss(null)
      created.current = true
      let result: Awaited<ReturnType<typeof createProject>>
      try {
        result = await createProject({}, toFormData(value, holding.current ? dropKey : null))
      } catch (error) {
        // A created project answers with `redirect()`: Next has navigated to
        // it already and rejects the call with the redirect. That rejection is
        // the success, so it is recorded here and not rethrown; the held drop
        // goes on to the setup page the redirect named.
        if (isRedirectSignal(error)) {
          capturePosthog('project_created', { state: value.state, setup: 'piloti' })
          return
        }
        // Thrown for real (the network, the action itself): nothing was
        // created, so a held drop is let go of when the dialog closes, as for
        // any dialog that created nothing, and the person may try again.
        created.current = false
        console.error('[CreateProjectForm] create threw:', error)
        setServerError(t('form.createError'))
        return
      }
      if (!result?.error) {
        capturePosthog('project_created', { state: value.state, setup: 'piloti' })
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
      if (!created.current) discardDroppedFiles(dropKey)
    },
    [dropKey]
  )
  /** Let go of a held drop, and of the note that names it. */
  function forgetDrop(): void {
    discardDroppedFiles(dropKey)
    holding.current = false
    setDropped(null)
  }

  const values = useStore(form.store, (state) => state.values)
  const isSubmitting = useStore(form.store, (state) => state.isSubmitting)
  const closed = values.state === 'closed'
  const abschlussError =
    serverAbschluss ?? closingProblem(values.endedOn, startedOnOf(values.startedOn), thisMonth)
  const nameValid = values.name.trim().length > 0 && values.name.trim().length <= 255
  const ready = nameValid && (!closed || (values.outcome !== '' && abschlussError === null))

  // A project folder dropped on the dialog names the project (when it has no
  // name yet) and waits, with its files, for the project to exist. Dropping it
  // is asking for Piloti to read it.
  const takeDrop = (files: File[]): void => {
    if (files.length === 0) return
    const folder = folderNameOf(files)
    handOverDroppedFiles(dropKey, files)
    holding.current = true
    setDropped((previous) => ({
      name: folder ?? previous?.name ?? null,
      count: (previous?.count ?? 0) + files.length,
    }))
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
      <FileDropOverlay
        show={isDragging}
        isUnsupported={isUnsupportedDrag}
        uploadLabel={t('form.drop.overlay')}
        unsupportedLabel={tFiles('workspace.dropUnsupported')}
        testId="create-project-drop-overlay"
      />
      <form
        onSubmit={(event) => {
          event.preventDefault()
          event.stopPropagation()
          if (ready) void form.handleSubmit()
        }}
        className="flex flex-col gap-[18px]"
        noValidate
      >
        <form.AppField name="name" validators={{ onChange: nameSchema }}>
          {(field) => (
            <field.TextField
              label={t('form.nameLabel')}
              placeholder={t('form.namePlaceholder')}
              autoFocus={finePointer}
              autoComplete="off"
              disabled={isSubmitting}
            />
          )}
        </form.AppField>

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

        {/* The state and what a closed project adds stay one block, so the
            folded part costs no gap of its own while it is shut. */}
        <div className="flex flex-col">
          <form.Field name="state">
            {(field) => (
              <Field>
                <FieldLabel id="create-project-state-label">{t('form.state.label')}</FieldLabel>
                <Segmented
                  value={field.state.value}
                  onChange={(next) => field.handleChange(next === 'closed' ? 'closed' : 'active')}
                  labelledBy="create-project-state-label"
                  disabled={isSubmitting}
                  options={[
                    { value: 'active', label: t('form.state.active') },
                    { value: 'closed', label: t('form.state.closed') },
                  ]}
                />
              </Field>
            )}
          </form.Field>

          <Collapsible open={closed}>
            <CollapsibleContent>
              <FieldGroup className="gap-[18px] pt-[18px]" data-testid="create-project-closed">
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
                <p
                  className="text-muted-foreground text-xs"
                  data-testid="create-project-closed-note"
                >
                  {t('form.closed.readOnlyPiloti')}
                </p>
              </FieldGroup>
            </CollapsibleContent>
          </Collapsible>
        </div>

        <FolderZone
          dropped={dropped}
          finePointer={finePointer}
          disabled={isSubmitting}
          onPick={takeDrop}
          onRemove={forgetDrop}
        />

        {/* „Worum geht es?" helps the reading but is never needed to begin:
            folded behind a line until someone wants to write it. */}
        <Collapsible open={describing}>
          {!describing && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setDescribing(true)}
              disabled={isSubmitting}
              className="text-muted-foreground hover:text-foreground -mx-2 h-8 self-start px-2 text-[13px] font-normal hover:bg-transparent"
              data-testid="create-project-describe"
            >
              <Plus className="size-3.5" aria-hidden />
              {t('form.description.open')}
            </Button>
          )}
          <CollapsibleContent>
            <form.AppField
              name="description"
              validators={{ onChange: z.string().max(MAX_INTAKE_DESCRIPTION_LENGTH) }}
            >
              {(field) => (
                <field.TextAreaField
                  label={t('form.description.label')}
                  description={t('form.description.help')}
                  placeholder={t('form.description.placeholder')}
                  maxLength={MAX_INTAKE_DESCRIPTION_LENGTH}
                  rows={3}
                  // Opened by the line, the field takes the cursor; filled in
                  // from the start, nothing jumps to it.
                  autoFocus={!initial?.description}
                  disabled={isSubmitting}
                />
              )}
            </form.AppField>
          </CollapsibleContent>
        </Collapsible>

        {serverError && (
          <Alert variant="destructive">
            <AlertDescription>{serverError}</AlertDescription>
          </Alert>
        )}

        {/* On a phone `DialogContent` pins the footer to the bottom edge while
            the fields scroll. Cancel and the action share one row (the action
            takes the width) so the bar costs one button's height. */}
        <DialogFooter className="mt-2 gap-2.5 max-sm:flex-row max-sm:items-center max-sm:[&>:last-child]:flex-1">
          {onCancel && (
            <Button
              type="button"
              variant="ghost"
              onClick={onCancel}
              disabled={isSubmitting}
              className="h-10 px-4"
            >
              {t('form.cancel')}
            </Button>
          )}
          <form.AppForm>
            <form.SubmitButton disabled={!ready} className="h-10 px-[18px]">
              {t('form.submit')}
            </form.SubmitButton>
          </form.AppForm>
        </DialogFooter>
      </form>
    </div>
  )
}

/** Two or three choices side by side, one always set: the state, the outcome. */
function Segmented({
  value,
  onChange,
  options,
  labelledBy,
  disabled,
  required,
}: {
  value: string
  onChange: (value: string) => void
  options: ReadonlyArray<{ value: string; label: string }>
  labelledBy: string
  disabled: boolean
  required?: boolean
}): JSX.Element {
  return (
    <ToggleGroup
      type="single"
      segmented
      variant="outline"
      value={value}
      // A pressed segment pressed again would clear the group; it stays set.
      onValueChange={(next: string) => {
        if (next) onChange(next)
      }}
      aria-labelledby={labelledBy}
      aria-required={required}
      disabled={disabled}
      className="bg-muted gap-0.5 border-transparent p-[3px] shadow-none"
    >
      {options.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          className="h-[34px] border-0 px-4 shadow-none data-[state=off]:font-normal data-[state=on]:shadow-none"
        >
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

/**
 * Where the project folder goes: dragged onto the dialog (anywhere on it, the
 * zone only says so) or chosen. Under a finger there is no folder picker
 * (iOS opens the plain file sheet for `webkitdirectory`), so it offers files.
 * Once something is held the zone names it, and dropping more adds to it.
 */
function FolderZone({
  dropped,
  finePointer,
  disabled,
  onPick,
  onRemove,
}: {
  dropped: DroppedFolder | null
  finePointer: boolean
  disabled: boolean
  onPick: (files: File[]) => void
  onRemove: () => void
}): JSX.Element {
  const t = useTranslations(projectsCopy)
  const input = useRef<HTMLInputElement>(null)
  return (
    <div
      className="border-border bg-muted/40 flex items-center gap-3.5 rounded-xl border-[1.5px] border-dashed px-[18px] py-4 max-sm:px-4"
      data-testid={dropped ? 'create-project-dropped' : 'create-project-folder-zone'}
    >
      <span className="bg-muted flex size-10 shrink-0 items-center justify-center rounded-[10px]">
        <FolderUp className="size-5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        {dropped ? (
          <p className="text-sm font-medium">
            {dropped.name
              ? t('form.drop.held', { name: dropped.name, count: dropped.count })
              : t('form.drop.heldNoName', { count: dropped.count })}
          </p>
        ) : (
          <>
            <p className="text-sm font-medium">
              {finePointer ? t('form.drop.title') : t('form.drop.titleTouch')}
            </p>
            <p className="text-muted-foreground mt-0.5 text-xs">{t('form.drop.help')}</p>
          </>
        )}
      </div>
      {dropped ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onRemove}
          disabled={disabled}
          aria-label={t('form.drop.remove')}
          title={t('form.drop.remove')}
        >
          <X aria-hidden />
        </Button>
      ) : (
        <>
          <input
            ref={input}
            type="file"
            multiple
            className="hidden"
            // Both spellings, as strings: React forwards them only that way.
            {...(finePointer
              ? ({ webkitdirectory: '', directory: '' } as Record<string, string>)
              : {})}
            onChange={(event) => {
              onPick(Array.from(event.target.files ?? []))
              event.target.value = ''
            }}
            data-testid="create-project-folder-input"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => input.current?.click()}
            disabled={disabled}
            className="bg-card h-[34px] px-3 text-[13px]"
          >
            {t('form.drop.choose')}
          </Button>
        </>
      )}
    </div>
  )
}

/**
 * The action's fields. `name`, `state` and `setup` always; the address (the chosen hit, else the typed
 * line), the description and the held drop's key when given; the closed project's facts when it is closed.
 */
function toFormData(
  value: {
    name: string
    address: AddressValue
    description: string
    state: CreateProjectState
    outcome: string
    startedOn: string
    endedOn: string
  },
  dropKey: string | null
): FormData {
  const formData = new FormData()
  if (dropKey) formData.set('dropKey', dropKey)
  formData.set('name', value.name.trim())
  formData.set('state', value.state)
  formData.set('setup', 'piloti')
  if (value.description.trim() !== '') formData.set('description', value.description.trim())
  if (value.address.place) formData.set('location', JSON.stringify(value.address.place))
  else if (value.address.text.trim() !== '') formData.set('address', value.address.text.trim())
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
  const t = useTranslations(projectsCopy)
  return (
    <Field>
      <FieldLabel id="create-project-outcome-label">
        {t('lifecycle.closeDialog.outcome.label')}
      </FieldLabel>
      {/* Chosen, never preselected: a default would nudge the record. */}
      <Segmented
        value={value}
        onChange={(next) => onChange(next === 'cancelled' ? 'cancelled' : 'completed')}
        labelledBy="create-project-outcome-label"
        required
        disabled={disabled}
        options={[
          { value: 'completed', label: t('lifecycle.outcome.completed') },
          { value: 'cancelled', label: t('lifecycle.outcome.cancelled') },
        ]}
      />
      {value !== '' && (
        <FieldDescription>{t(`lifecycle.closeDialog.outcome.${value}Hint`)}</FieldDescription>
      )}
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

/** Beginn (optional) and Abschluss (required), one under the other: two month pickers do not fit the dialog's width side by side. */
function PeriodFields({
  startedOn,
  endedOn,
  thisMonth,
  problem,
  disabled,
  onStartedOn,
  onEndedOn,
}: PeriodFieldsProps): JSX.Element {
  const t = useTranslations(projectsCopy)
  const { locale } = useLocale()
  const bounds = closingBounds(startedOnOf(startedOn), thisMonth)
  const placeholder = { month: t('projectRecord.month'), year: t('projectRecord.year') }
  const problemCopy =
    problem === 'beforeStart'
      ? t('form.closed.endedOnBeforeStart')
      : problem
        ? t(`lifecycle.closeDialog.endedOn.${problem}`)
        : null

  return (
    <div className="grid grid-cols-1 gap-[18px]">
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
          monthLabel={`${t('form.closed.startedOn')}, ${t('projectRecord.month')}`}
          yearLabel={`${t('form.closed.startedOn')}, ${t('projectRecord.year')}`}
          placeholder={placeholder}
          clearLabel={t('form.closed.clearStartedOn')}
          toYear={Number(thisMonth.slice(0, 4))}
          disabled={disabled}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="create-project-ended-on">
          {t('lifecycle.closeDialog.endedOn.label')}
        </FieldLabel>
        <MonthInput
          id="create-project-ended-on"
          value={endedOn}
          onChange={onEndedOn}
          locale={locale}
          monthLabel={`${t('lifecycle.closeDialog.endedOn.label')}, ${t('projectRecord.month')}`}
          yearLabel={`${t('lifecycle.closeDialog.endedOn.label')}, ${t('projectRecord.year')}`}
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
