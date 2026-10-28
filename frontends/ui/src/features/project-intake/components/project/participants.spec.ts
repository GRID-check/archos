/**
 * @vitest-environment node
 */
/**
 * The Beteiligte as one list: the Steckbrief decides who is on it, the roster
 * adds the role, and nobody's own access is offered for change.
 */
import { describe, expect, test } from 'vitest'
import type { ProjectRoster } from '@/lib/projects/participants-client'
import { PROJECT_STEP_FIXTURES } from '@/app/dev/_fixtures/project-setup-project'
import { colleagueCandidates, participantRows } from './participants'

const team = PROJECT_STEP_FIXTURES.team

describe('participantRows', () => {
  test('members lead, then everyone added by hand, then former members', () => {
    const rows = participantRows(team.peopleRecord.people, team.roster)
    expect(rows.map((row) => [row.person.name, row.person.kind])).toEqual([
      ['Mag. arch. Martina Kogler', 'member'],
      ['Andreas Berger', 'member'],
      ['Sophie Hartl', 'member'],
      ['DI Maria Huber', 'added'],
      ['Gemeinnützige Wohnbau Ottakring', 'added'],
      ['Lukas Steiner', 'former'],
    ])
  })

  test("a member carries the roster's role; the reader's own row shows it but may not change it", () => {
    const rows = participantRows(team.peopleRecord.people, team.roster)
    const [me, andreas] = rows
    expect(me).toMatchObject({ you: true, role: 'project-admin', membership: null })
    expect(andreas).toMatchObject({ you: false, role: 'project-editor' })
    expect(andreas.membership?.organizationMembershipId).toBe('om-user-ab')
  })

  test('an external or former person has no role, and without the roster nobody does', () => {
    const rows = participantRows(team.peopleRecord.people, team.roster)
    expect(rows.filter((row) => row.person.kind !== 'member').every((row) => row.role === null && row.membership === null)).toBe(true)
    expect(participantRows(team.peopleRecord.people, null).every((row) => row.role === null && !row.you)).toBe(true)
  })

  test('someone with a role on the roster but not on the Steckbrief (an organization admin) is not listed', () => {
    const roster: ProjectRoster = {
      viewerUserId: null,
      members: [{ organizationMembershipId: 'om-x', userId: 'user-x', email: null, profilePictureUrl: null, name: 'Org Admin', role: 'project-admin' }],
    }
    expect(participantRows([], roster)).toEqual([])
  })
})

describe('colleagueCandidates', () => {
  test('offers who holds no role yet, by name', () => {
    expect(colleagueCandidates(PROJECT_STEP_FIXTURES.fresh.roster).map((member) => member.name)).toEqual([
      'Andreas Berger',
      'Sophie Hartl',
      'Thomas Wimmer',
    ])
    expect(colleagueCandidates(team.roster).map((member) => member.name)).toEqual(['Thomas Wimmer'])
  })

  test('offers nobody to a reader who may not manage the members', () => {
    expect(colleagueCandidates(null)).toEqual([])
  })
})
