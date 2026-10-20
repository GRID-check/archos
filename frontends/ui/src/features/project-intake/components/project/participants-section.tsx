'use client'

/**
 * Step 1's Beteiligte: everyone on the project in one card, and the two ways to
 * add someone. Colleagues from the office get a role in Piloti (the members
 * route, WorkOS); everyone else, the Statiker, the Bauherrschaft, a Fachplaner
 * without an account, is a Steckbrief row with a Funktion (ADR-0091). Both
 * records exist already; this card only shows them side by side.
 *
 * The card is a list and nothing else (the approved mockup `Projekt.dc.html`):
 * a row is a disc, the name and one line of what the person does. Everything a
 * row can be asked to do is folded behind its one quiet control: „Rolle" for a
 * colleague whose role the reader may change, a „…" for anyone else the reader
 * may describe or remove. Adding or describing someone opens a sheet; former
 * members fold under the list.
 *
 * What the reader may do is the server's answer, never guessed here: the
 * Steckbrief says whether people may be added or erased (`canEdit`,
 * `canErase`), and the roster answers only whoever may manage the members, so
 * without it there is no role to change and no colleague to add. Nobody
 * changes their own access in the setup.
 */

import { useState, type JSX } from 'react'
import { ChevronDown, Ellipsis, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { ActionMenu, type ActionMenuEntry } from '@/components/ui/action-menu'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { useTranslations } from '@/i18n'
import {
  PROJECT_MEMBER_ROLES,
  ParticipantsRequestError,
  type ParticipantsClient,
  type ProjectMemberRoleSlug,
  type ProjectRoster,
} from '@/lib/projects/participants-client'
import type { ProjectPersonInput, ProjectPersonView, SteckbriefView } from '@/lib/projects/steckbrief-types'
import { cn } from '@/lib/utils'
import { ColleagueForm, type ColleagueChoice } from './colleague-form'
import { colleagueCandidates, participantRows, type ParticipantRow } from './participants'
import { PersonForm, type PersonDraft } from './person-form'
import { PersonDisc, StepCard, StepCardRow } from './step-card'

/** What the sheet holds: a colleague to add, someone from outside to add, or a row to describe. */
type SheetTask = { kind: 'colleague' } | { kind: 'external' } | { kind: 'describe'; row: ParticipantRow } | null

export interface ParticipantsSectionProps {
  projectId: string
  client: ParticipantsClient
  peopleRecord: SteckbriefView | null
  roster: ProjectRoster | null
  loading: boolean
  reload: () => Promise<void>
}

const personInput = (person: Pick<ProjectPersonView, 'startedOn' | 'endedOn' | 'userId'> | null, draft: PersonDraft): ProjectPersonInput => ({
  name: draft.name.trim(),
  function: draft.function,
  company: draft.company,
  startedOn: person?.startedOn ?? null,
  endedOn: person?.endedOn ?? null,
  userId: person?.userId ?? null,
})

/** The quiet bordered button at the card's foot, 34px on a desk and 44px under a finger. */
const ADD_CLASS = 'h-[34px] gap-1.5 px-3 text-[13px] font-normal pointer-coarse:h-11'

export function ParticipantsSection({ projectId, client, peopleRecord, roster, loading, reload }: ParticipantsSectionProps): JSX.Element {
  const t = useTranslations('intakeProjectStep')
  const tMembers = useTranslations('members')
  const tCommon = useTranslations('common')
  const [task, setTask] = useState<SheetTask>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [removing, setRemoving] = useState<ProjectPersonView | null>(null)
  const [revoking, setRevoking] = useState<ParticipantRow | null>(null)

  const roleLabel = (role: ProjectMemberRoleSlug): string => tMembers(`roles.${role}`)

  /**
   * One write, then a fresh read, also after a failure: adding a colleague is
   * two writes, and the first may have gone through. Says what went wrong, the
   * last admin by name.
   */
  const run = async (key: string, work: () => Promise<void>, done: string): Promise<boolean> => {
    setPending(key)
    let ok = false
    try {
      await work()
      ok = true
      toast.success(done)
    } catch (error) {
      toast.error(error instanceof ParticipantsRequestError && error.reason === 'last-admin' ? t('people.lastAdmin') : t('people.error'))
    }
    await reload()
    setPending(null)
    return ok
  }

  if (!peopleRecord) {
    return (
      <StepCard title={t('people.label')} data-testid="project-step-people">
        {loading ? (
          <div role="status" aria-label={t('people.loading')}>
            {[0, 1, 2].map((index) => (
              <StepCardRow key={index}>
                <Skeleton className="size-8 rounded-full" />
                <Skeleton className="h-8 flex-1" />
              </StepCardRow>
            ))}
          </div>
        ) : (
          <StepCardRow className="flex-wrap justify-between">
            <p className="text-sm">{t('people.loadFailed')}</p>
            <Button type="button" size="sm" variant="outline" className={ADD_CLASS} onClick={() => void reload()}>
              {t('people.retry')}
            </Button>
          </StepCardRow>
        )}
      </StepCard>
    )
  }

  const rows = participantRows(peopleRecord.people, roster)
  const current = rows.filter((row) => row.person.kind !== 'former')
  const former = rows.filter((row) => row.person.kind === 'former')
  const candidates = colleagueCandidates(roster)
  const canAddColleague = roster !== null && peopleRecord.canEdit
  const busy = pending !== null
  const close = (): void => setTask(null)

  const addColleague = (choice: ColleagueChoice): void => {
    void run(
      'colleague',
      async () => {
        await client.setRole(projectId, choice.member.organizationMembershipId, choice.role)
        if (choice.function.trim()) {
          await client.savePerson(
            projectId,
            personInput({ startedOn: null, endedOn: null, userId: choice.member.userId }, { name: choice.member.name, function: choice.function, company: '' }),
            null
          )
        }
      },
      t('people.addedColleague', { name: choice.member.name })
    ).then((ok) => ok && close())
  }

  const addExternal = (draft: PersonDraft): void => {
    void run('external', () => client.savePerson(projectId, personInput(null, draft), null), t('people.addedExternal', { name: draft.name.trim() })).then(
      (ok) => ok && close()
    )
  }

  const describe = (row: ParticipantRow, draft: PersonDraft): void => {
    const person = row.person
    void run(row.key, () => client.savePerson(projectId, personInput(person, { ...draft, name: person.userId ? person.name : draft.name }), person.id), t('people.saved')).then(
      (ok) => ok && close()
    )
  }

  const changeRole = (row: ParticipantRow, next: ProjectMemberRoleSlug): void => {
    if (!row.membership || next === row.role) return
    const membershipId = row.membership.organizationMembershipId
    void run(row.key, () => client.setRole(projectId, membershipId, next), t('people.roleChanged', { name: row.person.name, role: roleLabel(next) }))
  }

  const revoke = async (): Promise<void> => {
    const row = revoking
    if (!row?.membership) return
    const membershipId = row.membership.organizationMembershipId
    await run(row.key, () => client.setRole(projectId, membershipId, ''), t('people.revoked', { name: row.person.name }))
    setRevoking(null)
  }

  const remove = async (): Promise<void> => {
    const person = removing
    if (!person?.id) return
    const personId = person.id
    await run(personId, () => client.removePerson(projectId, personId), t('people.removed'))
    setRemoving(null)
  }

  const item = (row: ParticipantRow): JSX.Element => (
    <ParticipantItem
      key={row.key}
      row={row}
      canEdit={peopleRecord.canEdit}
      canErase={peopleRecord.canErase}
      busy={busy}
      roleLabel={roleLabel}
      onDescribe={() => setTask({ kind: 'describe', row })}
      onRole={(next) => changeRole(row, next)}
      onRevoke={() => setRevoking(row)}
      onRemove={() => setRemoving(row.person)}
    />
  )

  const note = !peopleRecord.canEdit ? t('people.readOnly') : roster === null ? t('people.membersByAdmins') : null

  return (
    <StepCard
      title={t('people.label')}
      data-testid="project-step-people"
      aside={
        <span className="text-muted-foreground text-xs tabular-nums" data-testid="project-step-people-count">
          {current.length}
        </span>
      }
    >
      {current.length === 0 ? (
        <StepCardRow>
          <p className="text-muted-foreground text-sm">{t('people.empty')}</p>
        </StepCardRow>
      ) : (
        <ul aria-label={t('people.label')}>{current.map(item)}</ul>
      )}

      {former.length > 0 && (
        <Collapsible>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="border-border/60 text-muted-foreground hover:text-foreground group flex min-h-11 w-full items-center gap-1.5 border-t px-4 text-left text-[13px] sm:px-[18px]"
            >
              {t('people.formerToggle', { count: former.length })}
              <ChevronDown className="size-3.5 transition-transform group-data-[state=open]:rotate-180" aria-hidden />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul aria-label={t('people.formerLabel')}>{former.map(item)}</ul>
          </CollapsibleContent>
        </Collapsible>
      )}

      {(peopleRecord.canEdit || note) && (
        <div className="border-border/60 flex flex-wrap items-center gap-2 border-t px-4 py-3.5 sm:px-[18px]">
          {canAddColleague && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={ADD_CLASS}
              onClick={() => setTask({ kind: 'colleague' })}
              disabled={candidates.length === 0}
              title={candidates.length === 0 ? t('people.colleaguesNone') : undefined}
            >
              <Plus aria-hidden />
              {t('people.addColleague')}
            </Button>
          )}
          {peopleRecord.canEdit && (
            <Button type="button" variant="outline" size="sm" className={ADD_CLASS} onClick={() => setTask({ kind: 'external' })}>
              <Plus aria-hidden />
              {t('people.addExternal')}
            </Button>
          )}
          {note && <p className="text-muted-foreground w-full text-xs leading-relaxed">{note}</p>}
        </div>
      )}

      <Sheet open={task !== null} onOpenChange={(open) => !open && close()}>
        <SheetContent closeLabel={t('people.cancel')} data-testid="project-step-person-sheet">
          {task?.kind === 'colleague' && (
            <>
              <SheetHeader>
                <SheetTitle>{t('people.addColleagueTitle')}</SheetTitle>
                <SheetDescription>{t('people.addColleagueDescription')}</SheetDescription>
              </SheetHeader>
              <ColleagueForm candidates={candidates} busy={pending === 'colleague'} onSubmit={addColleague} onCancel={close} />
            </>
          )}
          {task?.kind === 'external' && (
            <>
              <SheetHeader>
                <SheetTitle>{t('people.addExternalTitle')}</SheetTitle>
                <SheetDescription>{t('people.privacy')}</SheetDescription>
              </SheetHeader>
              <PersonForm
                initial={{ name: '', function: '', company: '' }}
                fixedName={null}
                busy={pending === 'external'}
                submitLabel={t('people.add')}
                busyLabel={t('people.adding')}
                onSubmit={addExternal}
                onCancel={close}
              />
            </>
          )}
          {task?.kind === 'describe' && (
            <>
              <SheetHeader>
                <SheetTitle>{task.row.person.name}</SheetTitle>
                <SheetDescription>{task.row.person.userId ? t('people.describeMember') : t('people.privacy')}</SheetDescription>
              </SheetHeader>
              <PersonForm
                initial={{ name: task.row.person.name, function: task.row.person.function ?? '', company: task.row.person.company ?? '' }}
                fixedName={task.row.person.userId ? task.row.person.name : null}
                busy={pending === task.row.key}
                submitLabel={t('people.save')}
                busyLabel={t('people.saving')}
                onSubmit={(draft) => describe(task.row, draft)}
                onCancel={close}
              />
            </>
          )}
        </SheetContent>
      </Sheet>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(next) => !next && setRemoving(null)}
        title={t('people.removeTitle')}
        description={removing ? t('people.removeDescription', { name: removing.name }) : undefined}
        confirmLabel={t('people.removeConfirm')}
        cancelLabel={tCommon('actions.cancel')}
        onConfirm={remove}
        pending={busy}
      />
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(next) => !next && setRevoking(null)}
        title={revoking ? t('people.revokeTitle', { name: revoking.person.name }) : ''}
        description={revoking ? t('people.revokeDescription', { name: revoking.person.name }) : undefined}
        confirmLabel={t('people.revokeConfirm')}
        cancelLabel={tCommon('actions.cancel')}
        tone="warning"
        onConfirm={revoke}
        pending={busy}
      />
    </StepCard>
  )
}

function ParticipantItem({
  row,
  canEdit,
  canErase,
  busy,
  roleLabel,
  onDescribe,
  onRole,
  onRevoke,
  onRemove,
}: {
  row: ParticipantRow
  canEdit: boolean
  canErase: boolean
  /** A write is in flight: the controls stay where they are and wait. */
  busy: boolean
  roleLabel: (role: ProjectMemberRoleSlug) => string
  onDescribe: () => void
  onRole: (next: ProjectMemberRoleSlug) => void
  onRevoke: () => void
  onRemove: () => void
}): JSX.Element {
  const t = useTranslations('intakeProjectStep')
  const { person } = row
  const external = person.kind === 'added'
  const tone = row.you ? 'you' : external ? 'external' : person.kind === 'former' ? 'former' : 'member'
  const work = [person.function, person.company].filter(Boolean).join(' · ')
  const fallback = person.kind === 'member' && !row.role ? t('people.member') : person.kind === 'former' ? t('people.former') : null

  const entries: ActionMenuEntry[] = []
  if (row.membership && row.role) {
    entries.push({
      type: 'radio-group',
      value: row.role,
      onValueChange: (value) => onRole(value as ProjectMemberRoleSlug),
      items: PROJECT_MEMBER_ROLES.map((slug) => ({ value: slug, label: roleLabel(slug) })),
    })
  }
  if (canEdit && person.kind !== 'former') {
    if (entries.length > 0) entries.push({ type: 'separator' })
    entries.push({ type: 'item', id: 'describe', label: person.userId ? t('people.describe') : t('people.editExternal'), onSelect: onDescribe, disabled: busy })
  }
  if (row.membership) entries.push({ type: 'item', id: 'revoke', label: t('people.revokeOption'), variant: 'destructive', onSelect: onRevoke, disabled: busy })
  if (canErase && person.id && external) {
    entries.push({ type: 'item', id: 'remove', label: t('people.removeOption'), variant: 'destructive', onSelect: onRemove, disabled: busy })
  }

  const trigger =
    row.membership && row.role ? (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="text-muted-foreground touch-target h-[30px] px-2.5 text-[13px] font-normal"
        aria-label={t('people.roleFor', { name: person.name })}
        disabled={busy}
      >
        {t('people.roleButton')}
      </Button>
    ) : (
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="text-muted-foreground touch-target size-[30px]"
        aria-label={t('people.edit', { name: person.name })}
        disabled={busy}
      >
        <Ellipsis className="size-4" aria-hidden />
      </Button>
    )

  return (
    <li data-testid="project-step-person" data-kind={person.kind}>
      <StepCardRow className={cn(person.kind === 'former' && 'opacity-80')}>
        <PersonDisc name={person.name} tone={tone} />
        <div className="min-w-0 flex-1">
          <p className="flex min-w-0 items-center gap-1.5 text-sm leading-[18px]">
            <span className="truncate">{person.name}</span>
            {row.you && (
              <Chip size="sm" variant="muted">
                {t('people.you')}
              </Chip>
            )}
            {external && (
              <Chip size="sm" variant="muted">
                {t('people.external')}
              </Chip>
            )}
          </p>
          <p className="text-muted-foreground mt-0.5 truncate text-xs leading-4">
            {[work, fallback].filter(Boolean).join(' · ')}
            {row.role && (
              <>
                {work || fallback ? ' · ' : ''}
                <span data-testid="project-step-role">{roleLabel(row.role)}</span>
              </>
            )}
          </p>
        </div>
        {entries.length > 0 && <ActionMenu mode="dropdown" entries={entries} trigger={trigger} contentClassName="w-60" />}
      </StepCardRow>
    </li>
  )
}
