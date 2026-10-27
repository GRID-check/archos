'use client'

/**
 * The Steckbrief's editing parts (ADR-0091), shared by the overview's dialog
 * and the close dialog's „Wer war dabei": the period, and the people.
 *
 * Members are listed by the server without anyone typing them in, so a row is
 * added here only for someone without a Piloti account, and a member's row
 * only adds their Funktion, Firma and months. The server decides what may
 * change (`canEdit`, `canErase`); these parts never offer what it refuses.
 * Every write is one request and then `onChanged`, which reloads the view.
 */

import { useState, type FormEvent, type JSX } from 'react'
import { Pencil, Trash2, UserPlus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Item, ItemActions, ItemContent, ItemDescription, ItemList, ItemTitle } from '@/components/ui/item'
import { MonthInput } from '@/components/ui/month-input'
import { useLocale, useTranslations } from '@/i18n'
import { commonCopy } from '@/i18n/namespaces/common'
import { projectsCopy } from '@/i18n/namespaces/projects'
import { isMonth, isOrderedPeriod, type Month } from '@/lib/projects/month'
import type { ProjectPersonView, ProjectRecordView } from '@/lib/projects/project-record-types'

/** Formats the Steckbrief's months and periods in the reader's language. */
export function useProjectRecordFormat(): {
  month: (month: Month) => string
  /** A person's months: „März 2026 – Juni 2027", „seit März 2026", „bis Juni 2027", or empty. */
  span: (from: Month | null, to: Month | null) => string
} {
  const t = useTranslations(projectsCopy)
  const { locale } = useLocale()
  const month = (value: Month): string =>
    new Intl.DateTimeFormat(locale, { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${value}-01T00:00:00Z`))
  const span = (from: Month | null, to: Month | null): string => {
    if (from && to) return t('projectRecord.range', { start: month(from), end: month(to) })
    if (from) return t('projectRecord.since', { start: month(from) })
    if (to) return t('projectRecord.until', { end: month(to) })
    return ''
  }
  return { month, span }
}

/** The project's period as one line: „seit März 2026", „März 2026 – Sept. 2027", or „Beginn offen". */
export function useProjectPeriodText(projectRecord: Pick<ProjectRecordView, 'startedOn' | 'endedOn'>): string {
  const t = useTranslations(projectsCopy)
  const { span } = useProjectRecordFormat()
  if (!projectRecord.startedOn) return t('projectRecord.periodOpen')
  return span(projectRecord.startedOn, projectRecord.endedOn)
}

async function send(url: string, method: string, body?: unknown): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
    return res.ok
  } catch {
    return false
  }
}

const monthOrNull = (value: string): Month | null => (isMonth(value) ? value : null)

/** The Beginn, saved when it is chosen, and the Abschluss closing sets. */
export function ProjectRecordPeriod({
  projectId,
  projectRecord,
  onChanged,
}: {
  projectId: string
  projectRecord: ProjectRecordView
  onChanged: () => void
}): JSX.Element {
  const t = useTranslations(projectsCopy)
  const { locale } = useLocale()
  const { month } = useProjectRecordFormat()
  const [pending, setPending] = useState(false)

  const save = async (value: string): Promise<void> => {
    setPending(true)
    const ok = await send(`/api/projects/${projectId}/project-record`, 'PUT', { startedOn: monthOrNull(value) })
    setPending(false)
    if (!ok) return void toast.error(t('projectRecord.error'))
    toast.success(t('projectRecord.periodSaved'))
    onChanged()
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <Field>
        <FieldLabel htmlFor="project-record-started">{t('projectRecord.startedOn')}</FieldLabel>
        {projectRecord.canEdit ? (
          <MonthInput
            id="project-record-started"
            value={projectRecord.startedOn ?? ''}
            onChange={(value) => void save(value)}
            locale={locale}
            monthLabel={t('projectRecord.month')}
            yearLabel={t('projectRecord.year')}
            placeholder={{ month: t('projectRecord.month'), year: t('projectRecord.year') }}
            disabled={pending}
          />
        ) : (
          <p className="text-sm" id="project-record-started">
            {projectRecord.startedOn ? month(projectRecord.startedOn) : t('projectRecord.periodOpen')}
          </p>
        )}
        {projectRecord.canEdit && projectRecord.startedOnIsDefault && (
          <FieldDescription>{t('projectRecord.startedOnDefault')}</FieldDescription>
        )}
      </Field>
      <Field>
        <FieldLabel>{t('projectRecord.endedOn')}</FieldLabel>
        <p className="text-sm" data-testid="project-record-end">
          {projectRecord.endedOn ? month(projectRecord.endedOn) : t('projectRecord.endedOnRunning')}
        </p>
      </Field>
    </div>
  )
}

interface PersonDraft {
  name: string
  function: string
  company: string
  startedOn: string
  endedOn: string
}

/** Which row a draft writes: a new one, a member's first, or an existing one. */
type Editing = { kind: 'new' } | { kind: 'person'; person: ProjectPersonView }

const draftOf = (person?: ProjectPersonView): PersonDraft => ({
  name: person?.name ?? '',
  function: person?.function ?? '',
  company: person?.company ?? '',
  startedOn: person?.startedOn ?? '',
  endedOn: person?.endedOn ?? '',
})

const editKey = (editing: Editing | null): string | null =>
  !editing ? null : editing.kind === 'new' ? 'new' : (editing.person.id ?? editing.person.userId)

/** The people: listed, described, added, and erased. */
export function ProjectRecordPeople({
  projectId,
  projectRecord,
  onChanged,
  hint = true,
}: {
  projectId: string
  projectRecord: ProjectRecordView
  onChanged: () => void
  /** Says who is listed on their own; off where the surface already says it. */
  hint?: boolean
}): JSX.Element {
  const t = useTranslations(projectsCopy)
  const tCommon = useTranslations(commonCopy)
  const { span } = useProjectRecordFormat()
  const [editing, setEditing] = useState<Editing | null>(null)
  const [removing, setRemoving] = useState<ProjectPersonView | null>(null)
  const [pending, setPending] = useState(false)

  const save = async (draft: PersonDraft): Promise<void> => {
    if (!editing) return
    const person = editing.kind === 'person' ? editing.person : null
    const body = {
      name: draft.name,
      function: draft.function,
      company: draft.company,
      startedOn: monthOrNull(draft.startedOn),
      endedOn: monthOrNull(draft.endedOn),
      userId: person?.userId ?? null,
    }
    setPending(true)
    const ok = person?.id
      ? await send(`/api/projects/${projectId}/people/${person.id}`, 'PATCH', body)
      : await send(`/api/projects/${projectId}/people`, 'POST', body)
    setPending(false)
    if (!ok) return void toast.error(t('projectRecord.error'))
    toast.success(t('projectRecord.saved'))
    setEditing(null)
    onChanged()
  }

  const remove = async (): Promise<void> => {
    if (!removing?.id) return
    setPending(true)
    const ok = await send(`/api/projects/${projectId}/people/${removing.id}`, 'DELETE')
    setPending(false)
    if (!ok) return void toast.error(t('projectRecord.error'))
    toast.success(t('projectRecord.removed'))
    setRemoving(null)
    onChanged()
  }

  const form = (person?: ProjectPersonView) => (
    <PersonForm
      initial={draftOf(person)}
      fixedName={person?.userId ? person.name : null}
      pending={pending}
      onSubmit={save}
      onCancel={() => setEditing(null)}
    />
  )
  const open = editKey(editing)

  return (
    <div className="space-y-3">
      {hint && projectRecord.canEdit && <p className="text-muted-foreground text-xs leading-relaxed">{t('projectRecord.peopleHint')}</p>}
      {!projectRecord.rosterKnown && <p className="text-muted-foreground text-xs">{t('projectRecord.rosterUnknown')}</p>}

      {projectRecord.people.length === 0 && editing?.kind !== 'new' ? (
        <p className="text-muted-foreground text-sm">{t('projectRecord.noPeople')}</p>
      ) : (
        <ItemList as="ul" aria-label={t('projectRecord.people')}>
          {projectRecord.people.map((person) => {
            const key = person.id ?? person.userId ?? person.name
            if (open === key) {
              return (
                <Item as="li" key={key} className="block hover:bg-transparent">
                  {form(person)}
                </Item>
              )
            }
            const details = [person.function ?? (person.kind === 'member' ? t('projectRecord.functionMissing') : null), person.company, span(person.startedOn, person.endedOn)]
              .filter(Boolean)
              .join(' · ')
            return (
              <Item as="li" key={key} className="py-2.5" data-testid="project-record-person">
                <ItemContent>
                  <div className="flex min-w-0 items-center gap-2">
                    <ItemTitle>{person.name}</ItemTitle>
                    {person.kind !== 'added' && (
                      <Chip size="sm" variant={person.kind === 'member' ? 'muted' : 'outline'}>
                        {t(`projectRecord.${person.kind}`)}
                      </Chip>
                    )}
                  </div>
                  {details && <ItemDescription>{details}</ItemDescription>}
                </ItemContent>
                <ItemActions className="gap-0.5">
                  {projectRecord.canEdit && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8"
                      aria-label={t('projectRecord.editPerson', { name: person.name })}
                      disabled={pending}
                      onClick={() => setEditing({ kind: 'person', person })}
                    >
                      <Pencil className="size-3.5" aria-hidden />
                    </Button>
                  )}
                  {projectRecord.canErase && person.id && person.kind !== 'member' && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="hover:text-destructive size-8"
                      aria-label={t('projectRecord.remove', { name: person.name })}
                      disabled={pending}
                      onClick={() => setRemoving(person)}
                    >
                      <Trash2 className="size-3.5" aria-hidden />
                    </Button>
                  )}
                </ItemActions>
              </Item>
            )
          })}
          {open === 'new' && (
            <Item as="li" className="block hover:bg-transparent">
              {form()}
            </Item>
          )}
        </ItemList>
      )}

      {projectRecord.canEdit && !editing && (
        <Button variant="outline" size="sm" onClick={() => setEditing({ kind: 'new' })}>
          <UserPlus className="size-4" aria-hidden />
          {t('projectRecord.add')}
        </Button>
      )}

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(next) => !next && setRemoving(null)}
        title={t('projectRecord.removeTitle')}
        description={removing ? t('projectRecord.removeDescription', { name: removing.name }) : undefined}
        confirmLabel={t('projectRecord.removeConfirm')}
        cancelLabel={tCommon('actions.cancel')}
        onConfirm={remove}
        pending={pending}
      />
    </div>
  )
}

function PersonForm({
  initial,
  fixedName,
  pending,
  onSubmit,
  onCancel,
}: {
  initial: PersonDraft
  /** A member's name comes from their account and is not edited here. */
  fixedName: string | null
  pending: boolean
  onSubmit: (draft: PersonDraft) => Promise<void>
  onCancel: () => void
}): JSX.Element {
  const t = useTranslations(projectsCopy)
  const { locale } = useLocale()
  const [draft, setDraft] = useState(initial)
  const backwards = !isOrderedPeriod(monthOrNull(draft.startedOn), monthOrNull(draft.endedOn))
  const set = (key: keyof PersonDraft) => (value: string) => setDraft((current) => ({ ...current, [key]: value }))
  const monthProps = {
    locale,
    monthLabel: t('projectRecord.month'),
    yearLabel: t('projectRecord.year'),
    placeholder: { month: t('projectRecord.month'), year: t('projectRecord.year') },
    clearLabel: t('projectRecord.clear'),
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (draft.name.trim().length === 0 || backwards) return
    void onSubmit(draft)
  }

  return (
    <form className="grid grid-cols-1 gap-3 py-1 sm:grid-cols-2" onSubmit={submit} aria-label={fixedName ?? t('projectRecord.add')}>
      {fixedName ? (
        <p className="text-sm font-medium sm:col-span-2">{fixedName}</p>
      ) : (
        <Field className="sm:col-span-2">
          <FieldLabel htmlFor="person-name">{t('projectRecord.name')}</FieldLabel>
          <Input id="person-name" required maxLength={200} autoFocus value={draft.name} onChange={(event) => set('name')(event.target.value)} />
        </Field>
      )}
      <Field>
        <FieldLabel htmlFor="person-function">{t('projectRecord.function')}</FieldLabel>
        <Input
          id="person-function"
          maxLength={200}
          placeholder={t('projectRecord.functionPlaceholder')}
          autoFocus={Boolean(fixedName)}
          value={draft.function}
          onChange={(event) => set('function')(event.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="person-company">{t('projectRecord.company')}</FieldLabel>
        <Input id="person-company" maxLength={200} value={draft.company} onChange={(event) => set('company')(event.target.value)} />
      </Field>
      <Field>
        <FieldLabel htmlFor="person-from">{t('projectRecord.from')}</FieldLabel>
        <MonthInput id="person-from" value={draft.startedOn} onChange={set('startedOn')} {...monthProps} />
      </Field>
      <Field data-invalid={backwards || undefined}>
        <FieldLabel htmlFor="person-to">{t('projectRecord.to')}</FieldLabel>
        <MonthInput id="person-to" value={draft.endedOn} onChange={set('endedOn')} {...monthProps} />
        {backwards && <FieldError>{t('projectRecord.periodBackwards')}</FieldError>}
      </Field>
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" size="sm" disabled={pending || backwards || draft.name.trim().length === 0}>
          {t('projectRecord.save')}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t('projectRecord.cancel')}
        </Button>
      </div>
    </form>
  )
}
