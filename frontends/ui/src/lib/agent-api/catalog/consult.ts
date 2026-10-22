/**
 * Consulting Piloti (ADR-0124): an agent acting for a person asks Piloti, the
 * office's colleague, a question, and Piloti answers in a turn run as that
 * person. In the `conversations` domain because the ask is a conversation: the
 * person's own private thread, readable in Piloti like any other.
 *
 * Piloti in-product never runs these (the recursion lock): its writes are
 * proposals, and `lib/proposals/operation-applier.ts` refuses to file or apply
 * an ask. The names are `PILOTI_ASK_OPERATIONS` in `lib/piloti-asks/ask-wire.ts`.
 */

import {
  askParamsSchema,
  ASK_WAIT_SECONDS,
  createAskSchema,
  getAskQuerySchema,
} from '@/lib/piloti-asks/ask-wire'
import type { AgentOperation } from '../operation'

export const consultOperations = [
  {
    name: 'piloti-ask-create',
    domain: 'conversations',
    links: 'conversation',
    summary: 'Ask Piloti a question and get its answer',
    description:
      'Asks Piloti, the office’s own agent, as the signed-in person: it answers from the office’s documents, ' +
      'the project’s files and building law, and may file a document. ' +
      `Waits up to ${ASK_WAIT_SECONDS} s (less with waitSeconds). "completed" carries answer.text, answer.sources ` +
      '(documentId, name, page, a url opening the cited page) and answer.confidence (level, reason); an answer with ' +
      'neither is not grounded in a document. "submitted" or "working": call piloti-ask-get after pollAfterSeconds. ' +
      '"rejected" or "failed" say why (spent budget, busy conversation). Pass projectId (from project-list) to ask ' +
      'about one project: without it Piloti answers for the office as a whole and reads no project’s files. ' +
      'conversationId follows up an earlier ask. Uses the organization’s model budget.',
    method: 'POST',
    path: '/api/piloti-asks',
    body: createAskSchema,
    load: () => import('@/app/api/piloti-asks/route'),
  },
  {
    name: 'piloti-ask-get',
    domain: 'conversations',
    links: 'conversation',
    summary: 'Read an ask to Piloti, and its answer once there',
    description:
      'The ask piloti-ask-create started, by its id: its state, the answer once "completed" (with its sources and confidence, as piloti-ask-create), ' +
      'the documents ' +
      `Piloti filed, or the reason it failed. Pass waitSeconds (at most ${ASK_WAIT_SECONDS}) to wait for the ` +
      'answer instead of polling quickly. Only the person the ask was made for can read it.',
    method: 'GET',
    path: '/api/piloti-asks/[id]',
    params: askParamsSchema,
    query: getAskQuerySchema,
    load: () => import('@/app/api/piloti-asks/[id]/route'),
  },
  {
    name: 'piloti-ask-cancel',
    domain: 'conversations',
    summary: 'Stop Piloti working on an ask',
    description:
      'Stops the turn of an ask that is still "submitted" or "working"; the ask ends "canceled" and whatever ' +
      'Piloti already wrote stays in the conversation. Refused (409) once the ask has ended. The id comes ' +
      'from piloti-ask-create.',
    method: 'POST',
    path: '/api/piloti-asks/[id]/cancel',
    params: askParamsSchema,
    idempotent: true,
    load: () => import('@/app/api/piloti-asks/[id]/cancel/route'),
  },
] as const satisfies readonly AgentOperation[]
