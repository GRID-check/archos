/**
 * An agent asks Piloti (ADR-0124): the service behind `/api/agent-asks`.
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
 *    caller with the signed envelope and `X-Chat-Mode: headless`.
 * 4. A wait of up to {@link ASK_WAIT_SECONDS}: the chat socket reports the
 *    turn's end to `/api/internal/turns/outcome` (`recordAskOutcome`), on
 *    whichever replica, and this polls the row. Past the wait the caller gets
 *    `working` and polls `GET /api/agent-asks/[id]`.
 *
 * The recursion lock is not here: in-product Piloti never runs a write, it
 * proposes it, and `lib/proposals/operation-applier.ts` refuses to file or
 * apply an ask; the A2A door refuses Piloti's own credential.
 */

import 'server-only'
import { randomUUID } from 'node:crypto'
import { ConflictError, ForbiddenError, isAuthzRefusal, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { CHAT_PERMISSIONS } from '@/lib/authz/chat'
import { configuredAppOrigin } from '@/lib/app-origin'
import { isAgentAskEnabled } from '@/lib/authz/feature-flags'
import { requireProjectAccess } from '@/lib/authz/projects'
import {
  deleteConversationInOrg,
  findConversationInOrg,
  findMessageInConversation,
  insertConversation,
  insertMessages,
} from '@/lib/conversations/repository'
import type { AgentAskRow } from '@/lib/db/schema/piloti-asks'
import { withPlatformAccess } from '@/lib/db/tenant-context'
import { isUuid } from '@/lib/ids'
import { memberReader } from '@/lib/documents/visibility'
import {
  cancelHeadlessTurn,
  chatSocketUrl,
  runHeadlessTurn,
  type HeadlessCancelOutcome,
  type HeadlessUserMessage,
} from '@/lib/turns/headless-turn'
import { HEADLESS_MODE_HEADERS } from '@/lib/turns/headless-mode'
import type { TurnOutcomeRequest } from '@/lib/turns/outcome-types'
import { askAnswerMessageId } from '@/lib/turns/answer-ids'
import { resolveTurnContext, TurnBudgetExhaustedError } from '@/lib/turns/turn-context'
import { turnContextHeaders } from '@/lib/turns/turn-headers.js'
import { projectFactResolver } from '@/lib/project-profile/answer-bindings'
import { findProjectProfile } from '@/lib/projects/repository'
import { projectKeysIn, type ProjectKey } from '@/lib/text/answer-directives'
import { answerEvidence } from './answer-evidence'
import { answerTextForAgent } from './answer-text'
import {
  ASK_WAIT_SECONDS,
  DEFAULT_ASK_MAX_SECONDS,
  isTerminalAskState,
  type AskView,
  type CreateAskRequest,
} from './ask-wire'
import {
  deleteAskQuestion,
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

export { askAnswerMessageId }

/** A new conversation id in the app's shape: `s_` and a uuid with underscores. */
const newConversationId = (): string => `s_${randomUUID().replace(/-/g, '_')}`

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

function requireEnabled(session: AuthorizedSession): void {
  if (isAgentAskEnabled(session)) return
  throw new ForbiddenError('Asking Piloti from another agent is not enabled for this organization (piloti-ask).', {
    reason: 'piloti-ask-off',
  })
}

/**
 * The thread the ask runs in, and its project. A continued one must be a
 * conversation of this person that an earlier ask of theirs started, so an
 * agent cannot write into a thread the person shares or was shared.
 */
async function threadFor(
  session: AuthorizedSession,
  input: CreateAskRequest,
): Promise<{ conversationId: string; projectId: string | null; created: boolean }> {
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
    return { conversationId: conversation.id, projectId: conversation.projectId ?? null, created: false }
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
  return { conversationId, projectId: input.projectId ?? null, created: true }
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

/** Where the ask's turn runs and how its envelope is signed, or why this deployment cannot reach it. */
type SocketTarget = { url: string; secret: string } | { unavailable: string }

function socketTarget(conversationId: string): SocketTarget {
  const secret = process.env.INTERNAL_API_TOKEN
  // Without it the envelope is unsigned and the backend would not trust it.
  if (!secret) return { unavailable: 'this deployment cannot sign a turn (INTERNAL_API_TOKEN)' }
  try {
    return { url: chatSocketUrl(conversationId), secret }
  } catch {
    return { unavailable: 'this deployment has no chat service configured (BACKEND_CHAT_URL)' }
  }
}

/** The longest an ask stays open before a read ends it `failed` (its outcome was lost). */
export function askMaxSeconds(env: Record<string, string | undefined> = process.env): number {
  const raw = Number.parseInt(env.AGENT_ASK_MAX_SECONDS ?? '', 10)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_ASK_MAX_SECONDS
}

/**
 * Start the turn: null when it runs, the ask's end when it did not start, or
 * `ended` when the ask ended (a cancel) before the turn was sent, which then is
 * not sent.
 */
async function startTurn(
  session: AuthorizedSession,
  ask: AgentAskRow,
  projectId: string | null,
  question: string,
): Promise<AskEnd | 'ended' | null> {
  let context: Awaited<ReturnType<typeof resolveTurnContext>>
  try {
    context = await resolveTurnContext(session, {
      projectId: projectId ?? undefined,
      conversationId: ask.conversationId,
    })
  } catch (error) {
    if (error instanceof TurnBudgetExhaustedError) return { state: 'rejected', reason: `budget: ${error.message}` }
    if (isAuthzRefusal(error)) return { state: 'rejected', reason: 'You may no longer chat in this project.' }
    throw error
  }
  const target = socketTarget(ask.conversationId)
  if ('unavailable' in target) return { state: 'failed', reason: `Piloti could not be reached: ${target.unavailable}` }
  // A cancel that landed while the context was read ended the ask: its turn is not started.
  const now = await findAsk(ask.organizationId, ask.id)
  if (!now || isTerminalAskState(now.state)) return 'ended'
  const outcome = await runHeadlessTurn({
    url: target.url,
    conversationId: ask.conversationId,
    projectId: context.projectId,
    headers: {
      ...turnContextHeaders(context, { issuedAt: Date.now(), secret: target.secret }),
      ...HEADLESS_MODE_HEADERS,
    },
    message: askMessage({ askId: ask.id, conversationId: ask.conversationId, question, authorName: session.name }),
    requires: ASK_REQUIRES,
    // No `timeoutMs`: the chat path's own bound (45 s, connect included) lets a cold backend start.
  })
  switch (outcome.kind) {
    case 'started':
    case 'duplicate':
      return null
    case 'busy':
      return {
        state: 'rejected',
        reason:
          'Piloti is still answering in this conversation, and an ask never interrupts a running turn. ' +
          'Read the earlier ask with agent-ask-get until it ends, then ask again; ' +
          'or ask in a new conversation by leaving out conversationId.',
      }
    case 'refused':
      return { state: 'rejected', reason: outcome.reason }
    case 'rejected':
      return { state: 'failed', reason: `rejected: ${outcome.code}${outcome.message ? ` (${outcome.message})` : ''}` }
    case 'unavailable':
      return { state: 'failed', reason: `Piloti could not be reached: ${outcome.reason}` }
  }
}

/** Read the row until it is terminal or `deadline` passes; the last row read. */
async function waitForEnd(row: AgentAskRow, deadline: number): Promise<AgentAskRow> {
  let current = row
  while (!isTerminalAskState(current.state) && Date.now() < deadline) {
    await sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now())))
    current = (await findAsk(current.organizationId, current.id)) ?? current
  }
  return current
}

/**
 * The row, ended `failed` when it has been open longer than any turn runs
 * ({@link askMaxSeconds}): its turn's outcome notice never arrived (a replica
 * died mid-turn), and without this the ask would read `working` forever.
 */
async function expireIfLost(row: AgentAskRow, now = Date.now()): Promise<AgentAskRow> {
  if (isTerminalAskState(row.state)) return row
  const maxSeconds = askMaxSeconds()
  if (now - new Date(row.createdAt).getTime() < maxSeconds * 1_000) return row
  const reason = `Piloti did not report the end of its turn within ${Math.round(maxSeconds / 60)} minutes. Ask again.`
  return (
    (await endAsk(row.organizationId, row.id, { state: 'failed', reason })) ??
    (await findAsk(row.organizationId, row.id)) ??
    row
  )
}

/** The view of `row` as its asker reads it: the answer once completed, and what Piloti filed meanwhile. */
async function viewOf(session: AuthorizedSession, row: AgentAskRow): Promise<AskView> {
  const conversation = await findConversationInOrg(row.conversationId, row.organizationId)
  const question = await findMessageInConversation(row.conversationId, row.id)
  let answer: AskView['answer'] = null
  if (row.state === 'completed') {
    const messageId = askAnswerMessageId(row.conversationId, row.id)
    const message = await findMessageInConversation(row.conversationId, messageId)
    if (message) {
      const evidence = answerEvidence(message, {
        conversationId: row.conversationId,
        projectId: conversation?.projectId ?? null,
        origin: configuredAppOrigin(),
      })
      const projectValue = await projectValuesFor(message.content, conversation?.projectId ?? null, row.organizationId)
      answer = { messageId, text: answerTextForAgent(message.content, { projectValue }), ...evidence }
    }
  }
  return {
    ...baseView(row, conversation?.projectId ?? null, question?.content ?? null),
    answer,
    documents: await listAskDocuments(row, memberReader(session.userId)),
  }
}

/**
 * The project's values for the `:project[key]` bindings an answer holds, or
 * undefined when it holds none (no profile read). A key the profile lacks
 * stays the key, as in the copy: a value is never invented.
 */
async function projectValuesFor(
  content: string,
  projectId: string | null,
  organizationId: string
): Promise<((key: ProjectKey) => string | null) | undefined> {
  if (!projectId || projectKeysIn(content).length === 0) return undefined
  const resolve = projectFactResolver(await findProjectProfile(projectId, organizationId))
  return (key) => resolve(key).text
}

/** The parts of a view the row alone answers. */
function baseView(row: AgentAskRow, projectId: string | null, question: string | null): AskView {
  const terminal = isTerminalAskState(row.state)
  return {
    id: row.id,
    conversationId: row.conversationId,
    projectId,
    state: row.state,
    question,
    reason: row.reason,
    answer: null,
    documents: [],
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    endedAt: row.endedAt ? new Date(row.endedAt).toISOString() : null,
    pollAfterSeconds: terminal ? null : POLL_AFTER_SECONDS,
  }
}

/**
 * End an ask whose turn never started, and take back what it wrote: the
 * question nobody will answer, and the thread when this ask opened it (the ask
 * row goes with it). The caller still gets the ask's final word, built here,
 * because nothing is left to read it from.
 */
async function endUnstarted(
  session: AuthorizedSession,
  ask: AgentAskRow,
  thread: { projectId: string | null; created: boolean },
  question: string,
  end: AskEnd,
): Promise<AskView> {
  const ended = (await endAsk(session.organizationId, ask.id, end)) ?? (await findAsk(session.organizationId, ask.id)) ?? ask
  if (thread.created) await deleteConversationInOrg(ask.conversationId, session.organizationId)
  else await deleteAskQuestion(session.organizationId, ask.conversationId, ask.id)
  return { ...baseView(ended, thread.projectId, question), pollAfterSeconds: null }
}

/**
 * Ask Piloti `input.question` as `session`'s person, and wait up to
 * `input.waitSeconds` ({@link ASK_WAIT_SECONDS} by default) for the answer. A
 * refusal that is about the ask (budget, a busy thread, a server that would not
 * take it or could not be reached) is an ask that ended `rejected` or `failed`,
 * with its reason, and leaves nothing in the person's conversations; a refusal
 * of the caller (the switch, the project) throws.
 */
export async function askAgent(
  session: AuthorizedSession,
  input: CreateAskRequest,
  options: { waitMs?: number } = {},
): Promise<AskView> {
  requireEnabled(session)
  const deadline = Date.now() + (options.waitMs ?? (input.waitSeconds ?? ASK_WAIT_SECONDS) * 1_000)
  const thread = await threadFor(session, input)
  const { conversationId, projectId } = thread
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

  let started: Awaited<ReturnType<typeof startTurn>>
  try {
    started = await startTurn(session, ask, projectId, input.question)
  } catch (error) {
    // Never a 500 that leaves the ask `submitted` with no id handed out.
    console.error('[piloti-ask] the turn could not be started:', error)
    started = { state: 'failed', reason: 'Piloti could not start the turn.' }
  }
  if (started !== null && started !== 'ended') return endUnstarted(session, ask, thread, input.question, started)
  if (started === null && !(await markAskWorking(session.organizationId, id))) {
    // Canceled while the turn was being sent: the turn runs, so stop it.
    const now = await findAsk(session.organizationId, id)
    if (now?.state === 'canceled') await stopTurn(now)
  }
  const current = (await findAsk(session.organizationId, id)) ?? ask
  return viewOf(session, await waitForEnd(current, deadline))
}

/** The asker's ask, or 404: nobody else reads it, the conversation's sharing aside. */
async function requireOwnAsk(session: AuthorizedSession, id: string): Promise<AgentAskRow> {
  // An id of another shape names no ask: the same answer as one that is not the caller's.
  if (!isUuid(id)) throw new NotFoundError('Ask not found')
  const row = await findAsk(session.organizationId, id)
  if (!row || row.requestedBy !== session.userId) throw new NotFoundError('Ask not found')
  return expireIfLost(row)
}

/** The ask as it stands, waiting up to `waitSeconds` for it to end. */
export async function getAsk(session: AuthorizedSession, id: string, waitSeconds = 0): Promise<AskView> {
  const row = await requireOwnAsk(session, id)
  const waited = waitSeconds > 0 ? await waitForEnd(row, Date.now() + Math.min(waitSeconds, ASK_WAIT_SECONDS) * 1_000) : row
  return viewOf(session, waited)
}

/** Send the stop for the ask's turn. Never throws: a deployment that cannot reach the chat service is `unavailable`. */
async function stopTurn(row: AgentAskRow): Promise<HeadlessCancelOutcome> {
  const target = socketTarget(row.conversationId)
  if ('unavailable' in target) return { kind: 'unavailable', reason: target.unavailable }
  return cancelHeadlessTurn({
    url: target.url,
    conversationId: row.conversationId,
    turnId: row.id,
    headers: {
      ...turnContextHeaders(
        { organizationId: row.organizationId, userId: row.requestedBy, conversationId: row.conversationId },
        { issuedAt: Date.now(), secret: target.secret },
      ),
      ...HEADLESS_MODE_HEADERS,
    },
  })
}

/**
 * Stop the ask's turn; the answer is the ask ended `canceled`, or a conflict.
 * An ask that already ended is a conflict (A2A `TaskNotCancelableError`). A
 * `submitted` ask is ended first, so a start still under way sends no turn
 * (`startTurn` reads the row again before it sends); the stop then goes out in
 * case the turn was sent already. A stop the server took ends the ask
 * `canceled` once the turn reports it, or after {@link CANCEL_WAIT_MS} if it
 * has not; a turn that is not running is ended here.
 */
export async function cancelAsk(session: AuthorizedSession, id: string): Promise<AskView> {
  const row = await requireOwnAsk(session, id)
  if (isTerminalAskState(row.state)) {
    throw new ConflictError(`The ask has already ended (${row.state}).`, { reason: 'piloti-ask-ended' })
  }
  if (row.state === 'submitted') await endAsk(row.organizationId, row.id, { state: 'canceled' })
  const outcome = await stopTurn(row)
  if (outcome.kind === 'not_running') await endAsk(row.organizationId, row.id, { state: 'canceled' })
  const refused = outcome.kind === 'unavailable' || outcome.kind === 'rejected'
  if (refused && row.state !== 'submitted') {
    const why = outcome.kind === 'rejected' ? outcome.code : outcome.reason
    throw new ConflictError(`The ask could not be stopped: ${why}`, { reason: 'agent-ask-cancel-failed' })
  }
  const current = (await findAsk(row.organizationId, row.id)) ?? row
  let settled = await waitForEnd(current, Date.now() + CANCEL_WAIT_MS)
  if (!isTerminalAskState(settled.state)) {
    // The server took the stop; the turn's own notice is late. The first final word stands.
    settled = (await endAsk(row.organizationId, row.id, { state: 'canceled' })) ?? (await findAsk(row.organizationId, row.id)) ?? settled
  }
  return viewOf(session, settled)
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
