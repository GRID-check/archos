/**
 * A conversation message as the API answers it (ADR-0131, rules 2 and 3).
 *
 * The stored row carries the whole answer in `metadata`: every citation with its
 * snippet, up to 200 thinking steps, the cards, the provenance. A reader who only
 * wants to know what was said does not pay for that, so the default view is the
 * lean one and the heavy parts are asked for by name (`include`). The browser
 * asks for all of them and so reads what the row held; an agent picks.
 *
 * No `server-only` and no drizzle: the browser imports the types and the parser.
 */

import { MESSAGE_INCLUDES, type MessageInclude } from './conversation-wire'

export interface MessageMentionView {
  targetId: string
  display: string
}

/** One message. `metadata` is present only when an `include` asked for a part of it. */
export interface MessageView {
  id: string
  conversationId: string
  role: string
  content: string
  /** The person who wrote it; null for Piloti, the system and tools. */
  authorUserId: string | null
  /** That person's name, where the directory knows it. */
  authorName: string | null
  /** ISO 8601. */
  createdAt: string
  /** The task run this message is the account of, if any. */
  runId: string | null
  /** How the chat draws it (`user`, `agent_response`, …). */
  messageType: string
  /** The colleagues (and Piloti) the message addresses, as structured mentions. */
  mentions: MessageMentionView[]
  metadata?: Record<string, unknown>
}

export interface MessageListResponse {
  /** The page, oldest first. */
  messages: MessageView[]
  /** Pass as `cursor` for the earlier messages; null when this page reaches the start. */
  nextCursor: string | null
}

/** What `include` asks for, from the comma-separated query value. */
export function parseMessageIncludes(value: string | undefined): ReadonlySet<MessageInclude> {
  const asked = (value ?? '').split(',').map((part) => part.trim())
  return new Set(MESSAGE_INCLUDES.filter((include) => asked.includes(include)))
}

const CITATION_KEYS = ['citations', 'readSources'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The part of a stored message's metadata the `include` set asks for:
 * `citations` the sources the answer cites and those it only read, `steps` the
 * thinking steps of its provenance, `metadata` everything else (cards,
 * provenance without its steps, ledgers). All three give back the stored whole.
 */
export function metadataFor(
  stored: unknown,
  include: ReadonlySet<MessageInclude>
): Record<string, unknown> | undefined {
  if (include.size === 0 || !isRecord(stored)) return undefined
  const out: Record<string, unknown> = include.has('metadata') ? { ...stored } : {}
  if (include.has('citations')) {
    for (const key of CITATION_KEYS) if (stored[key] !== undefined) out[key] = stored[key]
  } else {
    for (const key of CITATION_KEYS) delete out[key]
  }
  const provenance = isRecord(stored.provenance) ? stored.provenance : null
  if (provenance) {
    const { thinkingSteps, ...rest } = provenance
    const kept: Record<string, unknown> = include.has('metadata') ? rest : {}
    if (include.has('steps') && thinkingSteps !== undefined) kept.thinkingSteps = thinkingSteps
    if (Object.keys(kept).length > 0) out.provenance = kept
    else delete out.provenance
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function mentionsOf(stored: unknown): MessageMentionView[] {
  const raw = isRecord(stored) ? stored.mentions : undefined
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry): MessageMentionView[] => {
    if (!isRecord(entry) || typeof entry.targetId !== 'string' || entry.targetId.length === 0) return []
    return [{ targetId: entry.targetId, display: typeof entry.display === 'string' ? entry.display : entry.targetId }]
  })
}

/** A stored row, as the view of it. */
export interface StoredMessage {
  id: string
  conversationId: string
  role: string
  content: string
  authorUserId: string | null
  createdAt: Date
  runId: string | null
  metadata: unknown
}

export function toMessageView(
  row: StoredMessage,
  authorNames: ReadonlyMap<string, string>,
  include: ReadonlySet<MessageInclude>
): MessageView {
  const stored = isRecord(row.metadata) ? row.metadata : {}
  const metadata = metadataFor(row.metadata, include)
  const kind = typeof stored.messageType === 'string' && stored.messageType ? stored.messageType : null
  return {
    id: row.id,
    conversationId: row.conversationId,
    role: row.role,
    content: row.content,
    authorUserId: row.authorUserId,
    authorName: row.authorUserId ? (authorNames.get(row.authorUserId) ?? null) : null,
    createdAt: row.createdAt.toISOString(),
    runId: row.runId,
    messageType: kind ?? (row.role === 'user' ? 'user' : 'agent_response'),
    mentions: mentionsOf(stored),
    ...(metadata ? { metadata } : {}),
  }
}
