/**
 * The request shapes of the conversation routes, kept out of the route files (a
 * Next route exports handlers only) so each route and the MCP catalog
 * (`lib/agent-api/catalog/conversations.ts`, ADR-0122) parse against one schema.
 */

import { z } from 'zod'
import { CARD_DECISIONS } from '@/features/cards/card-decision'
import { CONVERSATION_ENGAGEMENTS } from '@/lib/db/schema/conversations'
import { MAX_MENTIONS_PER_MESSAGE, MAX_MESSAGES_PER_REQUEST } from '@/lib/limits'

export const createConversationSchema = z.object({
  // Client-generated id; length-capped so user-controlled strings never
  // reach the database unbounded.
  id: z.string().min(1).max(128),
  title: z.string().nullable().optional(),
  projectId: z.guid().nullable().optional(),
  subjectResourceType: z.literal('document').nullable().optional(),
  subjectResourceId: z.string().min(1).max(128).nullable().optional(),
})

/** Most conversations one page answers; the browser asks for this many. */
export const CONVERSATION_PAGE_MAX = 200

export const listConversationsQuerySchema = z.object({
  // Optional project scope; the service enforces project access + tenancy.
  projectId: z.guid().optional().describe('Only this project’s conversations.'),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(CONVERSATION_PAGE_MAX)
    .default(50)
    .describe(`Page size (default 50, most ${CONVERSATION_PAGE_MAX}).`),
  cursor: z.string().min(1).max(128).optional().describe('The previous `nextCursor`.'),
})

/** The heavy parts of a message a list can include: see `./message-view`. */
export const MESSAGE_INCLUDES = ['citations', 'steps', 'metadata'] as const
export type MessageInclude = (typeof MESSAGE_INCLUDES)[number]

/** Most messages one page answers. */
export const MESSAGE_PAGE_MAX = 200

export const listMessagesQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MESSAGE_PAGE_MAX)
    .default(50)
    .describe(`Page size (default 50, most ${MESSAGE_PAGE_MAX}).`),
  cursor: z
    .string()
    .guid()
    .optional()
    .describe('The previous `nextCursor`: earlier messages.'),
  include: z
    .string()
    .max(64)
    .refine((value) => value.split(',').every((part) => (MESSAGE_INCLUDES as readonly string[]).includes(part.trim())), {
      message: `include is a comma-separated list of ${MESSAGE_INCLUDES.join(', ')}`,
    })
    .optional()
    .describe(
      'Comma-separated extras, none by default: `citations` (sources with snippets), `steps` (thinking steps), `metadata` (cards, provenance, the rest).',
    ),
})

/**
 * Either a rename or a change to when the agent answers (ADR-0036) — one PATCH,
 * because both are edits to the same resource. At least one field is required, so
 * an empty body is a 400 rather than a silent no-op that looks like success.
 */
export const updateConversationSchema = z
  .object({
    title: z.string().min(1).optional(),
    engagement: z.enum(CONVERSATION_ENGAGEMENTS).optional(),
  })
  .refine((body) => body.title !== undefined || body.engagement !== undefined, {
    message: 'Provide title or engagement',
  })

export const generateTitleSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string(),
      })
    )
    .max(20),
  locale: z.string().optional(),
})

export const markReadSchema = z.object({
  // Client-generated message id; length-capped like every other id from a client.
  lastReadMessageId: z.string().min(1).max(128).nullable().optional(),
})

const mentionSchema = z.object({
  // A WorkOS user id or the agent's sentinel id; length-capped like every other
  // client-supplied identifier. Legitimacy is decided server-side, not here.
  targetId: z.string().min(1).max(128),
})

const createMessageSchema = z.object({
  // Client-generated id; length-capped so user-controlled strings never
  // reach the database unbounded.
  id: z.string().min(1).max(128),
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: z.string(),
  // UI display type (user, agent_response, …); stored in metadata so past
  // chats rehydrate with the right renderer. Length-capped like `id`.
  messageType: z.string().min(1).max(64).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  // Kept as a plain string: the chat store sends both ISO strings and
  // `String(Date)` output, which `.datetime()` would reject.
  createdAt: z.string().optional(),
  // Structured mentions (spec MN-3) — never a text match on a name. The
  // addressee set is resolved from these server-side (spec MN-2).
  //
  // Bounded by the SAME constant the service enforces (`@/lib/sharing/rate-limit`
  // owns the product bound MN-13 asks for) so the two cannot drift: this schema
  // used to cap the array at 20 while the service refused anything over 10, which
  // meant an 11-mention message passed validation and then hit a 403. The two are
  // still both needed — this bounds the PAYLOAD, the service bounds the
  // DEDUPLICATED target count, which is the number the abuse bound is about.
  mentions: z.array(mentionSchema).max(MAX_MENTIONS_PER_MESSAGE).optional(),
  // The asker's question, carried into the recipient's inbox item (spec MN-12).
  mentionNote: z.string().max(500).nullable().optional(),
})

// Bounded for the reason the constant explains: the route factory charges one
// unit of budget per REQUEST, so an unbounded array would buy unbounded insert
// work for a single unit. The POST charges the other half per message.
export const createMessagesSchema = z.union([
  createMessageSchema,
  z.array(createMessageSchema).min(1).max(MAX_MESSAGES_PER_REQUEST),
])

/**
 * One answer carries a handful of cards, so a map this size is generous; the
 * cap exists because the value lands in a jsonb column and `z.record` bounds
 * key length but not key COUNT.
 */
const MAX_CARD_INTERACTIONS = 64

/**
 * Keys are `cardKey(card, index)` values (`memory_proposal-0`); the decision is
 * validated against the closed union so no free-form status can reach the
 * stored message, and `decidedAt` must be a real instant.
 */
export const updateMessageSchema = z
  .object({
    cardInteractions: z
      .record(
        z.string().min(1).max(64),
        z.object({
          decision: z.enum(CARD_DECISIONS),
          decidedAt: z.string().datetime(),
        })
      )
      .refine((map) => Object.keys(map).length <= MAX_CARD_INTERACTIONS, {
        message: `At most ${MAX_CARD_INTERACTIONS} card interactions per message`,
      })
      .optional(),
    /**
     * The answer's provenance — the Herleitung, the confidence self-assessment,
     * the routing transparency (ADR-0037).
     *
     * Deliberately `unknown` here rather than a mirrored Zod schema: the shape is
     * a client display structure that will keep growing, and two definitions of it
     * would drift. `sanitizeProvenance` in the service is the single authority on
     * what may reach the column, and it is a whitelist — unknown keys are dropped,
     * unions checked, strings capped, the step list truncated. A jsonb column fed
     * from a client array needs a bound to be safe, not a type.
     */
    provenance: z.unknown().optional(),
    /** The answer to a human-in-the-loop prompt, bounded by `sanitizePromptState`. */
    promptState: z.unknown().optional(),
    /**
     * What a POST-ANSWER STAGE computed for this turn
     * (`docs/architecture/post-answer-stages.md` §4.3).
     *
     * `unknown` for the same reason `provenance` is: `sanitizeStages` in
     * `lib/conversations/message-stages` is the single authority on what may
     * reach the column, and it is a whitelist.
     */
    stages: z.unknown().optional(),
  })
  .refine(
    (body) =>
      body.cardInteractions !== undefined ||
      body.provenance !== undefined ||
      body.promptState !== undefined ||
      body.stages !== undefined,
    { message: 'Provide cardInteractions, provenance, promptState or stages' }
  )

/**
 * Longer than any chat answer the reveal draws. The text is only compared
 * against the stored one, never stored, but it is still a client string and
 * gets a bound.
 */
const MAX_SHOWN_CHARS = 200_000

export const cutStoppedAnswerSchema = z.object({
  /** The question that opened the turn: its id is the turn's, and it names the asker. */
  turnId: z.guid(),
  /** The answer's text as it was on screen at the press. */
  shown: z.string().max(MAX_SHOWN_CHARS),
})

export const fileDraftBodySchema = z
  .object({
    // The working-directory path as the card carries it (`/entwuerfe/….md`).
    // Length-capped like the preview door; legitimacy is decided by the
    // service and the backend's own path refusal, not here.
    path: z.string().min(1).max(500),
    // The card's title. Optional so an older client still files — the service
    // falls back to the path's file name.
    title: z.string().max(500).optional(),
    // Set after the card showed the same-name 409 and the reader confirmed.
    force: z.boolean().optional().default(false),
  })
  .strict()

export const draftPreviewQuerySchema = z.object({
  // The working-directory path as the card carries it (`/entwuerfe/….md`).
  path: z.string().min(1).max(500),
})
