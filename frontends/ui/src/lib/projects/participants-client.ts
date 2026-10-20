/**
 * The typed client for a project's Beteiligte (ADR-0055): the routes the setup's
 * first step (ticket 26) reads and writes, each written once here.
 *
 *   - `GET /api/projects/[id]`: the name and the status;
 *   - `GET /api/projects/[id]/steckbrief`: the people (ADR-0091, ADR-0101):
 *     members listed from the roster, everyone else stored by hand;
 *   - `GET|POST /api/projects/[id]/members`: the organization's roster with each
 *     member's project role, and a role given or taken. Only who may manage
 *     the project's members gets an answer; a refusal reads as `null`;
 *   - `POST|PATCH|DELETE /api/projects/[id]/people[/personId]`: a person added,
 *     described or erased.
 *
 * Who may do what is the services' (`members-service`, `steckbrief-service`);
 * this client only says what the answer was. Responses are parsed with zod,
 * not cast. No `server-only`: the browser imports this.
 */

import { z } from 'zod'
import { isMonth, type Month } from './month'
import { PROJECT_STATUSES } from './project-status'
import type { ProjectPersonInput, ProjectRecordView } from './project-record-types'

/** The project roles a member can hold, as the members route takes them. */
export const PROJECT_MEMBER_ROLES = ['project-viewer', 'project-contributor', 'project-editor', 'project-admin'] as const
export type ProjectMemberRoleSlug = (typeof PROJECT_MEMBER_ROLES)[number]

const month = z.custom<Month>((value) => typeof value === 'string' && isMonth(value), 'A month, YYYY-MM.')

const projectBasicsSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  status: z.enum(PROJECT_STATUSES),
})
export type ProjectBasics = z.infer<typeof projectBasicsSchema>

const personViewSchema = z.object({
  id: z.string().nullable(),
  kind: z.enum(['member', 'former', 'added']),
  userId: z.string().nullable(),
  name: z.string(),
  function: z.string().nullable(),
  company: z.string().nullable(),
  startedOn: month.nullable(),
  endedOn: month.nullable(),
})

const peopleRecordSchema = z.object({
  address: z.string().nullable(),
  startedOn: month.nullable(),
  startedOnIsDefault: z.boolean(),
  endedOn: month.nullable(),
  people: z.array(personViewSchema),
  rosterKnown: z.boolean(),
  canEdit: z.boolean(),
  canErase: z.boolean(),
}) satisfies z.ZodType<ProjectRecordView>

const rosterMemberSchema = z.object({
  organizationMembershipId: z.string().min(1),
  userId: z.string().min(1),
  email: z.string().nullable(),
  profilePictureUrl: z.string().nullable(),
  name: z.string(),
  role: z.enum(PROJECT_MEMBER_ROLES).nullable(),
})
export type RosterMember = z.infer<typeof rosterMemberSchema>

const rosterSchema = z.object({
  members: z.array(rosterMemberSchema),
  /** The reader's own account: their row is not theirs to change here. */
  viewerUserId: z.string().nullable().catch(null),
})
export type ProjectRoster = z.infer<typeof rosterSchema>

export type ParticipantsFetch = (path: string, init?: RequestInit) => Promise<Response>

const defaultFetch: ParticipantsFetch = (path, init) => fetch(path, init)

/** A request the API refused: its status and, where the API names one, the reason (`last-admin`, `project-closed`). */
export class ParticipantsRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly reason: string | null = null
  ) {
    super(message)
    this.name = 'ParticipantsRequestError'
  }
}

export interface ParticipantsClient {
  project(projectId: string): Promise<ProjectBasics>
  peopleRecord(projectId: string): Promise<ProjectRecordView>
  /** The roster with roles, or null when the reader may not manage the project's members. */
  roster(projectId: string): Promise<ProjectRoster | null>
  /** Give a member a role, or take their access away with `''`. */
  setRole(projectId: string, organizationMembershipId: string, role: ProjectMemberRoleSlug | ''): Promise<void>
  /** Add a person, or describe one already stored (`personId`). A member's row is keyed by `userId`. */
  savePerson(projectId: string, person: ProjectPersonInput, personId: string | null): Promise<void>
  removePerson(projectId: string, personId: string): Promise<void>
}

const projectPath = (projectId: string): string => `/api/projects/${encodeURIComponent(projectId)}`

async function request(run: ParticipantsFetch, path: string, method: string, payload?: unknown): Promise<unknown> {
  const init: RequestInit =
    payload === undefined
      ? { method }
      : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }
  const response = await run(path, init)
  const body: unknown = response.status === 204 ? null : await response.json().catch(() => null)
  if (!response.ok) {
    const error = (body ?? {}) as { error?: string; details?: { reason?: unknown } }
    const reason = typeof error.details?.reason === 'string' ? error.details.reason : null
    throw new ParticipantsRequestError(response.status, error.error ?? `Request failed with ${response.status}`, reason)
  }
  return body
}

export function createParticipantsClient(fetchImpl: ParticipantsFetch = defaultFetch): ParticipantsClient {
  return {
    async project(projectId) {
      return projectBasicsSchema.parse(await request(fetchImpl, projectPath(projectId), 'GET'))
    },
    async peopleRecord(projectId) {
      return peopleRecordSchema.parse(await request(fetchImpl, `${projectPath(projectId)}/steckbrief`, 'GET'))
    },
    async roster(projectId) {
      try {
        return rosterSchema.parse(await request(fetchImpl, `${projectPath(projectId)}/members`, 'GET'))
      } catch (error) {
        if (error instanceof ParticipantsRequestError && error.status === 403) return null
        throw error
      }
    },
    async setRole(projectId, organizationMembershipId, role) {
      await request(fetchImpl, `${projectPath(projectId)}/members`, 'POST', { organizationMembershipId, roleSlug: role })
    },
    async savePerson(projectId, person, personId) {
      if (personId) {
        await request(fetchImpl, `${projectPath(projectId)}/people/${encodeURIComponent(personId)}`, 'PATCH', person)
        return
      }
      await request(fetchImpl, `${projectPath(projectId)}/people`, 'POST', person)
    },
    async removePerson(projectId, personId) {
      await request(fetchImpl, `${projectPath(projectId)}/people/${encodeURIComponent(personId)}`, 'DELETE')
    },
  }
}
