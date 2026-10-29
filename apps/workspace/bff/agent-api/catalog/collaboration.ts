/**
 * The collaboration operations (ADR-0122): inbox, push notifications, sharing
 * state, assignments, mentions, proposed changes, Piloti's changes, the
 * person's preferences and the files attached to a chat.
 * See `projects.ts` for the shape and `docs/architecture/agent-surface.md` for
 * the rules.
 *
 * Changing who may see a resource (visibility, grants, revoking, taking
 * ownership under `/api/sharing/.../grants`) is here too, as `sensitivity:
 * 'access'`: an outside agent sees it only under the organization's opt-in and
 * the step-up scope (`SENSITIVE_SCOPE_ENFORCED_BY_WORKOS`, off until WorkOS
 * enforces it, so today no agent sees it), and Piloti never does. Also left out: registering a
 * browser for push (`POST /api/notifications/push/devices`, `GET .../config`),
 * which needs a browser push subscription, and the multipart session-document
 * upload.
 */

import { z } from 'zod'
import {
  assignmentBodySchema,
  assignmentCandidatesQuerySchema,
  assignmentDeleteQuerySchema,
} from '@/lib/assignments/assignment-wire'
import {
  inboxListQuerySchema,
  markReadSchema,
  markUnreadSchema,
  unreadAnchorsQuerySchema,
} from '@/lib/inbox/inbox-wire'
import { pushPreferencesPatchSchema } from '@/lib/inbox/push-categories'
import { grantPostSchema, roleChangeSchema, visibilitySchema } from '@/lib/sharing/sharing-wire'
import { SHAREABLE_RESOURCE_TYPES } from '@/lib/sharing/sharing-vocabulary'
import { applyProposalRequestSchema, proposalListQueryShape } from '@/lib/proposals/types'
import { listSessionDocumentsQuerySchema } from '@/lib/session-documents/session-documents-wire'
import { updatePreferencesSchema } from '@/lib/user-preferences/preferences-wire'
import type { AgentOperation } from '../operation'
import { PRODUCT_NAME } from '@/lib/brand'

const resourceParams = z.object({
  resourceType: z.enum(SHAREABLE_RESOURCE_TYPES).describe('The kind of shareable resource.'),
  resourceId: z.string().describe('The id of that resource, from its list operation.'),
})

const inboxItemParams = z.object({ id: z.string().describe('The inbox item id (a UUID), from inbox-list.') })

const conversationParams = z.object({
  id: z.string().describe('The conversation id, from conversation-list.'),
})

const proposalParams = z.object({
  id: z.string().describe('The proposed change id, from proposal-list or the answer’s card.'),
})

export const collaborationOperations = [
  // Inbox
  {
    name: 'inbox-list',
    domain: 'collaboration',
    summary: 'List the person’s inbox',
    description:
      'The person’s own inbox, newest first. `filter`: `requests` (waits on them), `unread`, `pending` (unread OR open request), ' +
      '`archived`, `all` (default); `type` and `projectId` narrow it. Page with `nextCursor`. An `upload.completed` ' +
      'item of a project upload carries `uploadReport`: documents read by document type, new findings (read them ' +
      'with project-document-findings), references the project cannot resolve and pages not read in full.',
    method: 'GET',
    path: '/api/inbox',
    query: inboxListQuerySchema,
    spansProjects: 'always',
    load: () => import('@/app/api/inbox/route'),
  },
  {
    name: 'inbox-summary-get',
    domain: 'collaboration',
    summary: 'Read the inbox badge count',
    description: 'Only the number of items waiting on the person, as the inbox badge shows it. Cheaper than inbox-list.',
    method: 'GET',
    path: '/api/inbox/summary',
    load: () => import('@/app/api/inbox/summary/route'),
  },
  {
    name: 'inbox-unread-anchor-list',
    domain: 'collaboration',
    summary: 'List unread annotations inside a document',
    description:
      'The ids of the annotations (anchors) in one document whose news the person has not read, as `{ anchorIds }`. ' +
      'resourceId is a document id from document-list. Opening an annotation’s thread clears it (inbox-item-mark-read).',
    method: 'GET',
    path: '/api/inbox/unread-anchors',
    query: unreadAnchorsQuerySchema,
    load: () => import('@/app/api/inbox/unread-anchors/route'),
  },
  {
    name: 'inbox-item-mark-read',
    domain: 'collaboration',
    summary: 'Mark inbox items read',
    description:
      'Marks read by `itemIds` (from inbox-list), or everything with `{ all: true }`, or the news on one document ' +
      'annotation (`resourceType`, `resourceId`, `anchorId`), or the “new annotations” rows of a document (`marksSet: true`). ' +
      'Returns the recomputed badge count.',
    method: 'POST',
    path: '/api/inbox/read',
    body: markReadSchema,
    idempotent: true,
    load: () => import('@/app/api/inbox/read/route'),
  },
  {
    name: 'inbox-item-mark-unread',
    domain: 'collaboration',
    summary: 'Mark inbox items unread again',
    description: 'The inverse of inbox-item-mark-read for `itemIds` from inbox-list. Returns the recomputed badge count.',
    method: 'POST',
    path: '/api/inbox/unread',
    body: markUnreadSchema,
    idempotent: true,
    load: () => import('@/app/api/inbox/unread/route'),
  },
  {
    name: 'inbox-item-archive',
    domain: 'collaboration',
    summary: 'Archive an inbox item',
    description:
      'Puts one inbox item (id from inbox-list) away. The row survives and can be brought back with ' +
      'inbox-item-restore.',
    method: 'POST',
    path: '/api/inbox/[id]/archive',
    params: inboxItemParams,
    idempotent: true,
    load: () => import('@/app/api/inbox/[id]/archive/route'),
  },
  {
    name: 'inbox-item-restore',
    domain: 'collaboration',
    summary: 'Take an inbox item out of the archive',
    description: 'Brings an archived inbox item (id from inbox-list with filter `archived`) back into the inbox.',
    method: 'DELETE',
    path: '/api/inbox/[id]/archive',
    params: inboxItemParams,
    destructive: false,
    load: () => import('@/app/api/inbox/[id]/archive/route'),
  },

  // Push notifications
  {
    name: 'push-device-list',
    domain: 'collaboration',
    summary: 'List the devices that receive push notifications',
    description: 'The person’s own registered browsers and devices. Ids feed push-device-remove.',
    method: 'GET',
    path: '/api/notifications/push/devices',
    load: () => import('@/app/api/notifications/push/devices/route'),
  },
  {
    name: 'push-device-remove',
    domain: 'collaboration',
    summary: 'Stop push notifications to one device',
    description: 'Removes one of the person’s own devices (id from push-device-list). It receives no more pushes.',
    method: 'DELETE',
    path: '/api/notifications/push/devices/[id]',
    params: z.object({ id: z.string().describe('The device id (a UUID), from push-device-list.') }),
    load: () => import('@/app/api/notifications/push/devices/[id]/route'),
  },
  {
    name: 'push-preference-get',
    domain: 'collaboration',
    summary: 'Read the push notification preferences',
    description:
      'What the person wants pushed (categories requests, results, access, activity, office) and whether the lock screen shows content.',
    method: 'GET',
    path: '/api/notifications/push/preferences',
    load: () => import('@/app/api/notifications/push/preferences/route'),
  },
  {
    name: 'push-preference-update',
    domain: 'collaboration',
    summary: 'Change the push notification preferences',
    description:
      'Sets `showContent` and/or any of the `categories` booleans; fields left out stay as they are. Returns the ' +
      'resolved preferences.',
    method: 'PUT',
    path: '/api/notifications/push/preferences',
    body: pushPreferencesPatchSchema,
    load: () => import('@/app/api/notifications/push/preferences/route'),
  },

  // Sharing
  {
    name: 'sharing-get',
    domain: 'collaboration',
    summary: 'Read who has access to a resource',
    description:
      'Who has access to a conversation or document: visibility, the people with a grant and their roles, and the person’s own role.',
    method: 'GET',
    path: '/api/sharing/[resourceType]/[resourceId]',
    params: resourceParams,
    load: () => import('@/app/api/sharing/[resourceType]/[resourceId]/route'),
  },
  {
    name: 'sharing-candidate-list',
    domain: 'collaboration',
    summary: 'List who could be invited to a resource',
    description:
      'Members who may be invited to the resource; `needsProjectAccess` flags those who would first need to join the project. Owner only.',
    method: 'GET',
    path: '/api/sharing/[resourceType]/[resourceId]/candidates',
    params: resourceParams,
    load: () => import('@/app/api/sharing/[resourceType]/[resourceId]/candidates/route'),
  },
  {
    name: 'sharing-visibility-set',
    domain: 'collaboration',
    summary: 'Set who beyond the invited people may see a resource',
    description:
      'Sets the resource’s `visibility`: `private` (only the people with a grant), `project` (every member of its project) or ' +
      '`organization` (every member). Only the resource owner may change it. Returns the sharing state as sharing-get does. ' +
      'Sensitive: the organization switches it on for agents, and the person confirms every call.',
    method: 'PATCH',
    path: '/api/sharing/[resourceType]/[resourceId]',
    params: resourceParams,
    body: visibilitySchema,
    idempotent: true,
    sensitivity: 'access',
    load: () => import('@/app/api/sharing/[resourceType]/[resourceId]/route'),
  },
  {
    name: 'sharing-grant-add',
    domain: 'collaboration',
    summary: 'Give a person access to a resource',
    description:
      'Grants `subjectUserId` a `role` on the resource: `viewer`, `collaborator` (the default) or `owner`. User ids come from ' +
      'sharing-candidate-list. Only the resource owner may grant. `{ escalate: true }` instead makes a project administrator ' +
      'the owner of a resource they were not party to, recorded as its own act. Returns the sharing state. ' +
      'Sensitive: the organization switches it on for agents, and the person confirms every call.',
    method: 'POST',
    path: '/api/sharing/[resourceType]/[resourceId]/grants',
    params: resourceParams,
    body: grantPostSchema,
    idempotent: false,
    sensitivity: 'access',
    load: () => import('@/app/api/sharing/[resourceType]/[resourceId]/grants/route'),
  },
  {
    name: 'sharing-grant-update',
    domain: 'collaboration',
    summary: 'Change a person’s role on a resource',
    description:
      'Sets the `role` (`viewer`, `collaborator`, `owner`) of a person who already has a grant, named by `subjectUserId` as ' +
      'sharing-get lists them. Only the resource owner may change it, and the last owner cannot step down. Returns the ' +
      'sharing state. Sensitive: the organization switches it on for agents, and the person confirms every call.',
    method: 'PATCH',
    path: '/api/sharing/[resourceType]/[resourceId]/grants',
    params: resourceParams,
    body: roleChangeSchema,
    idempotent: true,
    sensitivity: 'access',
    load: () => import('@/app/api/sharing/[resourceType]/[resourceId]/grants/route'),
  },
  {
    name: 'sharing-grant-revoke',
    domain: 'collaboration',
    summary: 'Take away a person’s access to a resource',
    description:
      'Removes the grant of `subjectUserId`, as sharing-get lists them. Naming the person themselves leaves the resource, ' +
      'which needs no ownership; removing somebody else needs the owner. Returns the sharing state. ' +
      'Sensitive: the organization switches it on for agents, and the person confirms every call.',
    method: 'DELETE',
    path: '/api/sharing/[resourceType]/[resourceId]/grants/[subjectUserId]',
    params: resourceParams.extend({
      subjectUserId: z.string().describe('The user id of the person whose grant ends, from sharing-get.'),
    }),
    sensitivity: 'access',
    load: () => import('@/app/api/sharing/[resourceType]/[resourceId]/grants/[subjectUserId]/route'),
  },

  // Assignments
  {
    name: 'assignment-list',
    domain: 'collaboration',
    summary: 'List who a resource is assigned to',
    description: 'The people currently assigned to a shareable resource, as `{ assignees }`.',
    method: 'GET',
    path: '/api/assignments/[resourceType]/[resourceId]',
    params: resourceParams,
    load: () => import('@/app/api/assignments/[resourceType]/[resourceId]/route'),
  },
  {
    name: 'assignment-candidate-list',
    domain: 'collaboration',
    summary: 'List who can be assigned to a resource',
    description:
      'Project members who may be assigned; `access: write` (documents) keeps those who may change the document. Ids feed assignment-add.',
    method: 'GET',
    path: '/api/assignments/[resourceType]/[resourceId]/candidates',
    params: resourceParams,
    query: assignmentCandidatesQuerySchema,
    load: () => import('@/app/api/assignments/[resourceType]/[resourceId]/candidates/route'),
  },
  {
    name: 'assignment-add',
    domain: 'collaboration',
    summary: 'Assign a person to a resource',
    description:
      'Assigns a person (`userId` from assignment-candidate-list); assignment is not access. Needs the collaborator role. Returns the assignees.',
    method: 'POST',
    path: '/api/assignments/[resourceType]/[resourceId]',
    params: resourceParams,
    body: assignmentBodySchema,
    idempotent: true,
    load: () => import('@/app/api/assignments/[resourceType]/[resourceId]/route'),
  },
  {
    name: 'assignment-remove',
    domain: 'collaboration',
    summary: 'Release a person from a resource',
    description: 'Removes the assignment of `userId` (from assignment-list). Returns the updated assignees.',
    method: 'DELETE',
    path: '/api/assignments/[resourceType]/[resourceId]',
    params: resourceParams,
    query: assignmentDeleteQuerySchema,
    load: () => import('@/app/api/assignments/[resourceType]/[resourceId]/route'),
  },

  // Mentions and hand-offs
  {
    name: 'conversation-awaiting-get',
    domain: 'collaboration',
    summary: 'See whom a conversation is waiting on',
    description:
      'The open mention requests on a conversation, where it waits for a colleague. Ids feed mention-request-release.',
    method: 'GET',
    path: '/api/conversations/[id]/awaiting',
    params: conversationParams,
    load: () => import('@/app/api/conversations/[id]/awaiting/route'),
  },
  {
    name: 'conversation-mention-candidate-list',
    domain: 'collaboration',
    summary: 'List who can be mentioned in a conversation',
    description:
      'Who a message here may mention (people and ' + PRODUCT_NAME + '). Use these `targetId` values in conversation-message-add, never typed names.',
    method: 'GET',
    path: '/api/conversations/[id]/mention-candidates',
    params: conversationParams,
    load: () => import('@/app/api/conversations/[id]/mention-candidates/route'),
  },
  {
    name: 'mention-request-release',
    domain: 'collaboration',
    summary: 'Carry on without the person a thread waits on',
    description:
      'Releases an open hand-off (id from conversation-awaiting-get) so the thread stops waiting. Any contributor may. The colleague’s inbox item is settled.',
    method: 'POST',
    path: '/api/mentions/[requestId]/release',
    params: z.object({
      requestId: z.string().describe('The mention request id, from conversation-awaiting-get.'),
    }),
    destructive: true,
    load: () => import('@/app/api/mentions/[requestId]/release/route'),
  },

  // Proposed changes and Piloti's changes
  {
    name: 'proposal-list',
    domain: 'collaboration',
    summary: 'List open proposed changes on a shelf',
    description:
      PRODUCT_NAME + '’s open proposals (file operations, notes, profile changes) with the documents they name, newest first. Give ' +
      '`projectId` (from project-list) or `shelf`, and optionally `kind`. Page with `nextCursor`. Ids feed proposal-get; the person decides each.',
    method: 'GET',
    path: '/api/proposals',
    // The route's `proposalListQuerySchema` adds the refinement (a project or a shelf, never both), which is
    // not a ZodObject; the route is the gate.
    query: proposalListQueryShape,
    spansProjects: 'unlessScoped',
    load: () => import('@/app/api/proposals/route'),
  },
  {
    name: 'proposal-get',
    domain: 'collaboration',
    summary: 'Read one proposed change',
    description: 'One proposal as the person may see it, with `canDecide` telling whether they may apply or dismiss it.',
    method: 'GET',
    path: '/api/proposals/[id]',
    params: proposalParams,
    load: () => import('@/app/api/proposals/[id]/route')
  },
  {
    name: 'proposal-apply',
    domain: 'collaboration',
    summary: 'Apply a proposed change',
    description:
      'Carries out a still `proposed` proposal as the person (409 otherwise); returns it with its `results`. Body optional: ' +
      '`memoryScope: project` keeps a note on the project. Needs the right its kind requires.',
    method: 'POST',
    path: '/api/proposals/[id]/apply',
    params: proposalParams,
    body: applyProposalRequestSchema,
    personDecides: true,
    load: () => import('@/app/api/proposals/[id]/apply/route'),
  },
  {
    name: 'proposal-dismiss',
    domain: 'collaboration',
    summary: 'Dismiss a proposed change',
    description: 'Rejects a proposal that is still `proposed` (409 otherwise). Nothing is changed in the workspace.',
    method: 'POST',
    path: '/api/proposals/[id]/dismiss',
    params: proposalParams,
    personDecides: true,
    load: () => import('@/app/api/proposals/[id]/dismiss/route'),
  },
  {
    name: 'agent-change-undo',
    domain: 'collaboration',
    summary: 'Undo a change ' + PRODUCT_NAME + ' made',
    description:
      'Reverses one change ' + PRODUCT_NAME + ' applied (id from conversation-message-changes); 409 `moved-on` if the object changed since, or `already-undone`. Runs with the person’s rights.',
    method: 'POST',
    path: '/api/piloti-changes/[id]/undo',
    params: z.object({ id: z.string().describe('The change id (a UUID), from conversation-message-changes.') }),
    load: () => import('@/app/api/piloti-changes/[id]/undo/route'),
  },

  // Preferences
  {
    name: 'user-preference-get',
    domain: 'collaboration',
    summary: 'Read the person’s preferences',
    description: 'The person’s own preference bag (language, active project and other UI settings) as `{ prefs }`.',
    method: 'GET',
    path: '/api/user/preferences',
    load: () => import('@/app/api/user/preferences/route'),
  },
  {
    name: 'user-preference-update',
    domain: 'collaboration',
    summary: 'Change the person’s preferences',
    description:
      'Merges `prefs` into the person’s preference bag; keys not named stay. Setting `locale` also switches the ' +
      'interface language. Returns the merged `{ prefs }`.',
    method: 'POST',
    path: '/api/user/preferences',
    body: updatePreferencesSchema,
    idempotent: true,
    load: () => import('@/app/api/user/preferences/route'),
  },

  // Files attached to a chat
  {
    name: 'session-document-list',
    domain: 'collaboration',
    summary: 'List the files attached to a conversation',
    description:
      'The documents attached privately to one conversation (conversationId from conversation-list).',
    method: 'GET',
    path: '/api/session/documents',
    query: listSessionDocumentsQuerySchema,
    load: () => import('@/app/api/session/documents/route'),
  },
  {
    name: 'session-document-delete',
    domain: 'collaboration',
    summary: 'Remove a file attached to a conversation',
    description:
      'Deletes one chat attachment (id from session-document-list) permanently. Needs the collaborator role on the conversation.',
    method: 'DELETE',
    path: '/api/session/documents/[id]',
    params: z.object({ id: z.string().describe('The attachment’s document id, from session-document-list.') }),
    load: () => import('@/app/api/session/documents/[id]/route'),
  },
] as const satisfies readonly AgentOperation[]
