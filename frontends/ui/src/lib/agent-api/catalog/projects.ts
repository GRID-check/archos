/**
 * The projects operations (ADR-0122), and the exemplar the other domain files
 * follow.
 *
 * Each entry names a route the UI already calls. The rules, in short (the long
 * form is `docs/architecture/agent-surface.md`):
 *
 * - `name` is `<entity>-<verb>`, kebab-case: `project-list`, `project-member-add`.
 * - `description` says when to call it, what comes back, and what to call next,
 *   in English, for a model. Name the identifiers it needs and where to get them.
 * - `body` IS the route's schema, imported from `lib/`. A schema that lives
 *   inside a route file moves to a `lib/<area>/*-wire.ts` module both import;
 *   a second hand-written copy is the drift ADR-0055 exists to prevent.
 * - `load` imports exactly the route file `path` names.
 * - `destructive` for anything a person confirms in the UI.
 */

import { z } from 'zod'
import {
  consistencyCheckSchema,
  generateSummaryRequestSchema,
  patchProfileSchema,
} from '@/lib/project-profile/profile-wire'
import { ProjectProfileSchema } from '@/lib/project-profile/types'
import { intakeDecisionsRequestSchema, startIntakeRequestSchema } from '@/lib/project-intake/types'
import { confirmCleanupSchema, proposeCleanupSchema } from '@/lib/projects/cleanup-wire'
import { createProjectSchema } from '@/lib/projects/create-project-schema'
import { addMemberSchema } from '@/lib/projects/project-members-wire'
import {
  createMemorySchema,
  listMemoryQuerySchema,
  patchMemorySchema,
} from '@/lib/projects/project-memory-wire'
import { projectPeriodSchema, projectPersonSchema } from '@/lib/projects/project-record-types'
import {
  deleteProjectSchema,
  projectStatusSchema,
  renameProjectSchema,
  sameAddressQuerySchema,
} from '@/lib/projects/project-wire'
import { projectScreeningOverrideSchema } from '@/lib/upload-screening/project-policy'
import type { AgentOperation } from '../operation'

const projectParams = z.object({ id: z.string().describe('The project id, from project-list.') })

const memberParams = projectParams.extend({
  assignmentId: z
    .string()
    .describe('The role assignment id of the member, from project-member-list (members[].id).'),
})
const memoryItemParams = projectParams.extend({
  itemId: z.string().describe('The memory item id, from project-memory-list (items[].id).'),
})
const personParams = projectParams.extend({
  personId: z
    .string()
    .describe(
      'The stored person id, from project-record-get (people[].id). A member nobody described yet has no id; add them first.'
    ),
})

export const projectsOperations = [
  {
    name: 'project-list',
    domain: 'projects',
    summary: 'List the projects the person can see',
    description:
      'Every project the person may open in this organization, with its id, name and lifecycle status. ' +
      'Start here: most other operations take a project id from this list.',
    method: 'GET',
    path: '/api/projects',
    spansProjects: 'always',
    load: () => import('@/app/api/projects/route'),
  },
  {
    name: 'project-get',
    domain: 'projects',
    summary: 'Read one project',
    description: 'One project by id: name, status, dates and the person’s access to it.',
    method: 'GET',
    path: '/api/projects/[id]',
    params: projectParams,
    load: () => import('@/app/api/projects/[id]/route'),
  },
  {
    name: 'project-rename',
    domain: 'projects',
    summary: 'Rename a project',
    description: 'Give a project a new name. Needs the project:manage permission on that project.',
    method: 'PATCH',
    path: '/api/projects/[id]',
    params: projectParams,
    body: renameProjectSchema,
    idempotent: true,
    load: () => import('@/app/api/projects/[id]/route'),
  },
  {
    name: 'project-delete',
    domain: 'projects',
    summary: 'Move a project to the recently deleted list',
    description:
      'Soft-deletes a project; it is purged after the date the response names and can be restored until then ' +
      '(project-restore). Requires `confirmName`, the project’s exact current name, as the dialog does.',
    method: 'DELETE',
    path: '/api/projects/[id]',
    params: projectParams,
    body: deleteProjectSchema,
    load: () => import('@/app/api/projects/[id]/route'),
  },

  {
    name: 'project-create',
    domain: 'projects',
    summary: 'Create a project',
    description:
      'Creates a project in the organization and returns it with its id. Give a name; optionally the address (a geocoder hit as `location`, or typed `address`), ' +
      'a description, and `setup`: `piloti` (default) has Piloti read the documents afterwards, `self` leaves the profile to the intake wizard. ' +
      'To add a past project as a reference, pass `closing` with the outcome and months. Call project-same-address-list first to avoid a duplicate. ' +
      'Next: upload documents, then project-intake-get to follow the reading.',
    method: 'POST',
    path: '/api/projects',
    body: createProjectSchema,
    load: () => import('@/app/api/projects/route'),
  },
  {
    name: 'project-same-address-list',
    domain: 'projects',
    summary: 'Find projects at an address',
    description:
      'Up to three projects the person may open that sit at the given address, as `{ projects: [{ id, name, status }] }`. ' +
      'Call before project-create to warn about a duplicate. `label` is the address text; `lat` and `lon` sharpen the match.',
    method: 'GET',
    path: '/api/projects/same-address',
    query: sameAddressQuerySchema,
    spansProjects: 'always',
    load: () => import('@/app/api/projects/same-address/route'),
  },
  {
    name: 'project-overview-get',
    domain: 'projects',
    summary: 'Read a project’s overview',
    description:
      'The project’s overview as its home page shows it: profile summary, counts and the latest activity. ' +
      'A good first read once you have a project id from project-list.',
    method: 'GET',
    path: '/api/projects/[id]/overview',
    params: projectParams,
    load: () => import('@/app/api/projects/[id]/overview/route'),
  },
  {
    name: 'project-status-set',
    domain: 'projects',
    summary: 'Pause, resume or close a project',
    description:
      'Moves a project through its lifecycle. `{ status: "active" }` resumes or reopens, `{ status: "paused" }` pauses, ' +
      '`{ status: "closed", outcome, endedOn }` closes it with how it ended and its completion month (YYYY-MM). ' +
      'Needs project:manage and works on a closed project too. Answers the new status and dates. Before closing, consider project-cleanup-propose.',
    method: 'PUT',
    path: '/api/projects/[id]/status',
    params: projectParams,
    body: projectStatusSchema,
    load: () => import('@/app/api/projects/[id]/status/route'),
  },
  {
    name: 'project-restore',
    domain: 'projects',
    summary: 'Restore a deleted project',
    description:
      'Brings a soft-deleted project back during its grace period (see project-delete for the purge date). ' +
      'Needs project:manage. Answers `{ status: "restored" }`.',
    method: 'POST',
    path: '/api/projects/[id]/restore',
    params: projectParams,
    idempotent: true,
    load: () => import('@/app/api/projects/[id]/restore/route'),
  },
  {
    name: 'project-reindex',
    domain: 'projects',
    summary: 'Rebuild a project’s document index',
    description:
      'Queues a job that rebuilds the search chunks of every document in the project, and answers 202 with the job id at once. ' +
      'Use when answers seem to miss documents that are on the shelf. It carries on after the call returns and is safe to repeat.',
    method: 'POST',
    path: '/api/projects/[id]/reindex',
    params: projectParams,
    idempotent: true,
    load: () => import('@/app/api/projects/[id]/reindex/route'),
  },
  {
    name: 'project-member-list',
    domain: 'projects',
    summary: 'List a project’s members',
    description:
      'The project roster: each member with their role and the role assignment id (members[].id), plus `viewerUserId`, the caller’s own user id. ' +
      'Needs project:members:manage. Use the assignment id with project-member-remove.',
    method: 'GET',
    path: '/api/projects/[id]/members',
    params: projectParams,
    load: () => import('@/app/api/projects/[id]/members/route'),
  },
  {
    name: 'project-member-add',
    domain: 'projects',
    summary: 'Give someone a role on a project',
    description:
      'Assigns a project role (`project-viewer`, `project-contributor`, `project-editor`, `project-admin`) to an organization member, ' +
      'or an empty `roleSlug` to clear their project role. `organizationMembershipId` comes from organization-member-list, not a user id. ' +
      'Needs project:members:manage. Check the result with project-member-list.',
    method: 'POST',
    path: '/api/projects/[id]/members',
    params: projectParams,
    body: addMemberSchema,
    idempotent: true,
    sensitivity: 'access',
    load: () => import('@/app/api/projects/[id]/members/route'),
  },
  {
    name: 'project-member-remove',
    domain: 'projects',
    summary: 'Remove a member’s project role',
    description:
      'Removes one role assignment from a project, so the person loses that access. `assignmentId` is members[].id from project-member-list. ' +
      'Needs project:members:manage. Re-adding is project-member-add.',
    method: 'DELETE',
    path: '/api/projects/[id]/members/[assignmentId]',
    params: memberParams,
    destructive: true,
    sensitivity: 'access',
    load: () => import('@/app/api/projects/[id]/members/[assignmentId]/route'),
  },
  {
    name: 'project-memory-list',
    domain: 'projects',
    summary: 'List a project’s memory items',
    description:
      'The facts, decisions and notes Piloti keeps for the project, as `{ items }` with their ids, kind, status, confidence and pinned flag. ' +
      'Pass `includeArchived: "true"` to include archived ones, or `conversationId` for those noted in one conversation. ' +
      'Item ids feed project-memory-update and project-memory-delete.',
    method: 'GET',
    path: '/api/projects/[id]/memory',
    params: projectParams,
    query: listMemoryQuerySchema,
    load: () => import('@/app/api/projects/[id]/memory/route'),
  },
  {
    name: 'project-memory-create',
    domain: 'projects',
    summary: 'Add a memory item',
    description:
      'Writes one memory item by hand: a `kind`, the `content` (up to 2000 characters), and optionally `confidence` and `pinned`. ' +
      'Answers `{ item }` with its id. Needs project:memory:write. Check project-memory-list first so you do not repeat an item.',
    method: 'POST',
    path: '/api/projects/[id]/memory',
    params: projectParams,
    body: createMemorySchema,
    load: () => import('@/app/api/projects/[id]/memory/route'),
  },
  {
    name: 'project-memory-update',
    domain: 'projects',
    summary: 'Edit a memory item',
    description:
      'Changes any of a memory item’s kind, content, status, confidence, verification or pinned flag; at least one field. ' +
      'Set `status` to `dismissed` or `superseded` rather than deleting when the item was only wrong for now. `itemId` is from project-memory-list. Answers `{ item }`.',
    method: 'PATCH',
    path: '/api/projects/[id]/memory/[itemId]',
    params: memoryItemParams,
    body: patchMemorySchema,
    idempotent: true,
    load: () => import('@/app/api/projects/[id]/memory/[itemId]/route'),
  },
  {
    name: 'project-memory-delete',
    domain: 'projects',
    summary: 'Delete a memory item',
    description:
      'Removes one memory item for good; it cannot be undone. Prefer project-memory-update with status `dismissed` when the item may matter later. ' +
      '`itemId` is from project-memory-list.',
    method: 'DELETE',
    path: '/api/projects/[id]/memory/[itemId]',
    params: memoryItemParams,
    destructive: true,
    load: () => import('@/app/api/projects/[id]/memory/[itemId]/route'),
  },
  {
    name: 'project-profile-get',
    domain: 'projects',
    summary: 'Read a project’s profile',
    description:
      'The structured project profile (facts, goals, unknowns, assumptions) with its `profileVersion`. ' +
      'Read it before project-profile-patch or project-profile-replace. The profile has one form, the intake wizard; this is its stored result.',
    method: 'GET',
    path: '/api/projects/[id]/profile',
    params: projectParams,
    load: () => import('@/app/api/projects/[id]/profile/route'),
  },
  {
    name: 'project-profile-replace',
    domain: 'projects',
    summary: 'Replace a project’s whole profile',
    description:
      'Saves the entire profile from project-profile-get, edited. It overwrites everything, so prefer project-profile-patch for a single change. ' +
      'Needs project:edit. Pass `ifMatch`: the `profileVersion` you read, sent as the If-Match header; a 409 means someone saved meanwhile: read again.',
    method: 'PUT',
    path: '/api/projects/[id]/profile',
    params: projectParams,
    body: ProjectProfileSchema,
    ifMatchHeader: true,
    load: () => import('@/app/api/projects/[id]/profile/route'),
  },
  {
    name: 'project-profile-patch',
    domain: 'projects',
    summary: 'Change single profile entries',
    description:
      'Applies JSON-patch style operations (`add`, `replace`, `remove`) to the profile under /facts, /goals, /unknowns or /assumptions. ' +
      'The safer way to edit one fact. Pass `conversationId` when the change came out of a conversation. Needs project:edit. Answers the updated profile; read project-profile-get for paths.',
    method: 'POST',
    path: '/api/projects/[id]/profile/patches',
    params: projectParams,
    body: patchProfileSchema,
    examples: [
      {
        params: { id: '0d7b3a5e-7c1c-4a4e-9a63-6a4a1f5f1c11' },
        body: {
          patch: [
            // A bare value is stored as a confirmed fact.
            { op: 'replace', path: '/facts/building_class', value: 'GK4' },
            { op: 'remove', path: '/unknowns/0' },
          ],
        },
      },
    ],
    load: () => import('@/app/api/projects/[id]/profile/patches/route'),
  },
  {
    name: 'project-intake-definition-get',
    domain: 'projects',
    summary: 'Read the intake questionnaire',
    description:
      'The static intake questionnaire: the sections and questions, with the keys that project-intake-decide and project-profile-patch use. ' +
      'Read it to learn which key an answer belongs to.',
    method: 'GET',
    path: '/api/projects/[id]/intake-definition',
    params: projectParams,
    load: () => import('@/app/api/projects/[id]/intake-definition/route'),
  },
  {
    name: 'project-intake-get',
    domain: 'projects',
    summary: 'Read a project’s intake review',
    description:
      'The project setup from the documents as the person sees it: what Piloti read from the documents, the suggestions waiting for a decision, reading progress and what is still open. ' +
      'Answers `{ intake }`. Decide on suggestions with project-intake-decide; finish with project-intake-complete.',
    method: 'GET',
    path: '/api/projects/[id]/intake',
    params: projectParams,
    load: () => import('@/app/api/projects/[id]/intake/route'),
  },
  {
    name: 'project-intake-start',
    domain: 'projects',
    summary: 'Start Piloti reading the documents',
    description:
      'Starts a reading of the project’s documents now. `scope: "new"` reads what is not read yet; `"all"` forgets what was read and starts over. ' +
      'While one reading runs the next is queued. Needs project:memory:write or project:edit and fails with 409 on a closed project. Answers `{ intake }`; poll project-intake-get.',
    method: 'POST',
    path: '/api/projects/[id]/intake',
    params: projectParams,
    body: startIntakeRequestSchema,
    load: () => import('@/app/api/projects/[id]/intake/route'),
  },
  {
    name: 'project-intake-decide',
    domain: 'projects',
    summary: 'Decide on intake suggestions',
    description:
      'Applies decisions on what Piloti read: `confirm` writes a suggestion (or the alternative at `alternativeIndex`), `dismiss` removes it, ' +
      '`answer` writes the person’s own value, `unknown` records the key as not known. Keys come from project-intake-get. ' +
      'Answers one result per decision, in order, and the intake after them.',
    method: 'POST',
    path: '/api/projects/[id]/intake/decisions',
    params: projectParams,
    body: intakeDecisionsRequestSchema,
    load: () => import('@/app/api/projects/[id]/intake/decisions/route'),
  },
  {
    name: 'project-intake-complete',
    domain: 'projects',
    summary: 'Finish the intake review',
    description:
      'Ends the review of the intake. For a past project created with a closing intent this also closes the project with its outcome and completion month. ' +
      'Call once project-intake-get shows nothing left to decide. Answers `{ intake }`.',
    method: 'POST',
    path: '/api/projects/[id]/intake/complete',
    params: projectParams,
    load: () => import('@/app/api/projects/[id]/intake/complete/route'),
  },
  {
    name: 'project-record-get',
    domain: 'projects',
    summary: 'Read the project record',
    description:
      'The project record: its period (start and completion month) and the people on it, members and former members included, with their function, company and months. ' +
      'people[].id feeds project-person-update and project-person-delete.',
    method: 'GET',
    path: '/api/projects/[id]/project-record',
    params: projectParams,
    load: () => import('@/app/api/projects/[id]/project-record/route'),
  },
  {
    name: 'project-period-set',
    domain: 'projects',
    summary: 'Set a project’s start month',
    description:
      'Sets the project’s start month (`startedOn`, YYYY-MM, or null to clear). The end is not set here: closing the project names it (project-status-set). ' +
      'Answers the updated project record.',
    method: 'PUT',
    path: '/api/projects/[id]/project-record',
    params: projectParams,
    body: projectPeriodSchema,
    load: () => import('@/app/api/projects/[id]/project-record/route'),
  },
  {
    name: 'project-person-add',
    domain: 'projects',
    summary: 'Add a name to the project record’s people list (grants no access)',
    description:
      'Writes someone into the project record’s list of people by hand, such as an external planner: name, optional ' +
      'function, company, start and end month. It grants no access to the project and adds nobody to its team: who ' +
      'may open the project is a project role, project-member-add, which the person may have to set in Piloti ' +
      'themselves. No e-mail or phone is kept. Pass `userId` (from organization-member-list) to describe a colleague ' +
      'of the office instead. Send all fields; use null for unknown.',
    method: 'POST',
    path: '/api/projects/[id]/people',
    params: projectParams,
    body: projectPersonSchema,
    load: () => import('@/app/api/projects/[id]/people/route'),
  },
  {
    name: 'project-person-update',
    domain: 'projects',
    summary: 'Change a person on the project record',
    description:
      'Replaces one person’s entry with the body given, so send every field (name, function, company, startedOn, endedOn, userId), not only the changed one. ' +
      '`personId` is from project-record-get.',
    method: 'PATCH',
    path: '/api/projects/[id]/people/[personId]',
    params: personParams,
    body: projectPersonSchema,
    idempotent: true,
    load: () => import('@/app/api/projects/[id]/people/[personId]/route'),
  },
  {
    name: 'project-person-delete',
    domain: 'projects',
    summary: 'Erase a person from the project record',
    description:
      'Erases one person’s entry from the project record; this is the data-protection erasure and cannot be undone. ' +
      'Still possible in a closed project for whoever manages it. `personId` is from project-record-get.',
    method: 'DELETE',
    path: '/api/projects/[id]/people/[personId]',
    params: personParams,
    destructive: true,
    load: () => import('@/app/api/projects/[id]/people/[personId]/route'),
  },
  {
    name: 'project-upload-screening-get',
    domain: 'projects',
    summary: 'Read the project’s sensitive-data list',
    description:
      'The upload screening policy in force for this project: the office’s list and what the project adds to or removes from its name terms. ' +
      'Any member may read it. Edit with project-upload-screening-set.',
    method: 'GET',
    path: '/api/projects/[id]/upload-screening',
    params: projectParams,
    load: () => import('@/app/api/projects/[id]/upload-screening/route'),
  },
  {
    name: 'project-upload-screening-set',
    domain: 'projects',
    summary: 'Set the project’s sensitive name terms',
    description:
      'Saves the project’s whole override of the sensitive name terms: `addedNameTerms` and `removedNameTerms`. It replaces the earlier override, so read project-upload-screening-get first. ' +
      'Content terms and detectors stay the office’s. Needs project:manage; audited.',
    method: 'PUT',
    path: '/api/projects/[id]/upload-screening',
    params: projectParams,
    body: projectScreeningOverrideSchema,
    sensitivity: 'control',
    load: () => import('@/app/api/projects/[id]/upload-screening/route'),
  },
  {
    name: 'project-cleanup-propose',
    domain: 'projects',
    summary: 'Have Piloti propose what to clear out',
    description:
      'Before a project closes („Ausmisten"): Piloti proposes which documents the finished project no longer needs, among those the person may read and write. ' +
      'Starts a paid model call, so call it once. Nothing is removed. Show the proposal to the person, then send their choice with project-cleanup-confirm.',
    method: 'POST',
    path: '/api/projects/[id]/cleanup/proposal',
    params: projectParams,
    body: proposeCleanupSchema,
    readOnly: true,
    load: () => import('@/app/api/projects/[id]/cleanup/proposal/route'),
  },
  {
    name: 'project-cleanup-confirm',
    domain: 'projects',
    summary: 'Move the chosen documents to the Papierkorb',
    description:
      'Puts the documents the person chose (`documentIds`) into the Papierkorb, all or nothing; they can be restored for 14 days. ' +
      '`proposedIds` is what project-cleanup-propose suggested and `aiUsed` says whether a proposal was used. Never send ids the person did not approve.',
    method: 'POST',
    path: '/api/projects/[id]/cleanup',
    params: projectParams,
    body: confirmCleanupSchema,
    destructive: true,
    load: () => import('@/app/api/projects/[id]/cleanup/route'),
  },
  {
    name: 'project-experience-extract',
    domain: 'projects',
    summary: 'Extract experience from a closing project',
    description:
      'Reads the project’s own documents once and stores what they say as suggestions: unconfirmed facts on the project profile and ' +
      'drafted decisions in project memory, which a person then confirms or dismisses. Refused for a closed project. Starts a paid ' +
      'model call. Needs project:memory:write or project:edit.',
    method: 'POST',
    path: '/api/projects/[id]/experience',
    params: projectParams,
    // Not a read: extractProjectExperience patches the profile (patchProjectProfile) and writes draft decisions.
    idempotent: false,
    load: () => import('@/app/api/projects/[id]/experience/route'),
  },
  {
    name: 'project-consistency-check',
    domain: 'projects',
    summary: 'Check free-text answers for contradictions',
    description:
      'Asks the backend model whether the intake’s free-text answers contradict the structured answers (passed as context). ' +
      'Best effort: always answers `{ findings, error? }`, and an error means proceed. Call before saving a profile edited in free text.',
    method: 'POST',
    path: '/api/projects/[id]/consistency-check',
    params: projectParams,
    body: consistencyCheckSchema,
    readOnly: true,
    load: () => import('@/app/api/projects/[id]/consistency-check/route'),
  },
  {
    name: 'project-summary-generate',
    domain: 'projects',
    summary: 'Write the project’s AI summary',
    description:
      'Generates the profile summary with the backend model and stores it on the profile, replacing the earlier one. Needs project:edit. ' +
      'Answers the summary. Optionally pass `locale` ("de" or "en").',
    method: 'POST',
    path: '/api/projects/[id]/generate-summary',
    params: projectParams,
    body: generateSummaryRequestSchema,
    idempotent: true,
    load: () => import('@/app/api/projects/[id]/generate-summary/route'),
  },
] as const satisfies readonly AgentOperation[]
