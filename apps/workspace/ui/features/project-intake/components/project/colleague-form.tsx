'use client'

/**
 * „Aus dem Büro hinzufügen": a colleague who holds no role on the project yet,
 * the role they get in Piloti, and what they do on the project. The role goes
 * to the members route (WorkOS, ADR-0038), so the colleague is on the
 * Steckbrief from then on without anyone typing them in (ADR-0101); the
 * Funktion, when given, is the Steckbrief row that describes them.
 *
 * The picker is `Popover` + `Command` over the roster already loaded: WorkOS
 * has no member search, and an office's roster is short.
 */

import { useId, useState, type FormEvent, type JSX } from 'react'
import { ChevronDown } from 'lucide-react'
import { BusyButton } from '@/components/ui/busy-button'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Field, FieldLabel } from '@/components/ui/field'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useTranslations } from '@/i18n'
import { intakeProjectStepCopy } from '@/i18n/namespaces/intake-project-step'
import { membersCopy } from '@/i18n/namespaces/members'
import { PROJECT_MEMBER_ROLES, type ProjectMemberRoleSlug, type RosterMember } from '@/lib/projects/participants-client'
import { DEFAULT_COLLEAGUE_ROLE } from './participants'
import { FunctionField } from './person-form'

export interface ColleagueChoice {
  member: RosterMember
  role: ProjectMemberRoleSlug
  function: string
}

export function ColleagueForm({
  candidates,
  busy,
  onSubmit,
  onCancel,
}: {
  candidates: readonly RosterMember[]
  busy: boolean
  onSubmit: (choice: ColleagueChoice) => void
  onCancel: () => void
}): JSX.Element {
  const t = useTranslations(intakeProjectStepCopy)
  const tMembers = useTranslations(membersCopy)
  const id = useId()
  const [picking, setPicking] = useState(false)
  const [member, setMember] = useState<RosterMember | null>(null)
  const [role, setRole] = useState<ProjectMemberRoleSlug>(DEFAULT_COLLEAGUE_ROLE)
  const [work, setWork] = useState('')

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (!member || busy) return
    onSubmit({ member, role, function: work })
  }

  return (
    <form className="grid grid-cols-1 gap-3 py-1 sm:grid-cols-2" onSubmit={submit} aria-label={t('people.addColleague')}>
      <Field>
        <FieldLabel htmlFor={`${id}-who`}>{t('people.colleague')}</FieldLabel>
        <Popover open={picking} onOpenChange={setPicking}>
          <PopoverTrigger asChild>
            <Button id={`${id}-who`} type="button" variant="outline" role="combobox" aria-expanded={picking} aria-controls={`${id}-list`} className="w-full justify-between font-normal">
              <span className="truncate">{member?.name ?? t('people.colleaguePick')}</span>
              <ChevronDown className="size-4 opacity-70" aria-hidden />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] min-w-64 max-w-[calc(100vw-2rem)] p-0" collisionPadding={16}>
            <Command>
              <CommandInput placeholder={t('people.colleagueSearch')} aria-label={t('people.colleagueSearch')} />
              <CommandList id={`${id}-list`} aria-label={t('people.colleague')}>
                <CommandEmpty>{t('people.colleagueNoMatch')}</CommandEmpty>
                <CommandGroup>
                  {candidates.map((candidate) => (
                    <CommandItem
                      key={candidate.organizationMembershipId}
                      value={candidate.organizationMembershipId}
                      keywords={[candidate.name, candidate.email ?? '']}
                      onSelect={() => {
                        setMember(candidate)
                        setPicking(false)
                      }}
                      className="pointer-coarse:min-h-11"
                    >
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate">{candidate.name}</span>
                        {candidate.email && <span className="text-muted-foreground truncate text-xs">{candidate.email}</span>}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-role`}>{t('people.role')}</FieldLabel>
        <Select value={role} onValueChange={(next) => setRole(next as ProjectMemberRoleSlug)}>
          <SelectTrigger id={`${id}-role`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROJECT_MEMBER_ROLES.map((slug) => (
              <SelectItem key={slug} value={slug}>
                {tMembers(`roles.${slug}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <div className="sm:col-span-2">
        <FunctionField value={work} onChange={setWork} />
      </div>
      <div className="flex flex-col-reverse gap-2 pt-1 sm:col-span-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t('people.cancel')}
        </Button>
        <BusyButton type="submit" busy={busy} busyLabel={t('people.adding')} disabled={!member}>
          {t('people.add')}
        </BusyButton>
      </div>
    </form>
  )
}
