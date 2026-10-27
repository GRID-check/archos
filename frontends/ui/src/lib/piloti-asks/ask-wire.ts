/**
 * The contract of a question another agent asks Piloti (ADR-0124): the routes
 * under `/api/piloti-asks`, the MCP operations in
 * `lib/agent-api/catalog/consult.ts`, and the A2A door (`lib/a2a/`) all read
 * it from here. Pure: no database, no service (`lib/api/wire-modules.spec.ts`).
 *
 * The states are the A2A task states (specification 1.0, `TaskState`),
 * lowercase, so a task's state needs no translation table: `submitted` (the
 * question is recorded, the turn not yet started), `working`, and the four
 * terminal ones. Piloti never asks back mid-turn (`ask_user` refuses on a
 * headless turn), so `input-required` does not occur.
 */

import { z } from 'zod'
import { conversationIdSchema } from '@/lib/session-documents/conversation-id'

export const ASK_STATES = ['submitted', 'working', 'completed', 'canceled', 'failed', 'rejected'] as const
export type AskState = (typeof ASK_STATES)[number]

/** The states an ask never leaves. */
export const TERMINAL_ASK_STATES: ReadonlySet<AskState> = new Set<AskState>(['completed', 'canceled', 'failed', 'rejected'])

export const isTerminalAskState = (state: AskState): boolean => TERMINAL_ASK_STATES.has(state)

/**
 * The agent-catalog operations that ask Piloti. The recursion lock names them:
 * Piloti's own door never files one as a proposal and never applies one
 * (`lib/proposals/operation-applier.ts`), so a turn cannot ask Piloti again.
 */
export const PILOTI_ASK_OPERATIONS = ['piloti-ask-create', 'piloti-ask-get', 'piloti-ask-cancel'] as const

export const isPilotiAskOperation = (name: string): boolean =>
  (PILOTI_ASK_OPERATIONS as readonly string[]).includes(name)

/** The longest question an agent may send: a long brief, not a document (attach those to the project). */
export const MAX_QUESTION_CHARS = 8_000

/** How long the asking request waits for the answer before it answers `working` and the agent polls. */
export const ASK_WAIT_SECONDS = 40

/**
 * How long an ask may stay open before it is ended `failed` when it is next read:
 * the turn's outcome notice was lost (a replica died mid-turn). Past the longest
 * a turn runs; `GRID_PILOTI_ASK_MAX_SECONDS` overrides it.
 */
export const DEFAULT_ASK_MAX_SECONDS = 1_800

export const createAskSchema = z
  .object({
    question: z
      .string()
      .trim()
      .min(1)
      .max(MAX_QUESTION_CHARS)
      .describe('The question or request for Piloti, in the words the person would use, German or English.'),
    projectId: z
      .string()
      .guid()
      .optional()
      .describe('The project Piloti should answer in, from project-list. Omit for the office as a whole.'),
    conversationId: conversationIdSchema
      .optional()
      .describe(
        'Continue an earlier ask: its conversationId, from piloti-ask-create or piloti-ask-get. ' +
          'Piloti then sees the earlier questions and answers. Omit to start a new conversation.',
      ),
    waitSeconds: z
      .number()
      .int()
      .min(0)
      .max(ASK_WAIT_SECONDS)
      .optional()
      .describe(
        `How long to wait for the answer before returning (default and most ${ASK_WAIT_SECONDS}); 0 returns the ` +
          'ask at once, and piloti-ask-get reads it later.',
      ),
  })
  .strict()
export type CreateAskRequest = z.infer<typeof createAskSchema>

export const askParamsSchema = z.object({
  id: z.guid().describe('The ask id, from piloti-ask-create.'),
})

export const getAskQuerySchema = z
  .object({
    waitSeconds: z.coerce
      .number()
      .int()
      .min(0)
      .max(ASK_WAIT_SECONDS)
      .optional()
      .describe(`Wait up to this many seconds (at most ${ASK_WAIT_SECONDS}) for the answer before returning.`),
  })
  .strict()
export type GetAskQuery = z.infer<typeof getAskQuerySchema>

/** A document Piloti filed while it answered: the A2A artifact beside the answer. */
export interface AskDocument {
  documentId: string
  versionId: string
  name: string
  projectId: string | null
  contentType: string | null
}

/**
 * One source the answer cites: a document, and the page when the citation names
 * one. `documentId` is the answer's own document identity (what its citations
 * group on), not a workspace document id. `url` opens the cited page in Piloti
 * for the asker (the UI's `?cite=` link on their conversation), or is the
 * outbound address of a web or RIS source.
 */
export interface AskSource {
  documentId: string
  name: string
  page?: number
  url: string
}

/** How far the answer rests on its sources, as the answer stored it (ADR-0125). */
export interface AskConfidence {
  level: 'low' | 'medium' | 'high'
  /** Why, in one sentence. */
  reason?: string
  /** Set when a guard lowered the level; the guard's code. */
  cappedReason?: string
  /** A search ran and found nothing: the answer is Piloti's own knowledge, not a document's. */
  lookupFoundNothing?: true
}

/** What the answer's message stores about its grounding. Each key is absent where the message has none. */
export interface AskAnswerEvidence {
  sources?: AskSource[]
  confidence?: AskConfidence
}

/** What every ask route answers. */
export interface AskView {
  id: string
  /** The person's own thread the turn ran in; pass it back to continue (A2A `contextId`). */
  conversationId: string
  projectId: string | null
  state: AskState
  /** The question as it was asked (the person's message in the thread). */
  question: string | null
  /** Why it failed or was rejected. */
  reason: string | null
  /** Piloti's answer, once `completed`; `text` is plain Markdown (`answer-text.ts`), not the chat's dialect. */
  answer: ({ messageId: string; text: string } & AskAnswerEvidence) | null
  documents: AskDocument[]
  createdAt: string
  updatedAt: string
  endedAt: string | null
  /** While not terminal: how long to wait before asking again with piloti-ask-get. */
  pollAfterSeconds: number | null
}
