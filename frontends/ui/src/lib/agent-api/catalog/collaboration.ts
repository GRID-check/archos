/**
 * The collaboration operations (ADR-0121): inbox, push notifications, sharing
 * state, assignments, mentions, proposed changes, Piloti's changes, the
 * person's preferences and the files attached to a chat.
 * See `projects.ts` for the shape and `docs/architecture/agent-surface.md` for
 * the rules.
 *
 * Deliberately NOT here: changing who may see a resource (visibility, grants,
 * revoking, taking ownership under `/api/sharing/.../grants`). Those stay with
 * the person. Reading sharing state is here. Also left out: registering a
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
import { applyProposalRequestSchema, PROPOSAL_SCOPES, PROPOSED_CHANGE_KINDS } from '@/lib/proposals/types'
import { listSessionDocumentsQuerySchema } from '@/lib/session-documents/session-documents-wire'
import { updatePreferencesSchema } from '@/lib/user-preferences/preferences-wire'
import type { AgentOperation } from '../operation'

const resourceParams = z.object({
  resourceType: z
    .string()
    .describe('The kind of shareable resource, such as `conversation` or `document`, as the resource’s own operations name it.'),
  resourceId: z.string().describe('The id of that resource, from its list operation.'),
})

const inboxItemParams = z.object({ id: z.string().describe('The inbox item id (a UUID), from inbox-list.') })

const conversationParams = z.object({
  id: z.string().describe('The conversation id, from conversation-list.'),
})

const proposalListQuery = z.object({
  projectId: z.string().uuid().optional().describe('The project whose open proposals to list, from project-list.'),
  shelf: z.enum(PROPOSAL_SCOPES).optional().describe('`office_shelf` for the office shelf instead of a project.'),
  kind: z.enum(PROPOSED_CHANGE_KINDS).optional(),
})

const proposalParams = z.object({
  id: z.string().describe('The proposed change id, from proposal-list or the answer’s card.'),
})

export const collaborationOperations: readonly AgentOperation[] = [
  // Inbox
  {
    name: 'inbox-list',
    domain: 'collaboration',
    summary: 'List the person’s inbox',
    description:
      'One page of the person’s own inbox. `filter` picks the slice: `requests` waits on them, `unread`, `all` ' +
      '(everything unarchived, the default), `archived`, `pending`. Pass the previous page’s `nextCursor` as ' +
      '`cursor` for the next page. Item ids feed the inbox-item-* operations.',
    method: 'GET',
    path: '/api/inbox',
    query: inboxListQuerySchema,
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
    summary: 'List unread marks inside a document',
    description:
      'The ids of the marks (anchors) in one document whose news the person has not read, as `{ anchorIds }`. ' +
      'resourceId is a document id from document-list. Opening a mark’s thread clears it (inbox-item-mark-read).',
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
      'mark (`resourceType`, `resourceId`, `anchorId`), or the “new marks” rows of a document (`marksSet: true`). ' +
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
      'What the person wants pushed (the categories requests, results, access, activity, office) and whether the ' +
      'lock screen shows content. Defaults are filled in.',
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

  // Sharing (read only)
  {
    name: 'sharing-get',
    domain: 'collaboration',
    summary: 'Read who has access to a resource',
    description:
      'The sharing state of a conversation or other shareable resource: its visibility, the people with a grant ' +
      'and their roles, and the person’s own role. Changing access is not offered to agents.',
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
      'Organization members who may be invited to the resource, plus those flagged `needsProjectAccess` because ' +
      'they would first need to join the project. Only the resource owner may read it.',
    method: 'GET',
    path: '/api/sharing/[resourceType]/[resourceId]/candidates',
    params: resourceParams,
    load: () => import('@/app/api/sharing/[resourceType]/[resourceId]/candidates/route'),
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
      'Project members who may be assigned. With `access: write` (documents only) only people who may change the ' +
      'document, which is who an annotation may be handed to. User ids from here feed assignment-add.',
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
      'Puts a person (`userId` from assignment-candidate-list) on the hook for the resource. Assignment is not ' +
      'access. Needs the collaborator role. Returns the updated assignees.',
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
      'The open mention requests on a conversation: the hand-offs where the thread waits for a colleague. ' +
      'Request ids feed mention-request-release.',
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
      'The people (and Piloti) a message in this conversation may mention. Mentions are structured: use the ' +
      '`targetId` values from here in conversation-message-add, never a name typed in text.',
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
      'Releases an open hand-off (request id from conversation-awaiting-get) so the thread no longer waits. Any ' +
      'contributor may do it. The mentioned colleague’s inbox item is settled.',
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
      'Piloti’s open proposals (file operations, notes, profile changes) with the documents they name. Give ' +
      '`projectId` (from project-list) for a project, or `shelf: office_shelf` for the office shelf, and ' +
      'optionally `kind`. Ids feed proposal-get, proposal-apply and proposal-dismiss.',
    method: 'GET',
    path: '/api/proposals',
    // Looser than the route's `proposalListQuerySchema` (a refined schema is not a ZodObject): the route is the
    // gate and still demands a project, or shelf=office_shelf.
    query: proposalListQuery,
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
      'Carries out a proposal that is still `proposed` as the person (409 otherwise) and returns it with its ' +
      '`results`. The body is optional; `memoryScope: project` keeps a proposed note on the project. Needs the ' +
      'right the proposal’s kind requires. Reverse it with piloti-change-undo where the result allows.',
    method: 'POST',
    path: '/api/proposals/[id]/apply',
    params: proposalParams,
    body: applyProposalRequestSchema,
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
    load: () => import('@/app/api/proposals/[id]/dismiss/route'),
  },
  {
    name: 'piloti-change-undo',
    domain: 'collaboration',
    summary: 'Undo a change Piloti made',
    description:
      'Reverses one change Piloti applied (id from conversation-message-changes). Answers 409 with `moved-on` if ' +
      'the object has changed since, or `already-undone`. The inverse runs with the person’s own rights.',
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
      'The documents attached privately to one conversation (conversationId from conversation-list). Read, ' +
      'preview or download them through the document operations.',
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
      'Deletes one chat attachment (id from session-document-list) with its retrieval chunks and stored copies. ' +
      'This cannot be undone. Needs the collaborator role on the conversation.',
    method: 'DELETE',
    path: '/api/session/documents/[id]',
    params: z.object({ id: z.string().describe('The attachment’s document id, from session-document-list.') }),
    load: () => import('@/app/api/session/documents/[id]/route'),
  },
]
