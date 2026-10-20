/**
 * The Steckbrief of a project (ADR-0091): address, period, and everyone who
 * worked on it. The address is the profile fact `site_address` and is
 * edited where every fact is, in the intake wizard; this service owns the
 * period and the people.
 *
 * It fills itself as far as Piloti knows: the Beginn is the month the project
 * was created until someone sets it, the project's members are listed from
 * WorkOS without anyone typing them in, and a member removed from the project
 * stays on as a former member (`recordMemberLeft`). What a person adds by hand
 * is everyone else, and a member's Funktion, Firma and months.
 *
 * Who may do what:
 *   - read: `project:view`, so every member of the office reads a closed
 *     project's Steckbrief (ADR-0090);
 *   - change the period or a person: the profile's write permissions, refused
 *     in a closed project like every other write;
 *   - delete a person: the same in an active project, and `project:manage` in a
 *     closed one, because deleting a person is how their data is erased (GDPR
 *     Art. 17) and erasure cannot wait for a reopen.
 *
 * People are personal data of people who mostly never gave it. They are kept
 * here and nowhere else: not in the profile, so never in the agent's prompt
 * (`lib/project-profile/prompt-view.ts` reads only the profile), and the audit
 * trail names a person by id, never by name.
 */

import 'server-only'
import { BadRequestError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { requireProjectAccess, type ProjectPermission } from '@/lib/authz/projects'
import { isUserInOrganization } from '@/lib/authz/project-membership'
import { recordAuditEvent } from '@/lib/audit/service'
import type { ProjectPersonRow } from '@/lib/db/schema'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
import { findProjectProfile } from './repository'
import { currentMonth, dateToMonth, isOrderedPeriod, monthToDate, type Month } from './month'
import { closingOf, isProjectClosed, projectClosedError } from './project-status'
import { loadProjectTeam } from './project-team'
import {
  deleteProjectPersonRow,
  findProjectPeriod,
  findProjectPersonByUser,
  insertProjectPerson,
  listProjectPeople,
  updateProjectPeriod,
  updateProjectPersonRow,
  type ProjectPeriodRow,
  type ProjectPersonValues,
} from './project-record-repository'
import { mergePeople } from './project-record-people'
import type { ProjectPeriodInput, ProjectPersonInput, ProjectPersonView, ProjectRecordView } from './project-record-types'

/** The profile's write permissions: the Steckbrief is part of the profile (`profile-service.ts`). */
const PROJECT_RECORD_WRITE: readonly ProjectPermission[] = ['project:memory:write', 'project:edit']

const toDate = (month: Month | null): string | null => (month ? monthToDate(month) : null)

async function mayWrite(session: AuthorizedSession, projectId: string): Promise<boolean> {
  return requireProjectAccess(session, projectId, PROJECT_RECORD_WRITE).then(
    () => true,
    () => false
  )
}

async function mayErase(session: AuthorizedSession, projectId: string, closed: boolean): Promise<boolean> {
  if (!closed) return mayWrite(session, projectId)
  return requireProjectAccess(session, projectId, 'project:manage', { evenWhenClosed: true }).then(
    () => true,
    () => false
  )
}

function personView(row: ProjectPersonRow): ProjectPersonView {
  return mergePeople([row], null)[0]
}

/**
 * The Beginn as the Steckbrief shows it: the one set, else the month the
 * project was created, the same start the reference ranking reads
 * (`projectPeriodOf`). Not when that would lie after the Abschluss, as it does
 * for a finished project brought into Piloti later.
 */
function startOf(period: ProjectPeriodRow): { startedOn: Month | null; isDefault: boolean } {
  const set = dateToMonth(period.startedOn)
  if (set) return { startedOn: set, isDefault: false }
  const created = dateToMonth(period.createdAt)
  const usable = created && isOrderedPeriod(created, dateToMonth(closingOf(period)))
  return usable ? { startedOn: created, isDefault: true } : { startedOn: null, isDefault: false }
}

function addressOf(profile: Awaited<ReturnType<typeof findProjectProfile>>): string | null {
  const value = profile?.facts?.site_address?.value
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

export async function getProjectRecord(session: AuthorizedSession, projectId: string): Promise<ProjectRecordView> {
  const { closed } = await requireProjectAccess(session, projectId, 'project:view')
  const [period, profile, rows, team, canEdit, canErase] = await Promise.all([
    findProjectPeriod(projectId, session.organizationId),
    findProjectProfile(projectId, session.organizationId),
    listProjectPeople(projectId, session.organizationId),
    loadProjectTeam(projectId, session.organizationId),
    mayWrite(session, projectId),
    mayErase(session, projectId, closed),
  ])
  if (!period) throw new NotFoundError()
  const start = startOf(period)
  return {
    address: addressOf(profile),
    startedOn: start.startedOn,
    startedOnIsDefault: start.isDefault,
    endedOn: dateToMonth(closingOf(period)),
    people: mergePeople(rows, team),
    rosterKnown: team !== null,
    canEdit,
    canErase,
  }
}

export async function setProjectPeriod(
  session: AuthorizedSession,
  projectId: string,
  input: ProjectPeriodInput,
  request?: Request
): Promise<{ startedOn: Month | null }> {
  await requireProjectAccess(session, projectId, PROJECT_RECORD_WRITE)
  const row = await updateProjectPeriod(projectId, session.organizationId, toDate(input.startedOn))
  if (!row) {
    // Closed between the access check and the write, or gone.
    if (isProjectClosed(await findProjectPeriod(projectId, session.organizationId))) throw projectClosedError()
    throw new NotFoundError()
  }
  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'project.period.changed',
    targetType: 'project',
    targetId: projectId,
    metadata: { startedOn: input.startedOn ?? '' },
    request,
  })
  return { startedOn: dateToMonth(row.startedOn) }
}

/** The stored values of a person, the account link checked: it must name a member of this organization. */
async function personValues(session: AuthorizedSession, input: ProjectPersonInput): Promise<ProjectPersonValues> {
  if (input.userId && !(await isUserInOrganization(session, input.userId))) {
    throw new BadRequestError('The linked account is not a member of this organization.', { reason: 'unknown-account' })
  }
  return {
    name: input.name,
    function: input.function,
    company: input.company,
    startedOn: toDate(input.startedOn),
    endedOn: toDate(input.endedOn),
    userId: input.userId,
  }
}

async function auditPerson(
  session: AuthorizedSession,
  projectId: string,
  action: 'project.person.added' | 'project.person.updated' | 'project.person.deleted',
  personId: string,
  request?: Request
): Promise<void> {
  // By id only: the audit log outlives an erasure, and a name in it would not.
  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action,
    targetType: 'project',
    targetId: projectId,
    metadata: { personId },
    request,
  })
}

export async function addProjectPerson(
  session: AuthorizedSession,
  projectId: string,
  input: ProjectPersonInput,
  request?: Request
): Promise<ProjectPersonView> {
  await requireProjectAccess(session, projectId, PROJECT_RECORD_WRITE)
  const values = await personValues(session, input)
  // A member is described by one row: describing them again updates it.
  const existing = values.userId ? await findProjectPersonByUser(projectId, session.organizationId, values.userId) : null
  if (existing) return updateProjectPerson(session, projectId, existing.id, input, request)
  const row = await insertProjectPerson(projectId, session.organizationId, session.userId, values)
  await auditPerson(session, projectId, 'project.person.added', row.id, request)
  return personView(row)
}

export async function updateProjectPerson(
  session: AuthorizedSession,
  projectId: string,
  personId: string,
  input: ProjectPersonInput,
  request?: Request
): Promise<ProjectPersonView> {
  await requireProjectAccess(session, projectId, PROJECT_RECORD_WRITE)
  const row = await updateProjectPersonRow(projectId, session.organizationId, personId, await personValues(session, input))
  if (!row) throw new NotFoundError('Person not found')
  await auditPerson(session, projectId, 'project.person.updated', row.id, request)
  return personView(row)
}

/** Delete a person outright (the erasure). Possible in a closed project for whoever manages it. */
export async function deleteProjectPerson(
  session: AuthorizedSession,
  projectId: string,
  personId: string,
  request?: Request
): Promise<void> {
  const { closed } = await requireProjectAccess(session, projectId, 'project:view')
  if (closed) {
    await requireProjectAccess(session, projectId, 'project:manage', { evenWhenClosed: true })
  } else {
    await requireProjectAccess(session, projectId, PROJECT_RECORD_WRITE)
  }
  if (!(await deleteProjectPersonRow(projectId, session.organizationId, personId))) {
    throw new NotFoundError('Person not found')
  }
  await auditPerson(session, projectId, 'project.person.deleted', personId, request)
}

/**
 * A member was removed from the project: keep them on its Steckbrief as a
 * former member, until this month. Their row gets its end, or is written from
 * the directory's name and the month they joined. Not in a closed project,
 * which is read-only; and never more than names and months.
 *
 * Called by the members service after the removal it authorized, so it checks
 * no permission of its own. Best-effort: a failure here must not undo an
 * access-control change, so it is logged and swallowed.
 */
export async function recordMemberLeft(
  session: AuthorizedSession,
  projectId: string,
  member: { userId: string; since: Month | null }
): Promise<void> {
  try {
    const period = await findProjectPeriod(projectId, session.organizationId)
    if (!period || isProjectClosed(period)) return
    const left = currentMonth()
    const row = await findProjectPersonByUser(projectId, session.organizationId, member.userId)
    if (row) {
      if (row.endedOn || !isOrderedPeriod(dateToMonth(row.startedOn), left)) return
      await updateProjectPersonRow(projectId, session.organizationId, row.id, { ...valuesOf(row), endedOn: monthToDate(left) })
      await auditPerson(session, projectId, 'project.person.updated', row.id)
      return
    }
    const name = (await loadOrganizationDirectory(session.organizationId)).get(member.userId)?.name
    if (!name) return
    const since = member.since && isOrderedPeriod(member.since, left) ? member.since : null
    const added = await insertProjectPerson(projectId, session.organizationId, session.userId, {
      name,
      function: null,
      company: null,
      startedOn: toDate(since),
      endedOn: monthToDate(left),
      userId: member.userId,
    })
    await auditPerson(session, projectId, 'project.person.added', added.id)
  } catch (error) {
    console.warn(`[project-record] could not keep ${projectId}'s departing member:`, error)
  }
}

/** A former member is back on the project: their row loses the end their leaving gave it. Best-effort, as above. */
export async function recordMemberRejoined(session: AuthorizedSession, projectId: string, userId: string): Promise<void> {
  try {
    const row = await findProjectPersonByUser(projectId, session.organizationId, userId)
    if (!row?.endedOn) return
    if (!(await updateProjectPersonRow(projectId, session.organizationId, row.id, { ...valuesOf(row), endedOn: null }))) return
    await auditPerson(session, projectId, 'project.person.updated', row.id)
  } catch (error) {
    console.warn(`[project-record] could not reopen ${projectId}'s returning member:`, error)
  }
}

function valuesOf(row: ProjectPersonRow): ProjectPersonValues {
  return {
    name: row.name,
    function: row.function,
    company: row.company,
    startedOn: row.startedOn,
    endedOn: row.endedOn,
    userId: row.userId,
  }
}
