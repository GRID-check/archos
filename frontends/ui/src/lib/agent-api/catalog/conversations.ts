/**
 * The conversations operations (ADR-0122): threads with Piloti and colleagues,
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
  listMessagesQuerySchema,
  markReadSchema,
  updateConversationSchema,
  updateMessageSchema,
} from '@/lib/conversations/conversation-wire'
import {
  conversationFeedbackQuerySchema,
  retractAnswerFeedbackQuerySchema,
  upsertAnswerFeedbackSchema,
} from '@/lib/feedback/types'
import {
  listOfficeProductFeedbackQuerySchema,
  listOwnProductFeedbackQuerySchema,
  replyToProductFeedbackSchema,
  submitProductFeedbackSchema,
} from '@/lib/product-feedback/types'
import { similarPassagesRequestSchema } from '@/lib/similar-passages/types'
import type { AgentOperation } from '../operation'

const conversationParams = z.object({
  id: z.string().describe('The conversation id (`s_` plus a UUID with underscores), from conversation-list.'),
})

const feedbackReportParams = z.object({
  reportId: z.string().uuid().describe('The feedback report id (a UUID), from feedback-report-list.'),
})

const messageParams = z.object({
  id: z.string().describe('The conversation id, from conversation-list.'),
  messageId: z.string().describe('The message id (a UUID), from conversation-message-list.'),
})

export const conversationsOperations = [
  {
    name: 'conversation-list',
    domain: 'conversations',
    links: 'conversation',
    summary: 'List the conversations the person can see',
    description:
      'The conversations the person may open, their own and shared ones, most recently active first, with id, title, project and ' +
      'unread state. Pass projectId (from project-list) to narrow; page with `nextCursor`. ' +
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
    links: 'conversation',
    summary: 'Start a new conversation',
    description:
      'Creates an empty private conversation, optionally in a project (projectId from project-list) or about one document. ' +
      'You choose the id: `s_` plus a UUID with underscores. Returns it. Share it deliberately afterwards.',
    method: 'POST',
    path: '/api/conversations',
    body: createConversationSchema,
    load: () => import('@/app/api/conversations/route'),
  },
  {
    name: 'conversation-get',
    domain: 'conversations',
    links: 'conversation',
    summary: 'Read one conversation',
    description:
      'One conversation: title, project, visibility, engagement mode (when Piloti answers) and the person’s role. Messages: conversation-message-list.',
    method: 'GET',
    path: '/api/conversations/[id]',
    params: conversationParams,
    load: () => import('@/app/api/conversations/[id]/route'),
  },
  {
    name: 'conversation-update',
    domain: 'conversations',
    links: 'conversation',
    summary: 'Rename a conversation or change when Piloti answers',
    description:
      'Sets `title` (owner role) and/or the `engagement` mode that decides when Piloti answers (collaborator role); at least one. Returns it.',
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
      'Deletes a conversation and its messages for everyone in it, permanently. The answer is the same whether or not the id was real.',
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
      'The newest messages of a conversation, oldest first within the page; earlier ones through `nextCursor`. Each has id, role, ' +
      'content, author, time and mentions; `include` adds citations, steps or metadata. Message ids feed conversation-message-changes.',
    method: 'GET',
    path: '/api/conversations/[id]/messages',
    params: conversationParams,
    query: listMessagesQuerySchema,
    load: () => import('@/app/api/conversations/[id]/messages/route'),
  },
  {
    name: 'conversation-message-add',
    domain: 'conversations',
    summary: 'Store a message in a conversation',
    description:
      'Appends one message, or an array of them, to a thread the person may write in; you supply each id. `mentions` ' +
      '(ids from conversation-mention-candidate-list) address colleagues, who get an inbox item. Stores only: it opens no ' +
      'turn with Piloti. Returns the stored rows.',
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
      'Saves the person’s decisions on an answer’s cards (`cardInteractions`, keyed like `memory_proposal-0`) and its ' +
      'details (`provenance`, `promptState`, `stages`). Provide at least one field. The service whitelists the free-form parts. A proposal is decided on its own card, not here.',
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
      'documents the person may not see are left out. Each change carries the id the person’s undo takes.',
    method: 'GET',
    path: '/api/conversations/[id]/messages/[messageId]/changes',
    params: messageParams,
    load: () => import('@/app/api/conversations/[id]/messages/[messageId]/changes/route'),
  },
  {
    name: 'conversation-message-usage',
    domain: 'conversations',
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
    summary: 'Mark a conversation read',
    description:
      'Moves the person’s read marker to now, or to `lastReadMessageId`, and clears the thread’s inbox items. Empty object: mark all read.',
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
      'One draft in the conversation’s working directory, to read before filing; `path` is the one the answer’s card names. To keep it: conversation-draft-file.',
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
      'Files a draft (path from the answer’s card or conversation-draft-get) as a document in the conversation’s project. A same-name ' +
      'collision answers 409 with the existing document; repeat with `force: true` only after the person confirmed. Returns the document.',
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
      'The person’s own thumbs-up and thumbs-down votes on answers in one conversation (conversationId from conversation-list).',
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
      'Votes on one answer (messageId from conversation-message-list); voting again replaces the vote. A down-vote feeds Piloti’s failure learning: add the reason.',
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
      'Sends a bug report, idea, praise or question to the Piloti team and opens a ticket. Not an answer vote (that is answer-feedback-submit).',
    method: 'POST',
    path: '/api/feedback/reports',
    body: submitProductFeedbackSchema,
    load: () => import('@/app/api/feedback/reports/route'),
  },
  {
    name: 'feedback-report-list',
    domain: 'conversations',
    summary: 'List the person’s own feedback reports',
    description:
      'The person’s own product feedback reports, newest first, each with its ticket status (`resolved` is done, every other ' +
      'status is an active case), ticket number, last activity, and `hasUpdate` when the Piloti team replied or changed the ' +
      'status since the person last read the thread; `updatedCount` counts those on the page. `canViewOffice` says whether ' +
      'feedback-office-report-list is open to them. Page with `nextCursor`. Threads: feedback-thread-get.',
    method: 'GET',
    path: '/api/feedback/reports',
    query: listOwnProductFeedbackQuerySchema,
    load: () => import('@/app/api/feedback/reports/route'),
  },
  {
    name: 'feedback-office-report-list',
    domain: 'conversations',
    summary: 'List every feedback report of the organization',
    description:
      'Every product feedback report filed by anyone in the organization, newest first, with the reporter’s name, ticket ' +
      'status (`resolved` is done, every other status is an active case), ticket number and last activity. Needs ' +
      '`org:settings:manage` (403 otherwise). `mine: false` marks a colleague’s report: its thread reads with ' +
      'feedback-thread-get but only the reporter can answer it. Page with `nextCursor`.',
    method: 'GET',
    path: '/api/feedback/office-reports',
    query: listOfficeProductFeedbackQuerySchema,
    load: () => import('@/app/api/feedback/office-reports/route'),
  },
  {
    name: 'feedback-thread-get',
    domain: 'conversations',
    summary: 'Read the conversation on one feedback report',
    description:
      'The thread on one feedback report, oldest first: the report as written, the Piloti team’s replies (`author: team`) ' +
      'and the reporter’s answers (`author: reporter`). The person’s own report, or, with `org:settings:manage`, a ' +
      'colleague’s (read-only, `report.mine: false`). Reading one’s own marks it as read. `live: false` means the ticket ' +
      'could not be read and only the report is shown.',
    method: 'GET',
    path: '/api/feedback/reports/[reportId]/messages',
    params: feedbackReportParams,
    load: () => import('@/app/api/feedback/reports/[reportId]/messages/route'),
  },
  {
    name: 'feedback-thread-reply',
    domain: 'conversations',
    summary: 'Answer the Piloti team on a feedback report',
    description:
      'Posts the person’s answer on one of their own feedback reports; the Piloti team sees it on the ticket. Refused (409) when ' +
      'the report has no ticket to answer on (`canReply: false` in feedback-report-list). Returns the updated thread.',
    method: 'POST',
    path: '/api/feedback/reports/[reportId]/messages',
    params: feedbackReportParams,
    body: replyToProductFeedbackSchema,
    load: () => import('@/app/api/feedback/reports/[reportId]/messages/route'),
  },
  {
    name: 'citation-format',
    domain: 'conversations',
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
      'Given a passage (its document by id or legal-corpus file name, and its text), finds similar passages across the projects ' +
      'and documents the person may read, grouped project, document, passage. Shows how the office handled it before.',
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
      'One answer from Piloti as a .docx with its sources, an attached resource (base64 `blob`) up to 5 MiB. Message ids: conversation-message-list.',
    method: 'GET',
    path: '/api/conversations/[id]/messages/[messageId]/export',
    params: messageParams,
    binaryResponse: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    load: () => import('@/app/api/conversations/[id]/messages/[messageId]/export/route'),
  },

] as const satisfies readonly AgentOperation[]
