'use client'

/**
 * Step 1's Beteiligte: everyone on the project in one list, and the two ways to
 * add someone. Colleagues from the office get a role in Piloti (the members
 * route, WorkOS); everyone else, the Statiker, the Bauherrschaft, a Fachplaner
 * without an account, is a Steckbrief row with a Funktion (ADR-0091). Both
 * records exist already; this list only shows them side by side.
 *
 * What the reader may do is the server's answer, never guessed here: the
 * Steckbrief says whether people may be added or erased (`canEdit`,
 * `canErase`), and the roster answers only whoever may manage the members, so
 * without it there is no role to change and no colleague to add. Nobody
 * changes their own access in the setup.
 */

import { useState, type JSX } from 'react'
import { Pencil, Trash2, UserPlus, UserRoundPlus } from 'lucide-react'
import { toast } from 'sonner'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Item, ItemActions, ItemContent, ItemDescription, ItemList, ItemTitle } from '@/components/ui/item'
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select'
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
import { IntakeSection } from '../intake-atoms'
import { ColleagueForm, type ColleagueChoice } from './colleague-form'
import { colleagueCandidates, participantRows, type ParticipantRow } from './participants'
import { PersonForm, type PersonDraft } from './person-form'

/** The Select's value for „Aus dem Projekt nehmen": Radix takes no empty string. */
const REVOKE = 'revoke'

type Adding = 'colleague' | 'external' | null

export interface ParticipantsSectionProps {
  projectId: string
  client: ParticipantsClient
  steckbrief: SteckbriefView | null
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

export function ParticipantsSection({ projectId, client, steckbrief, roster, loading, reload }: ParticipantsSectionProps): JSX.Element {
  const t = useTranslations('intakeProjectStep')
  const tMembers = useTranslations('members')
  const tCommon = useTranslations('common')
  const [adding, setAdding] = useState<Adding>(null)
  const [editing, setEditing] = useState<string | null>(null)
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

  if (loading && !steckbrief) {
    return (
      <IntakeSection label={t('people.label')} description={t('people.description')} testId="project-step-people">
        <div role="status" aria-label={t('people.loading')} className="space-y-2">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      </IntakeSection>
    )
  }

  if (!steckbrief) {
    return (
      <IntakeSection label={t('people.label')} description={t('people.description')} testId="project-step-people">
        <Alert variant="destructive">
          <AlertDescription className="text-current">
            <p>{t('people.loadFailed')}</p>
            <Button type="button" size="sm" variant="outline" onClick={() => void reload()}>
              {t('people.retry')}
            </Button>
          </AlertDescription>
        </Alert>
      </IntakeSection>
    )
  }

  const rows = participantRows(steckbrief.people, roster)
  const candidates = colleagueCandidates(roster)
  const canAddColleague = roster !== null && steckbrief.canEdit
  const busy = pending !== null

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
    ).then((ok) => ok && setAdding(null))
  }

  const addExternal = (draft: PersonDraft): void => {
    void run('external', () => client.savePerson(projectId, personInput(null, draft), null), t('people.addedExternal', { name: draft.name.trim() })).then(
      (ok) => ok && setAdding(null)
    )
  }

  const describe = (row: ParticipantRow, draft: PersonDraft): void => {
    const person = row.person
    void run(row.key, () => client.savePerson(projectId, personInput(person, { ...draft, name: person.userId ? person.name : draft.name }), person.id), t('people.saved')).then(
      (ok) => ok && setEditing(null)
    )
  }

  const changeRole = (row: ParticipantRow, next: string): void => {
    if (!row.membership) return
    if (next === REVOKE) return setRevoking(row)
    const role = next as ProjectMemberRoleSlug
    const membershipId = row.membership.organizationMembershipId
    void run(row.key, () => client.setRole(projectId, membershipId, role), t('people.roleChanged', { name: row.person.name, role: roleLabel(role) }))
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

  return (
    <IntakeSection label={t('people.label')} count={rows.length} description={t('people.description')} testId="project-step-people">
      {rows.length === 0 && adding === null ? (
        <p className="text-muted-foreground text-sm">{t('people.empty')}</p>
      ) : (
        <ItemList as="ul" aria-label={t('people.label')}>
          {rows.map((row) =>
            editing === row.key ? (
              <Item as="li" key={row.key} className="block hover:bg-transparent">
                <PersonForm
                  initial={{ name: row.person.name, function: row.person.function ?? '', company: row.person.company ?? '' }}
                  fixedName={row.person.userId ? row.person.name : null}
                  busy={pending === row.key}
                  submitLabel={t('people.save')}
                  busyLabel={t('people.saving')}
                  onSubmit={(draft) => describe(row, draft)}
                  onCancel={() => setEditing(null)}
                />
              </Item>
            ) : (
              <ParticipantItem
                key={row.key}
                row={row}
                canEdit={steckbrief.canEdit}
                canErase={steckbrief.canErase}
                busy={busy}
                roleLabel={roleLabel}
                onEdit={() => {
                  setAdding(null)
                  setEditing(row.key)
                }}
                onRole={(next) => changeRole(row, next)}
                onRemove={() => setRemoving(row.person)}
              />
            )
          )}
          {adding === 'colleague' && (
            <Item as="li" className="block hover:bg-transparent">
              <ColleagueForm candidates={candidates} busy={pending === 'colleague'} onSubmit={addColleague} onCancel={() => setAdding(null)} />
            </Item>
          )}
          {adding === 'external' && (
            <Item as="li" className="block hover:bg-transparent">
              <PersonForm
                initial={{ name: '', function: '', company: '' }}
                fixedName={null}
                busy={pending === 'external'}
                submitLabel={t('people.add')}
                busyLabel={t('people.adding')}
                onSubmit={addExternal}
                onCancel={() => setAdding(null)}
              />
            </Item>
          )}
        </ItemList>
      )}

      {steckbrief.canEdit && adding === null && (
        <div className="flex flex-wrap items-center gap-2">
          {canAddColleague && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setEditing(null)
                setAdding('colleague')
              }}
              disabled={candidates.length === 0}
              title={candidates.length === 0 ? t('people.colleaguesNone') : undefined}
            >
              <UserPlus aria-hidden />
              {t('people.addColleague')}
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setEditing(null)
              setAdding('external')
            }}
          >
            <UserRoundPlus aria-hidden />
            {t('people.addExternal')}
          </Button>
        </div>
      )}
      <p className="text-muted-foreground text-xs leading-relaxed">
        {[!steckbrief.canEdit ? t('people.readOnly') : roster === null ? t('people.membersByAdmins') : null, t('people.privacy')]
          .filter(Boolean)
          .join(' ')}
      </p>

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
    </IntakeSection>
  )
}

function ParticipantItem({
  row,
  canEdit,
  canErase,
  busy,
  roleLabel,
  onEdit,
  onRole,
  onRemove,
}: {
  row: ParticipantRow
  canEdit: boolean
  canErase: boolean
  /** A write is in flight: the controls stay where they are and wait. */
  busy: boolean
  roleLabel: (role: ProjectMemberRoleSlug) => string
  onEdit: () => void
  onRole: (next: string) => void
  onRemove: () => void
}): JSX.Element {
  const t = useTranslations('intakeProjectStep')
  const { person } = row
  const details = [person.function ?? (person.kind === 'member' ? t('people.functionMissing') : null), person.company].filter(Boolean).join(' · ')

  return (
    <Item as="li" className="py-2.5" data-testid="project-step-person" data-kind={person.kind}>
      <ItemContent>
        <div className="flex min-w-0 items-center gap-2">
          <ItemTitle>{person.name}</ItemTitle>
          {row.you && (
            <Chip size="sm" variant="default">
              {t('people.you')}
            </Chip>
          )}
          <Chip size="sm" variant={person.kind === 'member' ? 'muted' : 'outline'}>
            {person.kind === 'member' ? t('people.member') : person.kind === 'added' ? t('people.external') : t('people.former')}
          </Chip>
        </div>
        {details && <ItemDescription>{details}</ItemDescription>}
      </ItemContent>
      <ItemActions className="gap-1">
        {row.membership && row.role ? (
          <Select value={row.role} onValueChange={onRole} disabled={busy}>
            <SelectTrigger size="sm" aria-label={t('people.roleFor', { name: person.name })} className="min-w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              {PROJECT_MEMBER_ROLES.map((slug) => (
                <SelectItem key={slug} value={slug}>
                  {roleLabel(slug)}
                </SelectItem>
              ))}
              <SelectSeparator />
              <SelectItem value={REVOKE}>{t('people.revokeOption')}</SelectItem>
            </SelectContent>
          </Select>
        ) : (
          row.role && (
            <Chip size="sm" variant="muted" data-testid="project-step-role">
              {roleLabel(row.role)}
            </Chip>
          )
        )}
        {canEdit && person.kind !== 'former' && (
          <Button variant="ghost" size="icon" className="size-8" aria-label={t('people.edit', { name: person.name })} disabled={busy} onClick={onEdit}>
            <Pencil className="size-3.5" aria-hidden />
          </Button>
        )}
        {canErase && person.id && person.kind !== 'member' && (
          <Button variant="ghost" size="icon" className="hover:text-destructive size-8" aria-label={t('people.remove', { name: person.name })} disabled={busy} onClick={onRemove}>
            <Trash2 className="size-3.5" aria-hidden />
          </Button>
        )}
      </ItemActions>
    </Item>
  )
}
