/**
 * The Beteiligte of step 1 as one list: the Steckbrief's people (ADR-0091,
 * ADR-0101) joined with the roster's project roles. Pure, so the join is
 * specified without a page.
 *
 * The Steckbrief decides who is on the list (members from the project's own
 * role assignments, former members, everyone added by hand). The roster only
 * adds a member's role and whether the reader may change it; an organization
 * admin who reaches the project through `org:projects:administer` holds a role
 * on the roster but is not on the Steckbrief, and is not listed here either.
 */

import type { ProjectPersonView } from '@/lib/projects/steckbrief-types'
import type { ProjectMemberRoleSlug, ProjectRoster, RosterMember } from '@/lib/projects/participants-client'

export interface ParticipantRow {
  /** Stable across reloads: the stored row, else the account. */
  key: string
  person: ProjectPersonView
  /** The member's project role; null for an external or a former member, or when the roster is not readable. */
  role: ProjectMemberRoleSlug | null
  /** The roster entry whose role this row may change; null when the reader may not change it. */
  membership: RosterMember | null
  /** The reader's own row. */
  you: boolean
}

export const participantKey = (person: ProjectPersonView): string => person.id ?? person.userId ?? person.name

/** Members first, then everyone added by hand, then former members: who works on the project now leads. */
const ORDER: Record<ProjectPersonView['kind'], number> = { member: 0, added: 1, former: 2 }

export function participantRows(people: readonly ProjectPersonView[], roster: ProjectRoster | null): ParticipantRow[] {
  const byUser = new Map((roster?.members ?? []).map((member) => [member.userId, member]))
  return people
    .map((person, index) => ({ person, index }))
    .sort((a, b) => ORDER[a.person.kind] - ORDER[b.person.kind] || a.index - b.index)
    .map(({ person }) => {
      const member = person.kind === 'member' && person.userId ? (byUser.get(person.userId) ?? null) : null
      const you = Boolean(person.userId && roster?.viewerUserId === person.userId)
      return {
        key: participantKey(person),
        person,
        role: member?.role ?? null,
        // Nobody changes their own access here: Settings → Mitglieder asks first.
        membership: member && !you ? member : null,
        you,
      }
    })
}

/** Colleagues in the organization who hold no role on the project yet: who „Kollegin hinzufügen" offers. */
export function colleagueCandidates(roster: ProjectRoster | null): RosterMember[] {
  if (!roster) return []
  return roster.members
    .filter((member) => member.role === null)
    .sort((a, b) => a.name.localeCompare(b.name, 'de'))
}

/** The role a colleague added in the setup gets unless the person picks another: they may work with Piloti and the documents. */
export const DEFAULT_COLLEAGUE_ROLE: ProjectMemberRoleSlug = 'project-editor'
