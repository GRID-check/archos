/**
 * Consulting Piloti (ADR-0123): an agent acting for a person asks Piloti, the
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

export const consultOperations: readonly AgentOperation[] = [
  {
    name: 'piloti-ask-create',
    domain: 'conversations',
    summary: 'Ask Piloti a question and get its answer',
    description:
      'Asks Piloti, the office’s own agent, a question as the signed-in person: it answers from the office’s ' +
      'documents, the project’s files and building law, with the person’s rights, and may file a document. ' +
      `Waits up to ${ASK_WAIT_SECONDS} seconds: state "completed" carries answer.text and any documents filed; ` +
      'state "submitted" or "working" means call piloti-ask-get with the id after pollAfterSeconds. ' +
      'Pass projectId (from project-list) to ask about one project, and conversationId from an earlier ask to ' +
      'follow up in the same conversation. "rejected" or "failed" carry the reason (a spent budget, a busy ' +
      'conversation). Uses the organization’s model budget, and needs the piloti-ask switch.',
    method: 'POST',
    path: '/api/piloti-asks',
    body: createAskSchema,
    load: () => import('@/app/api/piloti-asks/route'),
  },
  {
    name: 'piloti-ask-get',
    domain: 'conversations',
    summary: 'Read an ask to Piloti, and its answer once there',
    description:
      'The ask piloti-ask-create started, by its id: its state, the answer once "completed", the documents ' +
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
]
