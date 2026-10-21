/**
 * An agent asks Piloti (ADR-0123): the service behind `/api/piloti-asks`.
 *
 * A connected agent (through the MCP door, or the A2A door, which calls the
 * same routes) asks Piloti a question for the person it acts for. The answer is
 * a turn: the ADR-0106 headless turn, run as that person (`runHeadlessTurn`),
 * in their own private thread, on their budget, and traced in Langfuse like any
 * turn, tagged `trigger:agent_consult` with the ask's id as `trigger_event_id`.
 *
 * 1. The organization's switch (`piloti-ask`), then the thread: a new private
 *    conversation of the person's, or one an earlier ask of theirs started.
 * 2. The question, written into the thread as the person's message under the
 *    ask's id, which is also the turn id and the A2A task id.
 * 3. The turn context for that session and thread (`resolveTurnContext`),
 *    which refuses a spent budget, and the chat socket, opened as an internal
 *    caller with the signed envelope and `X-AIQ-Mode: headless`.
 * 4. A wait of up to {@link ASK_WAIT_SECONDS}: the chat socket reports the
 *    turn's end to `/api/internal/turns/outcome` (`recordAskOutcome`), on
 *    whichever replica, and this polls the row. Past the wait the caller gets
 *    `working` and polls `GET /api/piloti-asks/[id]`.
 *
 * The recursion lock is not here: in-product Piloti never runs a write, it
 * proposes it, and `lib/proposals/operation-applier.ts` refuses to file or
 * apply an ask; the A2A door refuses Piloti's own credential.
 */

import 'server-only'
import { randomUUID } from 'node:crypto'
import { v5 as uuidv5 } from 'uuid'
import { ConflictError, ForbiddenError, NotFoundError } from '@/lib/api/errors'
import { isAuthzError } from '@/lib/auth-utils'
import type { AuthorizedSession } from '@/lib/auth/types'
import { CHAT_PERMISSIONS } from '@/lib/authz/chat'
import { isPilotiAskEnabled } from '@/lib/authz/feature-flags'
import { requireProjectAccess } from '@/lib/authz/projects'
import { findConversationInOrg, findMessageInConversation, insertConversation, insertMessages } from '@/lib/conversations/repository'
import type { PilotiAskRow } from '@/lib/db/schema'
import { withPlatformAccess } from '@/lib/db/tenant-context'
import { isUuid } from '@/lib/ids'
import { memberReader } from '@/lib/documents/visibility'
import { cancelHeadlessTurn, chatSocketUrl, runHeadlessTurn, type HeadlessUserMessage } from '@/lib/turns/headless-turn'
import type { TurnOutcomeRequest } from '@/lib/turns/outcome-types'
import { resolveTurnContext, TurnBudgetExhaustedError } from '@/lib/turns/turn-context'
import { turnContextHeaders } from '@/lib/turns/turn-headers.js'
import {
  ASK_WAIT_SECONDS,
  isTerminalAskState,
  type AskView,
  type CreateAskRequest,
} from './ask-wire'
import {
  endAsk,
  findAsk,
  findAskById,
  hasAskedInConversation,
  insertAsk,
  listAskDocuments,
  markAskWorking,
  type AskEnd,
} from './repository'

/** The hello entries a server must name before the question is sent: without `if_idle` it would supersede. */
export const ASK_REQUIRES = ['user_message.trigger', 'user_message.if_idle'] as const

/** How often a waiting request reads the row. */
const POLL_MS = 750
/** What an agent is told to wait between polls while the turn runs. */
const POLL_AFTER_SECONDS = 10
/** The longest title a thread gets from its first question. */
const MAX_TITLE = 120
/** How long a cancel waits for the turn to report that it stopped. */
const CANCEL_WAIT_MS = 5_000

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** The id of the answer a turn writes: `aiq_agent.turn.response.answer_message_id`, the same uuid5. */
export function askAnswerMessageId(conversationId: string, askId: string): string {
  return uuidv5(`grid:assistant:${conversationId}:${askId}`, uuidv5.URL)
}

/** A new conversation id in the app's shape: `s_` and a uuid with underscores. */
const newConversationId = (): string => `s_${randomUUID().replace(/-/g, '_')}`

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

function requireEnabled(session: AuthorizedSession): void {
  if (isPilotiAskEnabled(session)) return
  throw new ForbiddenError('Asking Piloti from another agent is not enabled for this organization (piloti-ask).', {
    reason: 'piloti-ask-off',
  })
}

/**
 * The thread the ask runs in, and its project. A continued one must be a
 * conversation of this person that an earlier ask of theirs started, so an
 * agent cannot write into a thread the person shares or was shared.
 */
async function threadFor(session: AuthorizedSession, input: CreateAskRequest): Promise<{ conversationId: string; projectId: string | null }> {
  if (input.conversationId) {
    const conversation = await findConversationInOrg(input.conversationId, session.organizationId)
    const continues =
      conversation !== null &&
      conversation.createdBy === session.userId &&
      !conversation.deletedAt &&
      (await hasAskedInConversation(session.organizationId, conversation.id, session.userId))
    if (!conversation || !continues) throw new NotFoundError('No ask of yours started that conversation.')
    if (input.projectId && input.projectId !== conversation.projectId) {
      throw new ConflictError('That conversation belongs to another project. Omit projectId to continue it.', {
        reason: 'piloti-ask-project-mismatch',
      })
    }
    if (conversation.projectId) await requireProjectAccess(session, conversation.projectId, CHAT_PERMISSIONS)
    return { conversationId: conversation.id, projectId: conversation.projectId ?? null }
  }
  if (input.projectId) await requireProjectAccess(session, input.projectId, CHAT_PERMISSIONS)
  const conversationId = newConversationId()
  await insertConversation({
    id: conversationId,
    organizationId: session.organizationId,
    createdBy: session.userId,
    title: clip(input.question, MAX_TITLE),
    projectId: input.projectId ?? null,
  })
  return { conversationId, projectId: input.projectId ?? null }
}

/** The question as the wire carries it (`docs/api/websocket-protocol.md`, „A turn an event woke"). */
export function askMessage(input: {
  askId: string
  conversationId: string
  question: string
  authorName: string | null
}): HeadlessUserMessage {
  return {
    type: 'user_message',
    conversation_id: input.conversationId,
    message_id: input.askId,
    text: input.question,
    author_name: input.authorName,
    trigger: { kind: 'agent_consult', event_id: input.askId, annotation_id: null },
    if_idle: true,
  }
}

function internalSecret(): string {
  const secret = process.env.GRID_INTERNAL_API_TOKEN
  // Without it the envelope is unsigned and the backend would not trust it.
  if (!secret) throw new Error('GRID_INTERNAL_API_TOKEN is not set: an ask cannot sign its turn')
  return secret
}

/** Start the turn; the ask's end when it did not start, or null when it runs. */
async function startTurn(
  session: AuthorizedSession,
  ask: PilotiAskRow,
  projectId: string | null,
  question: string,
): Promise<AskEnd | null> {
  let context: Awaited<ReturnType<typeof resolveTurnContext>>
  try {
    context = await resolveTurnContext(session, {
      projectId: projectId ?? undefined,
      conversationId: ask.conversationId,
    })
  } catch (error) {
    if (error instanceof TurnBudgetExhaustedError) return { state: 'rejected', reason: `budget: ${error.message}` }
    if (isAuthzError(error)) return { state: 'rejected', reason: 'You may no longer chat in this project.' }
    throw error
  }
  const outcome = await runHeadlessTurn({
    url: chatSocketUrl(ask.conversationId),
    conversationId: ask.conversationId,
    projectId: context.projectId,
    headers: {
      ...turnContextHeaders(context, { issuedAt: Date.now(), secret: internalSecret() }),
      'x-aiq-mode': 'headless',
    },
    message: askMessage({ askId: ask.id, conversationId: ask.conversationId, question, authorName: session.name }),
    requires: ASK_REQUIRES,
    timeoutMs: 20_000,
  })
  switch (outcome.kind) {
    case 'started':
    case 'duplicate':
      return null
    case 'busy':
      return { state: 'rejected', reason: 'Piloti is still answering in this conversation. Ask again when it is done.' }
    case 'refused':
      return { state: 'rejected', reason: outcome.reason }
    case 'rejected':
      return { state: 'failed', reason: `rejected: ${outcome.code}${outcome.message ? ` (${outcome.message})` : ''}` }
    case 'unavailable':
      return { state: 'failed', reason: `Piloti could not be reached: ${outcome.reason}` }
  }
}

/** Read the row until it is terminal or `deadline` passes; the last row read. */
async function waitForEnd(row: PilotiAskRow, deadline: number): Promise<PilotiAskRow> {
  let current = row
  while (!isTerminalAskState(current.state) && Date.now() < deadline) {
    await sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now())))
    current = (await findAsk(current.organizationId, current.id)) ?? current
  }
  return current
}

/** The view of `row` as its asker reads it: the answer once completed, and what Piloti filed meanwhile. */
async function viewOf(session: AuthorizedSession, row: PilotiAskRow): Promise<AskView> {
  const conversation = await findConversationInOrg(row.conversationId, row.organizationId)
  const question = await findMessageInConversation(row.conversationId, row.id)
  let answer: AskView['answer'] = null
  if (row.state === 'completed') {
    const messageId = askAnswerMessageId(row.conversationId, row.id)
    const message = await findMessageInConversation(row.conversationId, messageId)
    if (message) answer = { messageId, text: message.content }
  }
  const terminal = isTerminalAskState(row.state)
  return {
    id: row.id,
    conversationId: row.conversationId,
    projectId: conversation?.projectId ?? null,
    state: row.state,
    question: question?.content ?? null,
    reason: row.reason,
    answer,
    documents: await listAskDocuments(row, memberReader(session.userId)),
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    endedAt: row.endedAt ? new Date(row.endedAt).toISOString() : null,
    pollAfterSeconds: terminal ? null : POLL_AFTER_SECONDS,
  }
}

/**
 * Ask Piloti `input.question` as `session`'s person, and wait up to
 * {@link ASK_WAIT_SECONDS} for the answer. A refusal that is about the ask
 * (budget, a busy thread, a server that would not take it) is an ask that
 * ended `rejected` or `failed`, with its reason; a refusal of the caller
 * (the switch, the project) throws.
 */
export async function askPiloti(
  session: AuthorizedSession,
  input: CreateAskRequest,
  options: { waitMs?: number } = {},
): Promise<AskView> {
  requireEnabled(session)
  const deadline = Date.now() + (options.waitMs ?? ASK_WAIT_SECONDS * 1_000)
  const { conversationId, projectId } = await threadFor(session, input)
  const id = randomUUID()
  const ask = await insertAsk({ id, organizationId: session.organizationId, conversationId, requestedBy: session.userId })
  // The question is the person's message in their thread, under the turn's id: a retry writes nothing.
  await insertMessages([
    {
      id,
      conversationId,
      role: 'user',
      authorUserId: session.userId,
      content: input.question,
      metadata: { messageType: 'user', agentConsult: { askId: id } },
    },
  ])

  const notStarted = await startTurn(session, ask, projectId, input.question)
  if (notStarted) {
    const ended = await endAsk(session.organizationId, id, notStarted)
    return viewOf(session, ended ?? (await findAsk(session.organizationId, id)) ?? ask)
  }
  await markAskWorking(session.organizationId, id)
  const current = (await findAsk(session.organizationId, id)) ?? ask
  return viewOf(session, await waitForEnd(current, deadline))
}

/** The asker's ask, or 404: nobody else reads it, the conversation's sharing aside. */
async function requireOwnAsk(session: AuthorizedSession, id: string): Promise<PilotiAskRow> {
  // An id of another shape names no ask: the same answer as one that is not the caller's.
  if (!isUuid(id)) throw new NotFoundError('Ask not found')
  const row = await findAsk(session.organizationId, id)
  if (!row || row.requestedBy !== session.userId) throw new NotFoundError('Ask not found')
  return row
}

/** The ask as it stands, waiting up to `waitSeconds` for it to end. */
export async function getAsk(session: AuthorizedSession, id: string, waitSeconds = 0): Promise<AskView> {
  const row = await requireOwnAsk(session, id)
  const waited = waitSeconds > 0 ? await waitForEnd(row, Date.now() + Math.min(waitSeconds, ASK_WAIT_SECONDS) * 1_000) : row
  return viewOf(session, waited)
}

/**
 * Stop the ask's turn. An ask that already ended is a conflict (A2A
 * `TaskNotCancelableError`). The turn reports `stopped` itself; a turn that is
 * not running (never started, or ended between the read and the stop) is
 * ended here.
 */
export async function cancelAsk(session: AuthorizedSession, id: string): Promise<AskView> {
  const row = await requireOwnAsk(session, id)
  if (isTerminalAskState(row.state)) {
    throw new ConflictError(`The ask has already ended (${row.state}).`, { reason: 'piloti-ask-ended' })
  }
  const outcome = await cancelHeadlessTurn({
    url: chatSocketUrl(row.conversationId),
    conversationId: row.conversationId,
    turnId: row.id,
    headers: {
      ...turnContextHeaders(
        { organizationId: row.organizationId, userId: row.requestedBy, conversationId: row.conversationId },
        { issuedAt: Date.now(), secret: internalSecret() },
      ),
      'x-aiq-mode': 'headless',
    },
  })
  if (outcome.kind === 'not_running') await endAsk(row.organizationId, row.id, { state: 'canceled' })
  if (outcome.kind === 'unavailable' || outcome.kind === 'rejected') {
    const why = outcome.kind === 'rejected' ? outcome.code : outcome.reason
    throw new ConflictError(`The ask could not be stopped: ${why}`, { reason: 'piloti-ask-cancel-failed' })
  }
  const current = (await findAsk(row.organizationId, row.id)) ?? row
  return viewOf(session, await waitForEnd(current, Date.now() + CANCEL_WAIT_MS))
}

/** The ask's final word for a turn's outcome. */
export function askEndOf(request: Pick<TurnOutcomeRequest, 'outcome' | 'reason'>): AskEnd {
  switch (request.outcome) {
    case 'answered':
    case 'handed_off':
      return { state: 'completed' }
    case 'stopped':
      return { state: 'canceled' }
    case 'refused':
      return { state: 'rejected', reason: request.reason?.trim() || 'refused' }
    case 'failed':
      return { state: 'failed', reason: request.reason?.trim() || 'the turn ended without an answer' }
  }
}

/**
 * Record how an ask's turn ended, from the chat socket's outcome notice
 * (`lib/turns/outcome.ts` routes a turn that is not a wake here). True only for
 * the call that ended the ask; an unknown turn, another conversation's, or an
 * ask that already ended settles nothing.
 */
export async function recordAskOutcome(request: TurnOutcomeRequest): Promise<boolean> {
  // The turn names its ask and the ask names the organization.
  const ask = await withPlatformAccess(
    'turn outcome: the chat socket names a turn by id, before any organization is known',
    () => findAskById(request.turnId),
  )
  if (!ask || isTerminalAskState(ask.state) || ask.conversationId !== request.conversationId) return false
  return (await endAsk(ask.organizationId, ask.id, askEndOf(request))) !== null
}
