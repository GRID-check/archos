'use client'

/**
 * The form for one person on the project: an external added by hand (Name,
 * Funktion, Firma), or a member or an external described afterwards. A
 * member's name is their account's and is not edited here.
 *
 * Deliberately three fields, the Steckbrief's own minimum (ADR-0091): no
 * e-mail, no phone. The months a person worked on the project stay in the
 * Steckbrief's editor on the overview; the setup asks only what it needs.
 */

import { useId, useState, type FormEvent, type JSX } from 'react'
import { BusyButton } from '@/components/ui/busy-button'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { useTranslations } from '@/i18n'

export interface PersonDraft {
  name: string
  function: string
  company: string
}

/** The functions offered at one tap, as dictionary keys: the ones every project of an office has. */
const COMMON_FUNCTIONS = ['client', 'lead', 'structural', 'physics', 'mep', 'electrical', 'fire', 'survey', 'supervision'] as const

/** „Funktion im Projekt": free text, with the common ones a tap away. */
export function FunctionField({
  value,
  onChange,
  autoFocus = false,
}: {
  value: string
  onChange: (value: string) => void
  autoFocus?: boolean
}): JSX.Element {
  const t = useTranslations('intakeProjectStep')
  const id = useId()
  return (
    <Field>
      <FieldLabel htmlFor={id}>{t('people.function')}</FieldLabel>
      <Input
        id={id}
        maxLength={200}
        autoFocus={autoFocus}
        placeholder={t('people.functionPlaceholder')}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <div role="group" aria-label={t('people.functionsLabel')} className="flex flex-wrap gap-1.5">
        {COMMON_FUNCTIONS.map((key) => {
          const label = t(`people.functions.${key}`)
          return (
            <Chip key={key} asChild size="sm" variant={value === label ? 'default' : 'outline'} interactive>
              <button type="button" aria-pressed={value === label} onClick={() => onChange(label)}>
                {label}
              </button>
            </Chip>
          )
        })}
      </div>
    </Field>
  )
}

export function PersonForm({
  initial,
  fixedName,
  busy,
  submitLabel,
  busyLabel,
  onSubmit,
  onCancel,
}: {
  initial: PersonDraft
  /** A member's name: shown, not edited. */
  fixedName: string | null
  busy: boolean
  submitLabel: string
  busyLabel: string
  onSubmit: (draft: PersonDraft) => void
  onCancel: () => void
}): JSX.Element {
  const t = useTranslations('intakeProjectStep')
  const id = useId()
  const [draft, setDraft] = useState(initial)
  const set = (key: keyof PersonDraft) => (value: string) => setDraft((current) => ({ ...current, [key]: value }))
  const named = draft.name.trim().length > 0

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (!named || busy) return
    onSubmit(draft)
  }

  return (
    <form className="grid grid-cols-1 gap-3 py-1 sm:grid-cols-2" onSubmit={submit} aria-label={fixedName ?? t('people.addExternal')}>
      {fixedName ? (
        <p className="text-sm font-medium sm:col-span-2">{fixedName}</p>
      ) : (
        <Field className="sm:col-span-2">
          <FieldLabel htmlFor={`${id}-name`}>{t('people.name')}</FieldLabel>
          <Input id={`${id}-name`} required maxLength={200} autoFocus value={draft.name} onChange={(event) => set('name')(event.target.value)} />
        </Field>
      )}
      <div className="sm:col-span-2">
        <FunctionField value={draft.function} onChange={set('function')} autoFocus={Boolean(fixedName)} />
      </div>
      <Field className="sm:col-span-2">
        <FieldLabel htmlFor={`${id}-company`}>{t('people.company')}</FieldLabel>
        <Input id={`${id}-company`} maxLength={200} value={draft.company} onChange={(event) => set('company')(event.target.value)} />
      </Field>
      <div className="flex gap-2 sm:col-span-2">
        <BusyButton type="submit" size="sm" busy={busy} busyLabel={busyLabel} disabled={!named}>
          {submitLabel}
        </BusyButton>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t('people.cancel')}
        </Button>
      </div>
    </form>
  )
}
