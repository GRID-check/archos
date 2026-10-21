/**
 * The conversations operations (ADR-0121): threads with Piloti and colleagues,
 * the messages in them, answer feedback, citations and similar passages.
 * See `projects.ts` for the shape and `docs/architecture/agent-surface.md` for
 * the rules.
 *
 * Sending a question to Piloti is not here: a turn runs over the chat
 * WebSocket, not a route. `conversation-message-add` stores a message in the
 * thread (and notifies the people it mentions) without opening a turn.
 *
 * Left uncatalogued on purpose (browser plumbing): `GET /live` (a server-sent
 * event stream), `GET /frames` (the socket-resume peek), `POST /stopped` (cuts
 * an answer to what the Stop button showed); `GET /export` is a binary download.
 */

import { z } from 'zod'
import { formatCitationsSchema } from '@/lib/citations/citation-wire'
import {
  createConversationSchema,
  createMessagesSchema,
  draftPreviewQuerySchema,
  fileDraftBodySchema,
  generateTitleSchema,
  listConversationsQuerySchema,
  markReadSchema,
  updateConversationSchema,
  updateMessageSchema,
} from '@/lib/conversations/conversation-wire'
import {
  conversationFeedbackQuerySchema,
  retractAnswerFeedbackQuerySchema,
  upsertAnswerFeedbackSchema,
} from '@/lib/feedback/types'
import { submitProductFeedbackSchema } from '@/lib/product-feedback/types'
import { similarPassagesRequestSchema } from '@/lib/similar-passages/types'
import type { AgentOperation } from '../operation'

const conversationParams = z.object({
  id: z.string().describe('The conversation id (`s_` plus a UUID with underscores), from conversation-list.'),
})

const messageParams = z.object({
  id: z.string().describe('The conversation id, from conversation-list.'),
  messageId: z.string().describe('The message id (a UUID), from conversation-message-list.'),
})

export const conversationsOperations: readonly AgentOperation[] = [
  {
    name: 'conversation-list',
    domain: 'conversations',
    summary: 'List the conversations the person can see',
    description:
      'Every conversation the person may open, their own and those shared with them, newest first, with id, title, ' +
      'project and unread state. Pass projectId to narrow to one project (ids from project-list). ' +
      'Take a conversation id from here for conversation-get and conversation-message-list.',
    method: 'GET',
    path: '/api/conversations',
    query: listConversationsQuerySchema,
    spansProjects: 'unlessScoped',
    load: () => import('@/app/api/conversations/route'),
  },
  {
    name: 'conversation-create',
    domain: 'conversations',
    summary: 'Start a new conversation',
    description:
      'Creates an empty private conversation, optionally inside a project (projectId from project-list) or about one ' +
      'document. You choose the id: `s_` followed by a UUID with underscores for the hyphens. Returns the conversation. ' +
      'Share it deliberately afterwards (sharing-get shows who has access).',
    method: 'POST',
    path: '/api/conversations',
    body: createConversationSchema,
    load: () => import('@/app/api/conversations/route'),
  },
  {
    name: 'conversation-get',
    domain: 'conversations',
    summary: 'Read one conversation',
    description:
      'One conversation by id: title, project, visibility, engagement mode (when Piloti answers) and the person’s ' +
      'role in it. Messages come from conversation-message-list.',
    method: 'GET',
    path: '/api/conversations/[id]',
    params: conversationParams,
    load: () => import('@/app/api/conversations/[id]/route'),
  },
  {
    name: 'conversation-update',
    domain: 'conversations',
    summary: 'Rename a conversation or change when Piloti answers',
    description:
      'Set a new `title` (needs the owner role) and/or the `engagement` mode that decides when Piloti answers ' +
      '(needs the collaborator role). Provide at least one of the two. Returns the updated conversation.',
    method: 'PATCH',
    path: '/api/conversations/[id]',
    params: conversationParams,
    body: updateConversationSchema,
    idempotent: true,
    load: () => import('@/app/api/conversations/[id]/route'),
  },
  {
    name: 'conversation-delete',
    domain: 'conversations',
    summary: 'Delete a conversation',
    description:
      'Deletes a conversation and its messages for everyone in it. This cannot be undone. The answer is the same ' +
      'whether or not the id existed or was the person’s, so it never reveals which ids are real.',
    method: 'DELETE',
    path: '/api/conversations/[id]',
    params: conversationParams,
    load: () => import('@/app/api/conversations/[id]/route'),
  },
  {
    name: 'conversation-message-list',
    domain: 'conversations',
    summary: 'Read the messages of a conversation',
    description:
      'The whole history of a conversation, oldest first: each message with id, role, content, structured mentions ' +
      'and the answer details Piloti stored. Message ids from here feed conversation-message-changes.',
    method: 'GET',
    path: '/api/conversations/[id]/messages',
    params: conversationParams,
    load: () => import('@/app/api/conversations/[id]/messages/route'),
  },
  {
    name: 'conversation-message-add',
    domain: 'conversations',
    summary: 'Store a message in a conversation',
    description:
      'Appends one message, or an array of up to the per-request limit, to a thread the person may write in. ' +
      'You supply each message id. Use `mentions` (user ids from conversation-mention-candidate-list) to address ' +
      'colleagues; they get an inbox item. This stores the message only: it does not open a turn with Piloti, which ' +
      'runs over the chat WebSocket. Returns the stored rows with the addressee ruling.',
    method: 'POST',
    path: '/api/conversations/[id]/messages',
    params: conversationParams,
    body: createMessagesSchema,
    load: () => import('@/app/api/conversations/[id]/messages/route'),
  },
  {
    name: 'conversation-message-update',
    domain: 'conversations',
    summary: 'Record a card decision or details on an answer',
    description:
      'Saves the person’s decisions on an answer’s interactive cards (`cardInteractions`, keyed like ' +
      '`memory_proposal-0`) and the answer’s own details (`provenance`, `promptState`, `stages`). Provide at least ' +
      'one field. The service whitelists the free-form parts; to act on a proposal use proposal-apply instead.',
    method: 'PATCH',
    path: '/api/conversations/[id]/messages/[messageId]',
    params: messageParams,
    body: updateMessageSchema,
    idempotent: true,
    load: () => import('@/app/api/conversations/[id]/messages/[messageId]/route'),
  },
  {
    name: 'conversation-message-changes',
    domain: 'conversations',
    summary: 'List what one answer changed',
    description:
      'The changes Piloti made while producing one answer, each as it stands now, with `canUndo`. Changes on ' +
      'documents the person may not see are left out. Pass a change id to piloti-change-undo to reverse it.',
    method: 'GET',
    path: '/api/conversations/[id]/messages/[messageId]/changes',
    params: messageParams,
    load: () => import('@/app/api/conversations/[id]/messages/[messageId]/changes/route'),
  },
  {
    name: 'conversation-message-usage',
    domain: 'conversations',
    withheld: { category: 'product-config', reason: 'what one Piloti answer cost; billing, not office work' },
    summary: 'Read what one answer cost',
    description:
      'The credits billed for one answer (or tokens, on the organization’s own key) with the token split. ' +
      'Returns `{ usage: null }` when no ledger row names the answer.',
    method: 'GET',
    path: '/api/conversations/[id]/messages/[messageId]/usage',
    params: messageParams,
    load: () => import('@/app/api/conversations/[id]/messages/[messageId]/usage/route'),
  },
  {
    name: 'conversation-read-mark',
    domain: 'conversations',
    withheld: { category: 'ui-state', reason: 'what the person has seen; an agent marking it read hides news from them' },
    summary: 'Mark a conversation read',
    description:
      'Moves the person’s read marker to now, or to `lastReadMessageId`, and clears the thread’s inbox items. ' +
      'Read state is per person. Send an empty object to mark everything read.',
    method: 'POST',
    path: '/api/conversations/[id]/read',
    params: conversationParams,
    body: markReadSchema,
    idempotent: true,
    load: () => import('@/app/api/conversations/[id]/read/route'),
  },
  {
    name: 'conversation-title-generate',
    domain: 'conversations',
    withheld: {
      category: 'model-compute',
      reason: 'a model names the conversation; the caller can name it and save it with conversation-update',
    },
    summary: 'Let Piloti name a conversation',
    description:
      'Generates a short title and topic tags from the opening exchange (up to 20 messages with role and content) ' +
      'and saves them on the conversation. Pass `locale` for the title’s language. Returns the stored title.',
    method: 'POST',
    path: '/api/conversations/[id]/generate-title',
    params: conversationParams,
    body: generateTitleSchema,
    load: () => import('@/app/api/conversations/[id]/generate-title/route'),
  },
  {
    name: 'conversation-draft-get',
    domain: 'conversations',
    summary: 'Read an unfiled draft Piloti wrote',
    description:
      'The content of one draft in the conversation’s working directory, so it can be read before filing. ' +
      '`path` is the draft path the answer’s card names (such as `/entwuerfe/….md`). Read-only. ' +
      'To keep it, call conversation-draft-file.',
    method: 'GET',
    path: '/api/conversations/[id]/draft',
    params: conversationParams,
    query: draftPreviewQuerySchema,
    load: () => import('@/app/api/conversations/[id]/draft/route'),
  },
  {
    name: 'conversation-draft-file',
    domain: 'conversations',
    summary: 'File an unfiled draft into the project',
    description:
      'Files the content of a draft (path from the answer’s card or conversation-draft-get) as a document in the ' +
      'conversation’s project, as the person. A same-name collision answers 409 with the existing document; ' +
      'repeat with `force: true` only after the person confirmed filing anyway. Returns the filed document.',
    method: 'POST',
    path: '/api/conversations/[id]/draft/file',
    params: conversationParams,
    body: fileDraftBodySchema,
    load: () => import('@/app/api/conversations/[id]/draft/file/route'),
  },
  {
    name: 'answer-feedback-list',
    domain: 'conversations',
    summary: 'Read the person’s votes in a conversation',
    description:
      'The thumbs-up and thumbs-down votes the person has given to answers in one conversation (conversationId ' +
      'from conversation-list). Only their own votes are returned.',
    method: 'GET',
    path: '/api/feedback/answers',
    query: conversationFeedbackQuerySchema,
    load: () => import('@/app/api/feedback/answers/route'),
  },
  {
    name: 'answer-feedback-submit',
    domain: 'conversations',
    summary: 'Vote on an answer',
    description:
      'Records a verdict on one answer (messageId from conversation-message-list). Voting again replaces the ' +
      'earlier vote. A down-vote feeds Piloti’s failure learning, so add the reason when the answer was wrong.',
    method: 'POST',
    path: '/api/feedback/answers',
    body: upsertAnswerFeedbackSchema,
    idempotent: true,
    load: () => import('@/app/api/feedback/answers/route'),
  },
  {
    name: 'answer-feedback-retract',
    domain: 'conversations',
    summary: 'Take back a vote on an answer',
    description:
      'Removes the person’s vote on one answer (messageId from answer-feedback-list). Nothing happens if there ' +
      'is no vote.',
    method: 'DELETE',
    path: '/api/feedback/answers',
    query: retractAnswerFeedbackQuerySchema,
    destructive: false,
    load: () => import('@/app/api/feedback/answers/route'),
  },
  {
    name: 'feedback-report-submit',
    domain: 'conversations',
    summary: 'Send product feedback to the Piloti team',
    description:
      'Sends a bug report, idea, praise or question to the platform owners (`kind` and `message`, plus the ' +
      '`pagePath` it concerns). Opens a support ticket. This is not an answer vote: use answer-feedback-submit ' +
      'for that. Rate limited per person.',
    method: 'POST',
    path: '/api/feedback/reports',
    body: submitProductFeedbackSchema,
    load: () => import('@/app/api/feedback/reports/route'),
  },
  {
    name: 'citation-format',
    domain: 'conversations',
    withheld: {
      category: 'model-compute',
      reason: 'formats the sources it is sent as APA, BibTeX or RIS; any agent can do that itself',
    },
    summary: 'Format sources as APA, BibTeX or RIS',
    description:
      'Renders CSL-JSON `items` (the sources of an answer, up to 64) as an APA bibliography, BibTeX or RIS text. ' +
      'Pure formatting: nothing is read or stored. Returns `{ text }`.',
    method: 'POST',
    path: '/api/citations/format',
    body: formatCitationsSchema,
    readOnly: true,
    load: () => import('@/app/api/citations/format/route'),
  },
  {
    name: 'passage-similar-search',
    domain: 'conversations',
    summary: 'Find passages like one in the office’s documents',
    description:
      'Given a passage the person is reading (its document by id or by legal-corpus file name, and its text), ' +
      'finds similar passages across the projects and documents they may read, grouped project, document, passage. ' +
      'Read-only. Use it to see how the office handled the same question before.',
    method: 'POST',
    path: '/api/passages/similar',
    body: similarPassagesRequestSchema,
    readOnly: true,
    spansProjects: 'always',
    load: () => import('@/app/api/passages/similar/route'),
  },
  {
    name: 'conversation-message-export',
    domain: 'conversations',
    summary: 'Export one saved answer as a Word document',
    description:
      'One answer of a conversation as a .docx, built from the stored message with its sources. Returned as an attached ' +
      'resource (base64 `blob`) up to 5 MiB. Needs access to the conversation. Message ids come from conversation-message-list; ' +
      'only an answer from Piloti can be exported.',
    method: 'GET',
    path: '/api/conversations/[id]/messages/[messageId]/export',
    params: messageParams,
    binaryResponse: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    load: () => import('@/app/api/conversations/[id]/messages/[messageId]/export/route'),
  },

]
