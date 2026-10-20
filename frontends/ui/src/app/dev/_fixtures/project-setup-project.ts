/**
 * Step 1 („Projekt") of the setup for the `/dev/project-setup` preview and its
 * specs: `?step=project&state=<name>`, one of {@link PROJECT_STEP_STATES}.
 *
 *   - `fresh`: created a moment ago; the creator is the only one on it, three
 *     colleagues could be added;
 *   - `team`: colleagues with roles and Funktionen, a Statikerin and the
 *     Bauherrschaft without an account, and a former member;
 *   - `viewer`: a reader who may neither edit the project nor manage its
 *     members: everything is shown, nothing offered;
 *   - `closing`: a past project being read for the office's reference.
 *
 * The step reads and writes through a {@link ParticipantsClient}; the one here
 * answers from memory and changes it, so adding, describing, giving a role or
 * removing someone in the preview shows its result, as on the real page.
 */

import type { IntakeView } from '@/lib/project-intake/types'
import type {
  ParticipantsClient,
  ProjectBasics,
  ProjectRoster,
  RosterMember,
} from '@/lib/projects/participants-client'
import type { ProjectPersonView, SteckbriefView } from '@/lib/projects/steckbrief-types'
import { FIXTURE_PROJECT_ID, INTAKE_CLOSING, INTAKE_READY, INTAKE_WAITING } from './project-intake'

export const PROJECT_STEP_STATES = ['fresh', 'team', 'viewer', 'closing'] as const
export type ProjectStepState = (typeof PROJECT_STEP_STATES)[number]

export function isProjectStepState(value: unknown): value is ProjectStepState {
  return typeof value === 'string' && (PROJECT_STEP_STATES as readonly string[]).includes(value)
}

export interface ProjectStepFixture {
  view: IntakeView
  project: ProjectBasics
  peopleRecord: SteckbriefView
  /** Null: the reader may not manage the project's members. */
  roster: ProjectRoster | null
}

const PROJECT: ProjectBasics = { id: FIXTURE_PROJECT_ID, name: 'Aufstockung Lacknergasse', status: 'active' }

const ME = 'user-mk'

const roster = (userId: string, name: string, email: string, role: RosterMember['role']): RosterMember => ({
  organizationMembershipId: `om-${userId}`,
  userId,
  email,
  profilePictureUrl: null,
  name,
  role,
})

const member = (userId: string, name: string, fields: Partial<ProjectPersonView> = {}): ProjectPersonView => ({
  id: null,
  kind: 'member',
  userId,
  name,
  function: null,
  company: null,
  startedOn: '2026-10',
  endedOn: null,
  ...fields,
})

const external = (id: string, name: string, work: string, company: string | null): ProjectPersonView => ({
  id,
  kind: 'added',
  userId: null,
  name,
  function: work,
  company,
  startedOn: null,
  endedOn: null,
})

/** The office: who could be on the project. */
const OFFICE = [
  roster(ME, 'Mag. arch. Martina Kogler', 'm.kogler@buero-kogler.at', 'project-admin'),
  roster('user-ab', 'Andreas Berger', 'a.berger@buero-kogler.at', null),
  roster('user-sh', 'Sophie Hartl', 's.hartl@buero-kogler.at', null),
  roster('user-tw', 'Thomas Wimmer', 't.wimmer@buero-kogler.at', null),
]

const PEOPLE_RECORD: SteckbriefView = {
  address: 'Lacknergasse 12, 1170 Wien',
  startedOn: '2026-10',
  startedOnIsDefault: true,
  endedOn: null,
  people: [member(ME, 'Mag. arch. Martina Kogler')],
  rosterKnown: true,
  canEdit: true,
  canErase: true,
}

const TEAM_PEOPLE_RECORD: SteckbriefView = {
  ...PEOPLE_RECORD,
  startedOn: '2026-03',
  startedOnIsDefault: false,
  people: [
    member(ME, 'Mag. arch. Martina Kogler', { id: 'person-mk', function: 'Projektleitung', startedOn: '2026-03' }),
    member('user-ab', 'Andreas Berger', { id: 'person-ab', function: 'Einreichplanung', startedOn: '2026-04' }),
    member('user-sh', 'Sophie Hartl', { startedOn: '2026-09' }),
    external('person-hu', 'DI Maria Huber', 'Statik', 'Huber ZT GmbH'),
    external('person-gw', 'Gemeinnützige Wohnbau Ottakring', 'Bauherrschaft', null),
    { ...member('user-ls', 'Lukas Steiner', { id: 'person-ls', function: 'Wettbewerb', startedOn: '2026-03', endedOn: '2026-06' }), kind: 'former' },
  ],
}

const TEAM_OFFICE = OFFICE.map((entry) =>
  entry.userId === 'user-ab' ? { ...entry, role: 'project-editor' as const } : entry.userId === 'user-sh' ? { ...entry, role: 'project-contributor' as const } : entry
)

export const PROJECT_STEP_FIXTURES: Record<ProjectStepState, ProjectStepFixture> = {
  fresh: {
    view: INTAKE_WAITING,
    project: PROJECT,
    peopleRecord: PEOPLE_RECORD,
    roster: { members: OFFICE, viewerUserId: ME },
  },
  team: {
    view: INTAKE_READY,
    project: PROJECT,
    peopleRecord: TEAM_PEOPLE_RECORD,
    roster: { members: TEAM_OFFICE, viewerUserId: ME },
  },
  viewer: {
    view: { ...INTAKE_READY, canDecide: false },
    project: PROJECT,
    peopleRecord: { ...TEAM_PEOPLE_RECORD, canEdit: false, canErase: false },
    roster: null,
  },
  closing: {
    view: INTAKE_CLOSING,
    project: { ...PROJECT, name: 'Wohnhausanlage Quellenstraße' },
    peopleRecord: { ...PEOPLE_RECORD, startedOn: '2019-03', startedOnIsDefault: false },
    roster: { members: OFFICE, viewerUserId: ME },
  },
}

/**
 * A client that answers from the fixture and keeps what the preview changes:
 * a role given puts the colleague on the Steckbrief, as the roster does on the
 * real page; taking it away keeps them as a former member.
 */
export function createFixtureParticipantsClient(state: ProjectStepState): ParticipantsClient {
  const fixture = PROJECT_STEP_FIXTURES[state]
  let peopleRecord = structuredClone(fixture.peopleRecord)
  let office = fixture.roster ? structuredClone(fixture.roster.members) : null
  let next = 0
  const thisMonth = '2026-10' as const

  return {
    project: async () => fixture.project,
    peopleRecord: async () => structuredClone(peopleRecord),
    roster: async () => (office && fixture.roster ? { members: structuredClone(office), viewerUserId: fixture.roster.viewerUserId } : null),
    async setRole(_projectId, organizationMembershipId, role) {
      const entry = office?.find((candidate) => candidate.organizationMembershipId === organizationMembershipId)
      if (!office || !entry) throw new Error('No such member in the fixture')
      office = office.map((candidate) => (candidate === entry ? { ...candidate, role: role || null } : candidate))
      const listed = peopleRecord.people.find((person) => person.userId === entry.userId)
      const people = role
        ? listed
          ? peopleRecord.people.map((person) => (person === listed ? { ...person, kind: 'member' as const, endedOn: null } : person))
          : [...peopleRecord.people, member(entry.userId, entry.name, { startedOn: thisMonth })]
        : peopleRecord.people.map((person) =>
            person === listed ? { ...person, id: person.id ?? `person-${++next}`, kind: 'former' as const, endedOn: thisMonth } : person
          )
      peopleRecord = { ...peopleRecord, people }
    },
    async savePerson(_projectId, input, personId) {
      const fields = { name: input.name, function: input.function, company: input.company, startedOn: input.startedOn, endedOn: input.endedOn }
      const byUser = input.userId ? peopleRecord.people.find((person) => person.userId === input.userId) : undefined
      const target = personId ? peopleRecord.people.find((person) => person.id === personId) : byUser
      const people = target
        ? peopleRecord.people.map((person) => (person === target ? { ...person, ...fields, id: person.id ?? `person-${++next}` } : person))
        : [...peopleRecord.people, { ...fields, id: `person-${++next}`, kind: 'added' as const, userId: null }]
      peopleRecord = { ...peopleRecord, people }
    },
    async removePerson(_projectId, personId) {
      peopleRecord = { ...peopleRecord, people: peopleRecord.people.filter((person) => person.id !== personId) }
    },
  }
}
