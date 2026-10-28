/**
 * useWebSocketChat: the chat socket's driver (docs/design/chat-wire-v2.md §e.2,
 * §e.3).
 *
 * The socket (`createTurnSocket`) connects, reconnects and re-attaches; the
 * fold (`foldTurnEvent`, through the store's `applyTurnEvents`) is the one
 * reader of what it carries. What is left here is the driver between them:
 *
 * - **Sending.** A question is a `user_message` whose `message_id` is the
 *   question's own id, which the server makes the turn id. It is resent on
 *   every reopen until its `RUN_STARTED` acknowledges it; a resend the server
 *   already holds is refused as `duplicate_turn` and attached instead.
 * - **Every question ends.** The server answers a question within
 *   {@link ACK_TIMEOUT_MS} (`RUN_STARTED`, a refusal, any frame of its turn),
 *   or the open socket is dropped and reopened, which sends it again. A second
 *   miss fails the turn with `agent.no_response` and its Retry. A running turn the
 *   watchdog finds silent on {@link SILENT_DROPS_BEFORE_GIVING_UP} sockets in
 *   a row, with nothing folded in between, is ended too. Nothing waits on
 *   silence: a spinner that cannot end is the one failure this file exists to
 *   rule out. A deadline that ran while the page was hidden or offline (a
 *   locked phone) measured the page, not the server, and starts again.
 * - **Folding.** An answer delta waits for the next {@link DELTA_FLUSH_MS}
 *   flush; any other event flushes at once, so a step, a card or the terminal
 *   is never held behind prose.
 * - **One cursor.** The socket re-attaches every turn the store's views hold
 *   open (`openTurns`): a running turn from its last seq, and a finished one
 *   until its stages have landed or the server's stage TTL has passed. A gap
 *   in a turn's seq is attached from the last seq folded.
 * - **Steering.** While the asker's own turn runs, what they type is a
 *   `steer` for it, not a question: the server puts it in the turn's inbox
 *   (`steer_received`) and the graph reads it before its next round
 *   (`steer_applied`). It is offered only when the hello names `steer`. A note
 *   the turn never read (it arrived while the turn was writing its answer, or
 *   the server refused it) is asked as the next question once the turn has
 *   ended, unless the asker stopped the turn.
 * - **Ending.** Stop is `cancel_turn`; the partial answer stays, marked
 *   stopped, and the cancel says how much of it was on screen (`shown`), so
 *   the row the server stores is that text too. A turn the stream no longer
 *   holds asks the server for the finished answer before anything else, and
 *   the words already on screen stay there while it does
 *   ({@link endInterruptedTurn}). Close code 4426, or a frame this bundle
 *   cannot read, is a reload notice; a server that never says hello is
 *   `connection.server_incompatible`.
 * - **The network is not the turn.** A socket that is offline, or that gave up
 *   on a network that does not answer, ends no turn: the server runs and
 *   stores it whether or not anyone listens, so the turn keeps its words and
 *   its cursor, and the socket that reopens (the page back, the network back,
 *   the recovery poll) attaches it from its last seq. The status dock says
 *   meanwhile that the connection is down and that Piloti carries on.
 *
 * A deep-research run is a message in the thread (ADR-0062); its block follows
 * the run's own stream (`features/runs/hooks/use-run-ledger.ts`).
 */

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { useShallow } from 'zustand/react/shallow'
import { useTranslations } from '@/i18n'
import { chatCopy } from '@/i18n/namespaces/chat'
import { useAuth } from '@/adapters/auth'
import { createTurnSocket, type OpenTurn } from '@/adapters/api/turn-socket'
import { browserPageLifecycle, isActive, sleptThrough } from '@/adapters/api/page-lifecycle'
import type { ClientMessage, ShownAnswer, WireEvent } from '@/adapters/api/wire-v2'
import { checkBackendHealthCached, invalidateHealthCache } from '@/shared/hooks/use-backend-health'
import { useThreadSharing } from '@/shared/collaboration/thread-sharing'
import type { AddresseeSet } from '@/lib/mentions/types'
import { useChatStore } from '../store'
import { mapServerMessagesToChatMessages } from '../lib/server-message-mapper'
import { isTransientConnectionError } from '@/features/layout/lib/thread-phase'
import { registerStopStreamingHandler, runningTurnIn } from '../stores/messages-store'
import { useConnectionRecovery } from './use-connection-recovery'
import { useEffortStore } from '../stores/effort-store'
import { capturePosthog } from '@/lib/analytics/posthog'
import type { ChatEffort } from '@/lib/reasoning-settings/catalog'
import { useLayoutStore } from '@/features/layout/store'
import { useDocumentsStore } from '@/features/documents/store'
import { getPosthogSessionId } from '@/lib/analytics/posthog'
import { fetchRunMessage } from '../lib/commissioned-run'
import {
  clampFocusRegion,
  openCanvasFocus,
  registerCanvasChatSender,
  registerCanvasChatSteerer,
  type CanvasFocus,
  type CanvasFocusRegion,
} from '../lib/canvas-bridge'
import { STAGE_COUNT } from '../lib/turn-projection'
import { runErrorCard, type RunErrorCard } from '../lib/run-error'
import { isSteerRead, type TurnView } from '../lib/turn-fold'
import {
  dropViewerActions,
  newViewerActions,
  proposeViewerAction,
  releaseViewerActions,
  viewerClientTools,
} from '../lib/viewer-actions'
import type { DocumentVersionState } from '@/lib/documents/lifecycle-types'
import type { ChatMessage, Conversation, PendingInteraction } from '../types'

/** A mention as the composer holds it: the structured target plus its text token. */
export interface SendMessageMention {
  targetId: string
  display: string
}

export interface SendMessageOptions {
  /**
   * Mentions chosen from the `@` picker (spec MN-3). Their presence switches the
   * send onto the addressee path: persistence is awaited and the SERVER decides
   * whether the agent answers.
   */
  mentions?: readonly SendMessageMention[]
  /** The asker's question, carried into the recipient's inbox item (spec MN-12). */
  mentionNote?: string | null
  /**
   * The thread is visibly waiting on a named person (an `open` mention request).
   *
   * A plain message in that state is a remark to the people in the thread, not a
   * question for the agent (ADR-0034 addendum) — so it must go down the same
   * awaited-persist path as a mention and let the SERVER rule on it. This flag only
   * decides whether the ruling is ASKED FOR; it never decides what the ruling is,
   * so a stale read costs a round trip and nothing else.
   */
  awaitingHuman?: boolean
  /**
   * Run THIS turn at a level other than the chat's Aufwand dial, without
   * touching the dial (`effort-store.ts`): the "answer again, more thoroughly"
   * retry under a down-voted answer.
   */
  reasoningEffort?: ChatEffort
  /**
   * Asked on the review canvas over this chat (`lib/canvas-bridge.ts`): the
   * document and the box the question is about, in place of the composer's
   * subject, and whether Piloti answers in an Anmerkung's thread.
   */
  canvas?: CanvasFocus
}

/** A refusal the composer can localise from `details.reason`. */
export interface SendMessageFailure {
  reason: string | null
  message: string | null
  /** The mention target the refusal names, when the server supplied one. */
  targetId?: string | null
}

/** What a mention send resolves to — the server's ruling, or why it was refused. */
export interface SendMessageOutcome {
  ok: boolean
  /** The server's addressee ruling (spec MN-1/MN-2), when it answered. */
  addressees?: AddresseeSet
  failure?: SendMessageFailure
}

/** Read the standard error envelope so the composer can name the reason. */
async function readSendFailure(response: Response): Promise<SendMessageFailure> {
  try {
    const body = (await response.json()) as {
      error?: string
      details?: { reason?: string; targetId?: string } | null
    }
    return {
      reason: body.details?.reason ?? null,
      message: body.error ?? null,
      targetId: body.details?.targetId ?? null,
    }
  } catch {
    return { reason: null, message: null }
  }
}

/**
 * Pull this message's addressee ruling out of the persist response.
 *
 * `POST /api/conversations/:id/messages` answers with the persisted rows (an array,
 * even for one message), each carrying `addressees`. A row that is missing means the
 * insert conflicted — i.e. something else already wrote this id — and the ruling is
 * then NOT ours to act on, so it comes back null and no turn is opened.
 */
function readAddresseeRuling(body: unknown, messageId: string): AddresseeSet | null {
  const rows = (Array.isArray(body) ? body : [body]) as Array<{
    id?: string
    addressees?: AddresseeSet
  } | null>
  const row = rows.find((entry) => entry?.id === messageId) ?? null
  const addressees = row?.addressees
  if (!addressees || typeof addressees.agent !== 'boolean' || !Array.isArray(addressees.users)) {
    return null
  }
  return addressees
}

/**
 * Append a user message to the thread WITHOUT persisting it.
 *
 * Deliberately not `addUserMessage`, and this is the one subtle thing about the
 * mention path. `addUserMessage` persists fire-and-forget, WITHOUT the mentions —
 * and the server's ruling only comes back on the request that CREATES the row: a
 * second POST for the same id reads the first ruling back and drops the mentions
 * (`prepareMessage`, `lib/conversations/service.ts`). Letting the store's POST race
 * ours would therefore, whenever it won, store the message as "addressed to the
 * agent", create no request, notify nobody — and silently swallow the mention. So
 * the mention path owns the persist (awaited, with the mentions, with the id it
 * generated) and writes the echo straight into the thread here.
 *
 * `setState` is guarded because suites that mock the store wholesale do not supply
 * it; the send then still resolves, it simply renders nothing locally.
 */
function appendLocalUserMessage(message: ChatMessage): void {
  const store = useChatStore as unknown as {
    getState: () => { currentConversation: Conversation | null; conversations: Conversation[] }
    setState?: (
      partial: Partial<{ currentConversation: Conversation | null; conversations: Conversation[] }>
    ) => void
  }
  const { currentConversation, conversations } = store.getState()
  if (!currentConversation || typeof store.setState !== 'function') return

  const updated: Conversation = {
    ...currentConversation,
    // First message names the session, exactly like the store's own path does.
    title: currentConversation.title || message.content.trim().slice(0, 50),
    messages: [...currentConversation.messages, message],
    updatedAt: new Date(),
  }
  store.setState({
    currentConversation: updated,
    conversations: conversations.map((conversation) =>
      conversation.id === updated.id ? updated : conversation
    ),
  })
}

/**
 * How often buffered answer deltas reach the store while an answer streams.
 * Each flush re-renders everything subscribed to the open conversation; once
 * per animation frame, that was a 50–70 ms task every few frames on a 4×
 * throttled CPU. What the reader sees is paced separately (`usePacedText`),
 * so the flush can be this coarse without the text arriving in steps.
 */
export const DELTA_FLUSH_MS = 100

/**
 * How long the server keeps a finished turn's sequencer for its stages
 * (`STAGE_WIRE_TTL_S`, chat-wire-v2.md §c). Past it no stage can arrive, so
 * the turn is not attached again.
 */
const STAGE_WIRE_TTL_MS = 10 * 60_000

/**
 * `auth_expired` refusals in a row before the reader is asked to sign in
 * again. One is a token that expired under an open socket, and the reconnect
 * that refreshes it is the fix; a run of them is a token that does not
 * refresh, and reconnecting forever would hide that behind a spinner.
 */
const MAX_CONSECUTIVE_AUTH_EXPIRED = 3

/** Client messages that may wait for a socket; a burst of context lines is bounded, the oldest goes. */
const MAX_WAITING = 8

/**
 * How long a question may go unanswered. The server sends `RUN_STARTED`
 * before any setup I/O (`ChatSocket.on_user_message`), so on a socket that
 * said hello the acknowledgement is one round trip away; fifteen seconds is
 * room for a cold connect (auth refresh, the gateway's scope lookup, the
 * hello) on a slow network, and short enough that a reader who sees nothing
 * happen is told why within half a minute.
 */
export const ACK_TIMEOUT_MS = 15_000

/**
 * Deadlines a question may miss. The first reopens the socket, since a
 * rolling deploy may have left it on a pod that is going away; the second
 * ends the turn with an error the reader can retry.
 */
const ACK_MISSES_BEFORE_GIVING_UP = 2

/**
 * Sockets in a row the watchdog may drop for one running turn's silence, with
 * nothing of that turn folded in between, before the turn is ended. A healthy
 * turn beats every 20 s, so two is two minutes of a turn saying nothing across
 * two connections: its owner is gone, and reopening again would only restart
 * the wait.
 */
const SILENT_DROPS_BEFORE_GIVING_UP = 2

type Rejection = Extract<WireEvent, { type: 'CUSTOM'; name: 'rejected' }>
/** A `user_message` as the client builds it (its `type` has a default, so it is optional here). */
type UserMessage = Extract<ClientMessage, { message_id: string }>

/** What the driver needs from the hook: the reader-facing half of a failure. */
interface DriverHooks {
  refreshAuth: () => Promise<void>
  /** The socket opened or closed; `steerOffered`: its server reads `steer` (the hello named it). */
  onConnected: (connected: boolean, steerOffered: boolean) => void
  /**
   * The socket gave up reconnecting: say why, if the reason can be found.
   * `network` when it was the connection (the turns wait for it to come back),
   * `other` when waiting will not help (a budget, an expired session).
   */
  onGaveUp: () => Promise<'network' | 'other'>
  /** The browser is offline: the status dock says so until a socket opens. */
  onOffline: () => void
  /** The job queue refused the turn: a warning the reader can act on. */
  onQueueFull: (text: string, retryAfterSeconds: number | null) => void
}

export interface TurnDriver {
  conversationId: string
  projectId: string | undefined
  connect: () => Promise<void>
  close: () => void
  /** Put a question on the wire, and keep it there until the server acknowledges it. */
  ask: (message: UserMessage) => void
  /** Send now, or as soon as there is a socket. */
  deliver: (message: ClientMessage) => void
  /**
   * Stop a turn: what arrived for it is folded first, so the socket's cursor
   * is past it. `shown` is what the asker had on screen; the socket leaves it
   * out for a server that does not read it (`forServer`).
   */
  cancel: (turnId: string, shown?: ShownAnswer) => void
  /**
   * A note for the running turn `turnId`. False when this socket's server does
   * not read `steer` (the caller keeps the text). Once taken, the note is
   * either read by the turn or, unread when the turn ends, handed to
   * `onLeftover`: the next question. A turn the asker stopped drops it.
   */
  steer: (turnId: string, text: string, options?: SteerOptions) => boolean
}

/** What a steering note carries beyond its text, and what becomes of it if the turn never reads it. */
export interface SteerOptions {
  /** A box drawn on the canvas while Piloti works. */
  focusRegion?: CanvasFocusRegion | null
  /** The note was never read: ask it as the next question. */
  onLeftover?: (text: string) => void
}

/** A note this page sent, until its turn ends. */
interface SentSteer {
  turnId: string
  text: string
  onLeftover?: (text: string) => void
}

const store = () => useChatStore.getState()

/** The subject's version state, when it is an OPEN version: the one retrieval cannot see, read as bytes instead. */
const openVersionState = (state: DocumentVersionState | null | undefined): UserMessage['focus_version_state'] =>
  state === 'draft' || state === 'in_review' || state === 'changes_requested' ? state : null

/** Turns being ended by {@link endInterruptedTurn}: neither attached again nor ended twice. */
const ending = new Set<string>()

/** The answer the turn has drawn so far, when it has drawn any words. */
const partialAnswerOf = (view: TurnView): ChatMessage | undefined => {
  if (!view.messageId) return undefined
  const { currentConversation, conversations } = store()
  const owner =
    currentConversation?.id === view.conversationId
      ? currentConversation
      : conversations.find((conversation) => conversation.id === view.conversationId)
  return owner?.messages.find(
    (message) => message.id === view.messageId && message.isStreaming && message.content.trim().length > 0
  )
}

/**
 * The answer the server stored for this turn, under the id its `RUN_STARTED`
 * named (`turnAnswerId`): null when it holds none, undefined when it could not
 * be asked.
 */
const storedAnswerOf = async (view: TurnView): Promise<ChatMessage | null | undefined> => {
  if (!view.messageId) return null
  try {
    const { conversationsClient } = await import('@/adapters/api/conversations-client')
    const rows = await conversationsClient.listMessages(view.conversationId)
    const answer = mapServerMessagesToChatMessages(rows).find(
      (message) => message.id === view.messageId && message.role === 'assistant'
    )
    return answer ?? null
  } catch {
    return undefined
  }
}

/** The turn's question is still the newest one in its thread: an answer put back lands under it. */
const isNewestQuestion = (view: TurnView): boolean => {
  const conversation = store().currentConversation
  if (conversation?.id !== view.conversationId) return false
  return conversation.messages.findLast((message) => message.messageType === 'user')?.id === view.turnId
}

/**
 * Ask the server for the answer while waiting on it shows the calm „Antwort
 * wird geholt", and only when it confirms it has none say so. `partial` is
 * what the reader had read: put back, dimmed, above the card, rather than
 * taken away with the turn.
 */
const awaitLostTurn = (view: TurnView, partial?: ChatMessage): void => {
  store().dropTurn(view.turnId)
  void store()
    ._awaitServerAnswer(view.conversationId, view.turnId)
    .then((outcome) => {
      if (outcome !== 'nothing' || store().currentConversation?.id !== view.conversationId) return
      if (partial && isNewestQuestion(view)) {
        store().adoptRunMessage(view.conversationId, { ...partial, isStreaming: undefined, failed: true })
      }
      store().addErrorCard('agent.response_interrupted')
    })
    .finally(() => ending.delete(view.turnId))
}

/**
 * End a turn this page cannot continue, but ask the server first: the backend
 * finishes and persists a turn whether or not anyone is listening, so the
 * answer may be waiting there. The words already on screen stay while it is
 * asked: the stored answer replaces them in their row, in one frame. Only a
 * server that has no answer and no turn still running earns the banner.
 */
const endInterruptedTurn = (view: TurnView): void => {
  if (ending.has(view.turnId)) return
  ending.add(view.turnId)
  const partial = partialAnswerOf(view)
  if (!partial) return awaitLostTurn(view)
  void storedAnswerOf(view).then((answer) => {
    const now = store().turns[view.turnId]
    // Folded on meanwhile (a socket that reopened attached it after all), or
    // ended by something else: it is not this call's to end.
    // The server could not be asked either (the network went with the
    // socket): the turn stays as it is, and the next socket attaches it.
    if (!now || now.lastSeq !== view.lastSeq || now.phase !== 'running' || answer === undefined) {
      ending.delete(view.turnId)
      return
    }
    if (!answer) return awaitLostTurn(view, partial)
    store().adoptRunMessage(view.conversationId, answer)
    store().dropTurn(view.turnId)
    ending.delete(view.turnId)
  })
}

/**
 * A turn that ended with `RUN_ERROR`, or a question the server never
 * acknowledged: nothing was persisted, but the server is asked once before the
 * banner. What it had written stays on screen, dimmed, with the error card
 * under it (`failTurn`): dropping it deleted the sentence the reader was on in
 * one frame. `card` defaults to the one the turn's `RUN_ERROR` earns.
 */
const endFailedTurn = (view: TurnView, card: RunErrorCard = runErrorCard(view.error)): void => {
  store().failTurn(view.turnId)
  void store()
    ._recoverInterruptedAssistantMessage(view.conversationId, view.turnId)
    .then((outcome) => {
      if (outcome !== 'nothing' || store().currentConversation?.id !== view.conversationId) return
      store().addErrorCard(card.code, card.message, card.details)
    })
}

/** The socket of one conversation and the turns it carries. */
const createTurnDriver = (conversationId: string, projectId: string | undefined, hooks: DriverHooks): TurnDriver => {
  /** Questions not yet acknowledged by their `RUN_STARTED`, by turn id. */
  const unacknowledged = new Map<string, ClientMessage>()
  /** Each unacknowledged question's deadline, and the deadlines it has missed. */
  const ackDeadlines = new Map<string, ReturnType<typeof setTimeout>>()
  const ackMisses = new Map<string, number>()
  /** Per running turn, the sockets dropped in a row for its silence. */
  const silentDrops = new Map<string, number>()
  /** The last answer, cancel or context line sent per turn and type, for a resend after `auth_expired`. */
  const sent = new Map<string, ClientMessage>()
  const waiting: ClientMessage[] = []
  const finishedAt = new Map<string, number>()
  /** The seq each gap was attached from, so one gap is attached once. */
  const gapsAttached = new Map<string, number>()
  let buffer: WireEvent[] = []
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let authExpired = 0
  let socketOpen = false
  /** The notes this page sent, by `steer_id`, until their turn ends. */
  const steers = new Map<string, SentSteer>()
  /**
   * The turns this page asked. Only their viewer actions may move this page's
   * viewer (ADR-0144): a turn attached after a reload, or watched as a
   * spectator, folds the same events and runs none of them.
   */
  const asked = new Set<string>()

  const keyOf = (message: ClientMessage): string =>
    `${message.type}:${'turn_id' in message ? message.turn_id : message.message_id}`

  /** Whether the page can see an attempt through: a deadline that ran while it could not measured nothing. */
  const lifecycle = browserPageLifecycle()

  const openTurns = (): OpenTurn[] => {
    const now = Date.now()
    return Object.values(store().turns).flatMap((view): OpenTurn[] => {
      if (view.conversationId !== conversationId || unacknowledged.has(view.turnId)) return []
      if (ending.has(view.turnId)) return []
      if (view.phase === 'running') return [{ turnId: view.turnId, lastSeq: view.lastSeq }]
      const finished = finishedAt.get(view.turnId)
      const stagesPending =
        view.phase === 'finished' &&
        view.outcome !== 'cancelled' &&
        finished !== undefined &&
        now - finished < STAGE_WIRE_TTL_MS &&
        Object.keys(view.stages).length < STAGE_COUNT
      return stagesPending ? [{ turnId: view.turnId, lastSeq: view.lastSeq, settled: true }] : []
    })
  }

  /** Stop waiting on a question: acknowledged, refused, stopped, or given up. It is not sent again. */
  const forget = (turnId: string): void => {
    unacknowledged.delete(turnId)
    clearTimeout(ackDeadlines.get(turnId))
    ackDeadlines.delete(turnId)
    ackMisses.delete(turnId)
  }

  /** A fresh deadline for a question the server has not answered yet. */
  const awaitAck = (turnId: string): void => {
    clearTimeout(ackDeadlines.get(turnId))
    const armedAt = Date.now()
    ackDeadlines.set(turnId, setTimeout(() => missedAck(turnId, armedAt), ACK_TIMEOUT_MS))
  }

  function missedAck(turnId: string, armedAt: number): void {
    ackDeadlines.delete(turnId)
    if (!unacknowledged.has(turnId)) return
    // Hidden, offline, or frozen under the deadline (a locked phone fires it
    // late, on its return): the server was never given the chance. The
    // question goes out on the socket that opens when the page is back.
    if (!isActive(lifecycle) || sleptThrough(armedAt, ACK_TIMEOUT_MS)) return awaitAck(turnId)
    const misses = (ackMisses.get(turnId) ?? 0) + 1
    if (misses >= ACK_MISSES_BEFORE_GIVING_UP) {
      forget(turnId)
      // Failed, not interrupted: the header says „Fehlgeschlagen“, and the card
      // says the question went unanswered rather than that the agent erred.
      const view = store().turns[turnId]
      if (view?.phase === 'running') endFailedTurn(view, { code: 'agent.no_response' })
      return
    }
    ackMisses.set(turnId, misses)
    // An open socket that did not answer is reopened, and the question goes
    // out again on the new one; a socket still connecting is left to its ladder.
    if (socketOpen) socket.reconnect()
    awaitAck(turnId)
  }

  /** The watchdog found these turns silent on this socket: one more strike each, and the last ends the turn. */
  const silent = (turnIds: readonly string[]): void => {
    flush()
    for (const turnId of turnIds) {
      const drops = (silentDrops.get(turnId) ?? 0) + 1
      silentDrops.set(turnId, drops)
      const view = store().turns[turnId]
      if (drops < SILENT_DROPS_BEFORE_GIVING_UP || view?.phase !== 'running') continue
      silentDrops.delete(turnId)
      endInterruptedTurn(view)
    }
  }

  const socket = createTurnSocket({
    conversationId,
    projectId,
    openTurns,
    refreshAuth: hooks.refreshAuth,
    onEvent: (event) => receive(event),
    onSilent: silent,
    onStatus: (status) => {
      socketOpen = status === 'open'
      hooks.onConnected(socketOpen, socketOpen && socket.accepts('steer'))
      if (status === 'open') opened()
      else if (status === 'offline') hooks.onOffline()
      else if (status === 'failed' || status === 'incompatible' || status === 'outdated') gaveUp(status)
    },
  })

  const deliver = (message: ClientMessage): void => {
    if (message.type !== 'user_message' || message.context_only) sent.set(keyOf(message), message)
    if (socket.send(message)) return
    waiting.push(message)
    if (waiting.length > MAX_WAITING) waiting.shift()
  }

  const opened = (): void => {
    invalidateHealthCache()
    store().dismissConnectionErrors()
    for (const message of unacknowledged.values()) socket.send(message)
    for (const message of waiting.splice(0)) deliver(message)
  }

  const runningTurns = (): TurnView[] =>
    Object.values(store().turns).filter((view) => view.conversationId === conversationId && view.phase === 'running')

  /** Nothing this socket carries will reach a server: stop waiting on it, and ask for each answer instead. */
  const endEverything = (): void => {
    flush()
    for (const turnId of [...unacknowledged.keys()]) forget(turnId)
    waiting.length = 0
    for (const view of runningTurns()) endInterruptedTurn(view)
  }

  const gaveUp = (status: 'failed' | 'incompatible' | 'outdated'): void => {
    if (status === 'outdated') store().addErrorCard('connection.client_outdated')
    else if (status === 'incompatible') store().addErrorCard('connection.server_incompatible')
    if (status !== 'failed') return endEverything()
    // The network: every turn stays as it is, its question unanswered or its
    // answer half drawn, and is attached when a socket opens again. Ending it
    // here asked a server this page could not reach, and told the reader
    // their answer was lost while the server was writing it.
    void hooks.onGaveUp().then((cause) => {
      if (cause === 'other' && !socketOpen) endEverything()
    })
  }

  /**
   * The turn ended: each note this page sent it that it never read becomes the
   * next question, after the fold that ended it. A Stop drops them: the asker
   * ended the turn, and a question nobody asked for would start another.
   */
  const settleSteers = (view: TurnView): void => {
    for (const [steerId, note] of [...steers]) {
      if (note.turnId !== view.turnId) continue
      steers.delete(steerId)
      if (isSteerRead(view, steerId) || view.outcome === 'cancelled') continue
      const leftover = note.onLeftover
      if (leftover) setTimeout(() => leftover(note.text), 0)
    }
  }

  /** What a folded turn asks of the page beyond its messages. */
  const react = (previous: TurnView | undefined, view: TurnView | undefined): void => {
    if (!view) return
    if (asked.has(view.turnId) && view.messageId) {
      // Held while the turn runs; nothing moves before the answer is on screen (ADR-0144).
      for (const call of newViewerActions(previous?.viewerActions, view.viewerActions)) {
        proposeViewerAction(view.messageId, call)
      }
      const ended = view.phase !== 'running' && (previous === undefined || previous.phase === 'running')
      // An answer releases them; an error, a Stop, a refusal or a hand-off drops them. A retracted
      // stream is a round, not the answer (`answer_retracted`), so it neither releases nor drops.
      if (ended && view.phase === 'finished' && view.outcome === 'answered' && view.text) {
        void releaseViewerActions(view.messageId)
      } else if (ended) {
        dropViewerActions(view.messageId)
      }
    }
    if (view.phase !== 'running' && previous?.phase === 'running') settleSteers(view)
    if (view.gap && gapsAttached.get(view.turnId) !== view.lastSeq) {
      gapsAttached.set(view.turnId, view.lastSeq)
      socket.send({ type: 'attach', conversation_id: conversationId, turn_id: view.turnId, after_seq: view.lastSeq })
    }
    if (view.phase === 'failed' && previous?.phase !== 'failed') endFailedTurn(view)
    const result = view.result
    if (!result || result === previous?.result) return
    if (result.job_admission_rejected) hooks.onQueueFull(result.text, result.retry_after_seconds)
    // The turn commissioned a run (ADR-0062): its message already exists. The
    // projection drew a provisional block in the answer's row in the same
    // frame; the stored message (its title, its first ledger frame) replaces
    // it there, and the block follows the run's own stream either way.
    const run = result.run
    if (run) {
      void fetchRunMessage(conversationId, run.run_message_id).then((message) => {
        if (message) store().adoptRunMessage(conversationId, message)
      })
    }
  }

  const flush = (): void => {
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = null
    const events = buffer
    buffer = []
    if (events.length === 0) return
    const before = store().turns
    store().applyTurnEvents(events)
    const after = store().turns
    for (const turnId of new Set(events.map((event) => event.turn_id))) react(before[turnId], after[turnId])
  }

  /** The stream holds nothing of this turn: ask the server for its answer, or forget a finished one. */
  const lost = (turnId: string): void => {
    // What arrived for it is on screen first: those are the words kept while the server is asked.
    flush()
    forget(turnId)
    const view = store().turns[turnId]
    if (view?.phase === 'running') endInterruptedTurn(view)
    else if (view) store().dropTurn(turnId)
  }

  const rejected = ({ turn_id: turnId, value }: Rejection): void => {
    const view = store().turns[turnId]
    // A refused note never ends or loses its turn. It stays this page's, unread:
    // it is asked as the next question when the turn ends, or now if it already has.
    if (value.of === 'steer' && value.code !== 'auth_expired') {
      if (view && view.phase !== 'running') settleSteers(view)
      return
    }
    switch (value.code) {
      case 'auth_expired': {
        authExpired += 1
        if (authExpired > MAX_CONSECUTIVE_AUTH_EXPIRED) {
          authExpired = 0
          store().addErrorCard('auth.session_expired')
          forget(turnId)
          // What was drawn stays, dimmed: the server cannot be asked for the
          // rest until the reader signs in again.
          if (view?.phase === 'running') store().failTurn(turnId)
          return
        }
        // The socket's token expired under it. A reconnect refreshes it, and
        // the refused message goes out again on the new socket.
        const refused = sent.get(`${value.of}:${turnId}`)
        if (refused) waiting.push(refused)
        socket.close()
        void socket.connect()
        return
      }
      case 'duplicate_turn':
        // The server has the question already: follow it instead of asking again.
        forget(turnId)
        socket.send({ type: 'attach', conversation_id: conversationId, turn_id: turnId, after_seq: view?.lastSeq ?? 0 })
        return
      case 'turn_not_found':
        // A Stop the server no longer had a turn for: it finished first, and
        // stored the whole answer. Keep the one on screen before the turn goes.
        if (value.of === 'cancel_turn') store().keepStoppedAnswer(turnId)
        return lost(turnId)
      case 'conversation_mismatch':
      case 'invalid_message':
        // A resume or a Stop the server could not take leaves the turn with
        // nobody following it: the same as a turn the stream no longer holds.
        if (value.of === 'attach' || value.of === 'cancel_turn') return lost(turnId)
        if (value.of !== 'user_message') return
        forget(turnId)
        store().dropTurn(turnId)
        store().addErrorCard('agent.response_failed', value.message ?? undefined)
        return
      case 'not_asker':
      case 'no_pending_interaction':
        // A Stop of someone else's turn, or an answer to a question already
        // closed: the turn itself says what happens next.
        return
    }
  }

  function receive(event: WireEvent): void {
    // Anything the server says of a question is an answer: the socket works.
    if (unacknowledged.has(event.turn_id)) {
      ackMisses.delete(event.turn_id)
      awaitAck(event.turn_id)
    }
    if (event.type === 'CUSTOM' && event.name === 'rejected') return rejected(event)
    silentDrops.delete(event.turn_id)
    if (event.type === 'RUN_STARTED') {
      forget(event.turn_id)
      authExpired = 0
    }
    // This page's clock, like the TTL it is measured against: `ts` is the server's.
    if (event.type === 'RUN_FINISHED') finishedAt.set(event.turn_id, Date.now())
    buffer.push(event)
    if (event.type !== 'TEXT_MESSAGE_CONTENT') flush()
    else flushTimer ??= setTimeout(flush, DELTA_FLUSH_MS)
  }

  return {
    conversationId,
    projectId,
    connect: socket.connect,
    close: () => {
      flush()
      for (const turnId of [...unacknowledged.keys()]) forget(turnId)
      socket.close()
    },
    ask: (message) => {
      asked.add(message.message_id)
      unacknowledged.set(message.message_id, message)
      awaitAck(message.message_id)
      // No socket to take it: open one (a new ladder, if the last one gave up).
      if (!socket.send(message)) void socket.connect()
    },
    deliver,
    cancel: (turnId, shown) => {
      flush()
      // A Stop before RUN_STARTED: the question is not asked again on a reopen.
      forget(turnId)
      deliver({ type: 'cancel_turn', conversation_id: conversationId, turn_id: turnId, ...(shown && { shown }) })
    },
    steer: (turnId, text, options) => {
      if (!socket.accepts('steer')) return false
      const steerId = uuidv4()
      const message: ClientMessage = {
        type: 'steer',
        conversation_id: conversationId,
        turn_id: turnId,
        steer_id: steerId,
        text,
        ...(options?.focusRegion ? { focus_region: clampFocusRegion(options.focusRegion) } : {}),
      }
      steers.set(steerId, { turnId, text, onLeftover: options?.onLeftover })
      sent.set(keyOf(message), message)
      // Not queued for a later socket: a note that cannot go now is asked as
      // the next question when its turn ends, which `settleSteers` does.
      socket.send(message)
      return true
    },
  }
}

/**
 * Message kinds that count as "part of the conversation" when deciding whether a
 * turn is still open. Mirrors `restoreSessionState`'s own `meaningfulTypes` set
 * (sessions-store) on purpose: the two are answering the same question — "is the
 * last thing in this thread an unfinished turn?" — and they must not disagree.
 */
const MEANINGFUL_MESSAGE_TYPES = new Set(['user', 'assistant', 'agent_response', 'error', 'prompt'])

interface UseWebSocketChatOptions {
  /** Auto-connect on mount (default: true) */
  autoConnect?: boolean
  /**
   * Whether collaboration is reachable for this org (the dark-launch flag).
   *
   * **Defaults to false, and false means "exactly today"** (spec NF-8): the socket
   * opens on mount, before the user has done anything, with no request in front of
   * it. Only with the flag ON does the socket wait to learn whether the thread is
   * shared — see `socketPermitted` below for why that is not a latency cost for
   * private threads either.
   */
  canCollaborate?: boolean
}

/** Steer the running turn with a note, for the composer and the canvas. */
export interface SteerRequest {
  text: string
  focusRegion?: CanvasFocusRegion | null
  /** What to do with a note the turn never read; by default it is asked as the next question. */
  onLeftover?: (text: string) => void
}

interface UseWebSocketChatReturn {
  /**
   * Send a message. With nothing tagged and no hand-off open this returns
   * `false` when there was nothing to send (so the caller can keep the input).
   * With mentions, or with `awaitingHuman`, it returns a promise carrying the
   * server's addressee ruling: the agent answers only if that ruling says so
   * (ADR-0034 §4), and is DELIVERED the message either way, as context when it
   * is not the addressee. Plus a localisable `failure` when the send was refused.
   */
  sendMessage: (content: string, options?: SendMessageOptions) => boolean | Promise<SendMessageOutcome>
  /** Answer the open question: typed text, or a `choice` prompt's option id. */
  respondToInteraction: (response: string) => void
  /**
   * Declare that the user means to write something (composer focus, or a send).
   *
   * In a **shared** thread this is what opens the agent socket, because merely
   * opening the thread must not (ADR-0033 §7: a participant who did not start a
   * turn observes it over the SSE channel and needs no socket). Idempotent, and a
   * no-op wherever the socket is already permitted — so a private thread and a
   * gated org never reach it.
   */
  noteSendIntent: () => void
  /** The question is sent and the server has not acknowledged it yet. */
  isLoading: boolean
  /** The question the agent is waiting on. */
  pendingInteraction: PendingInteraction | null
  /**
   * Put a note into the asker's running turn (`steer`). False when there is no
   * running turn in this conversation or its server does not read notes; the
   * caller then keeps the text.
   */
  steer: (request: SteerRequest) => boolean
  /** The open socket's server reads notes: while a turn runs, the composer steers it. */
  canSteer: boolean
}

/**
 * Ask the same-origin diagnostics endpoint whether a failed socket was a
 * budget block the browser could not read from the collapsed upgrade. The
 * localized banner message (admin or member copy) when it was, null for any
 * other cause or on error. Never throws.
 */
const discoverBudgetFailureMessage = async (t: ReturnType<typeof useTranslations>): Promise<string | null> => {
  try {
    const activeProjectId = useChatStore.getState().projectId
    const query = activeProjectId ? `?projectId=${encodeURIComponent(activeProjectId)}` : ''
    const res = await fetch(`/api/auth/connection-diagnostics${query}`, {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    })
    if (!res.ok) return null
    const body = (await res.json()) as { budgetExhausted?: boolean; canManageBudgets?: boolean }
    if (!body.budgetExhausted) return null
    return body.canManageBudgets ? t('budgetExhausted.adminMessage') : t('budgetExhausted.memberMessage')
  } catch {
    return null
  }
}

/**
 * Is the newest thing in this thread an unfinished turn that belongs to ME?
 *
 * "Mine" is `authorUserId === currentUserId`, or absent — a solo thread renders
 * no attribution and writes no author, so absent means "there is only me".
 * An unresponded HITL prompt counts: the thread is paused on an answer only this
 * browser can give. So does a still-`isStreaming` assistant message. A reload
 * no longer restores one (the storage drops an interrupted answer, and the
 * question it answers is then the newest turn), but a socket that drops
 * mid-answer without a reload leaves exactly that.
 */
const ownsUnansweredTurnIn = (
  messages: ChatMessage[] | undefined,
  currentUserId: string | null
): boolean => {
  if (!messages?.length) return false
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (!MEANINGFUL_MESSAGE_TYPES.has(message.messageType ?? '')) continue
    if (message.messageType === 'prompt') return !message.isPromptResponded
    if (message.messageType === 'user') {
      return !message.authorUserId || message.authorUserId === currentUserId
    }
    // An assistant/error message closes the turn — unless it is the partial
    // bubble a refresh interrupted, which is exactly a turn to reattach to.
    return message.isStreaming === true
  }
  return false
}

export const useWebSocketChat = (options: UseWebSocketChatOptions = {}): UseWebSocketChatReturn => {
  const { autoConnect = true, canCollaborate = false } = options
  const { user, authRequired, isLoading: authLoading, getAccessToken } = useAuth()
  const tChat = useTranslations(chatCopy)

  // The conversation's id and whether its newest turn is mine, not the
  // conversation itself: the conversation is a new object on every flush,
  // and this hook's host (the composer) would re-render with each one.
  const { currentConversationId, ownsUnansweredTurn, isLoading, pendingInteraction, resumableTurn } =
    useChatStore(
      useShallow((s) => ({
        currentConversationId: s.currentConversation?.id,
        ownsUnansweredTurn: ownsUnansweredTurnIn(s.currentConversation?.messages, s.currentUserId),
        isLoading: s.isLoading,
        pendingInteraction: s.pendingInteraction,
        resumableTurn: s.resumableTurn,
      }))
    )
  const projectId = useChatStore((s) => s.projectId) || undefined
  const addUserMessage = useChatStore((s) => s.addUserMessage)
  const addErrorCard = useChatStore((s) => s.addErrorCard)
  const respondToPrompt = useChatStore((s) => s.respondToPrompt)
  const setCurrentUser = useChatStore((s) => s.setCurrentUser)

  useEffect(() => {
    setCurrentUser(user?.id ?? null)
  }, [user?.id, setCurrentUser])

  /* ────────────────────────────────────────────────────────────────────────────
   * MAY THIS BROWSER HOLD AN AGENT SOCKET FOR THIS CONVERSATION?
   *
   * The agent tier's socket registry keys live sockets by conversation_id, so a
   * second socket on the same conversation REPLACES the first. For one user reconnecting
   * that is the feature. For two participants in a shared thread it is a defect:
   * a reader who merely OPENS the thread takes over the asker's registration, so
   * his answer streams into her connection and disappears from his — and because
   * `clear_socket` is identity-guarded, her leaving unregisters the conversation
   * outright rather than handing it back.
   *
   * The frontend cause is that this hook auto-connected on MOUNT. ADR-0033 §7
   * already decided the shape of the fix: an observer sees turn *state* over the
   * SSE channel ("Piloti is answering Anna's question", then the answer), not
   * token streaming. So a participant who is only reading has no reason to hold a
   * socket, and the connection can follow **intent to send** instead of mounting.
   *
   * Four things open the gate, and the order matters:
   *
   *   1. `!canCollaborate` — the flag is off. Byte-identical to today, evaluated
   *      synchronously on the first render, with no request in front of it (NF-8).
   *      This is the overwhelming majority of usage and it pays nothing.
   *   2. `sharing === 'private'` — the server has said this thread is solo. Also
   *      connect-on-mount. The access read this reads from is the one
   *      `useSharedThread` already issues on open (ADR-0033 §1), so it costs no
   *      extra round trip and it resolves while the thread is still painting —
   *      long before anyone can focus a composer. A private thread therefore
   *      keeps today's first-message latency.
   *   3. `intent` — composer focus (or a send). See `noteSendIntent`.
   *   4. `ownsUnansweredTurn` — this browser is the one waiting on an answer, so
   *      it must reconnect WITHOUT being touched: the new socket `attach`es the
   *      turn, and a refresh mid-answer would otherwise sit there until the user
   *      clicked the composer.
   *
   * `'unknown'` (collaboration on, access read not yet answered) deliberately does
   * NOT open the gate: guessing "private" there would re-open the collision, while
   * guessing "unknown" only defers a connect that (1)-(4) will make anyway.
   *
   * The result is LATCHED per conversation. Once a socket is permitted it stays
   * permitted until the conversation changes, because every input above is
   * transient — `ownsUnansweredTurn` flips false the moment the answer starts
   * arriving, and re-evaluating the gate then would tear down the very socket the
   * answer is streaming on.
   * ──────────────────────────────────────────────────────────────────────────── */
  const threadSharing = useThreadSharing(currentConversationId)

  const socketGateRef = useRef<{
    conversationId: string | undefined
    intent: boolean
    open: boolean
  }>({ conversationId: undefined, intent: false, open: false })

  // Re-render trigger for `noteSendIntent`. The intent itself lives in the ref, not
  // in state, so that switching conversations resets it in the SAME render that
  // resets the latch — a state reset lands one render late, which would let the
  // previous thread's intent open the gate on the new one.
  const [, bumpSocketGate] = useState(0)

  if (socketGateRef.current.conversationId !== currentConversationId) {
    socketGateRef.current = { conversationId: currentConversationId, intent: false, open: false }
  }

  const noteSendIntent = useCallback(() => {
    if (socketGateRef.current.intent) return
    socketGateRef.current.intent = true
    bumpSocketGate((n) => n + 1)
  }, [])

  if (
    !canCollaborate ||
    threadSharing === 'private' ||
    socketGateRef.current.intent ||
    ownsUnansweredTurn
  ) {
    socketGateRef.current.open = true
  }
  const socketPermitted = socketGateRef.current.open

  const driverRef = useRef<TurnDriver | null>(null)
  const [isConnected, setIsConnected] = useState(false)
  const [steerOffered, setSteerOffered] = useState(false)

  /**
   * The reader-facing half of the driver, read through a ref so a socket
   * lives as long as its conversation: AuthKit hands out a new
   * `getAccessToken` whenever its token state changes, and a socket keyed on
   * that identity reconnected all through a streaming answer.
   */
  const isSessionExpired = authRequired && !user && !authLoading
  const hooks: DriverHooks = {
    refreshAuth: async () => {
      if (!authRequired || !getAccessToken) return
      await getAccessToken()
    },
    onConnected: (connected, offered) => {
      setIsConnected(connected)
      setSteerOffered(offered)
    },
    onGaveUp: () => explainConnectionFailure(),
    onOffline: () => {
      // Said once, by the status dock: a transient connection error is not a
      // card in the thread (`isTransientConnectionError`), and the socket that
      // opens again dismisses it.
      if (useChatStore.getState().currentConversation?.messages.some(isTransientConnectionError)) return
      addErrorCard('connection.lost')
    },
    onQueueFull: (text, retryAfter) => {
      // One sentence saying when to resend, in the reader's language. The
      // server's own text is English on one path and carries its own „try
      // again" on the other, so in front of the hint it said it twice; it
      // stays as the details. Without a wait, the registry's message says
      // „in a moment" instead.
      const message = retryAfter
        ? `${tChat('errorRegistry.researchQueueFull.full')} ${tChat('errorRegistry.researchQueueFull.retryHint', { seconds: retryAfter })}`
        : tChat('errorRegistry.researchQueueFull.message')
      addErrorCard('research.queue_full', message, text.trim() || undefined)
    },
  }
  const hooksRef = useRef(hooks)
  useEffect(() => {
    hooksRef.current = hooks
  })

  /**
   * Why the socket gave up. The gateway refuses a budget-exhausted upgrade with
   * a bare failed handshake the browser cannot read, so a same-origin endpoint
   * is asked once per failure episode; then the backend's health separates
   * "down" from a session that drifted.
   */
  const budgetCheckedRef = useRef(false)
  const explainConnectionFailure = async (): Promise<'network' | 'other'> => {
    const conversationId = useChatStore.getState().currentConversation?.id
    const stillHere = () => useChatStore.getState().currentConversation?.id === conversationId
    if (!budgetCheckedRef.current) {
      budgetCheckedRef.current = true
      const budgetMessage = await discoverBudgetFailureMessage(tChat)
      if (!stillHere()) return 'network'
      if (budgetMessage) {
        addErrorCard('budget.exhausted', budgetMessage)
        return 'other'
      }
    }
    const backendUp = await checkBackendHealthCached()
    if (!stillHere()) return 'network'
    const expired = backendUp && isSessionExpired
    addErrorCard(expired ? 'auth.session_expired' : 'connection.failed')
    return expired ? 'other' : 'network'
  }

  /** This conversation's driver, created (and connected) when it has none. */
  const ensureDriver = useCallback((conversationId: string): TurnDriver => {
    const projectId = useChatStore.getState().projectId || undefined
    const current = driverRef.current
    if (current?.conversationId === conversationId && current.projectId === projectId) return current
    current?.close()
    budgetCheckedRef.current = false
    const driver = createTurnDriver(conversationId, projectId, {
      refreshAuth: () => hooksRef.current.refreshAuth(),
      onConnected: (connected, offered) => hooksRef.current.onConnected(connected, offered),
      onGaveUp: () => hooksRef.current.onGaveUp(),
      onOffline: () => hooksRef.current.onOffline(),
      onQueueFull: (text, retryAfter) => hooksRef.current.onQueueFull(text, retryAfter),
    })
    driverRef.current = driver
    void driver.connect()
    return driver
  }, [])

  // One socket per conversation (and project scope): opened once the gate
  // allows it, closed when the conversation changes. A turn running in the
  // conversation left keeps its view, and coming back re-attaches it.
  //
  // "Closed when the conversation changes" is decided by the DRIVER's own
  // conversation, never by the render's. The first question of a new chat
  // creates its conversation inside `sendMessage`, and `ensureDriver` makes
  // that conversation's driver in the same call, holding the question until
  // its RUN_STARTED. A cleanup keyed on the previous render (no conversation
  // yet) closed exactly that driver, and its successor, knowing nothing of the
  // question, attached the turn instead of asking it: the first question was lost.
  useEffect(() => {
    if (currentConversationId && autoConnect && socketPermitted) ensureDriver(currentConversationId)
    const driver = driverRef.current
    if (driver && driver.conversationId !== currentConversationId) {
      driver.close()
      driverRef.current = null
      setIsConnected(false)
      setSteerOffered(false)
    }
  }, [currentConversationId, projectId, autoConnect, socketPermitted, ensureDriver])
  useEffect(
    () => () => {
      driverRef.current?.close()
      driverRef.current = null
    },
    []
  )

  // A turn a reload cut off: once there is a socket, fold it again from its
  // first event. The stream answers with the replay, or with `turn_not_found`,
  // which sends the reader to the server's copy.
  useEffect(() => {
    const driver = driverRef.current
    if (!resumableTurn || !isConnected || driver?.conversationId !== resumableTurn.conversationId) return
    const { turns, beginTurn } = useChatStore.getState()
    if (runningTurnIn(turns, resumableTurn.conversationId)) return
    beginTurn(resumableTurn.conversationId, resumableTurn.turnId)
    driver.deliver({
      type: 'attach',
      conversation_id: resumableTurn.conversationId,
      turn_id: resumableTurn.turnId,
      after_seq: 0,
    })
  }, [resumableTurn, isConnected])

  // Stop: `cancel_turn`, sent now or as soon as the socket is back.
  useEffect(() => {
    registerStopStreamingHandler((turnId, shown) => {
      const conversationId = useChatStore.getState().currentConversation?.id
      if (conversationId) ensureDriver(conversationId).cancel(turnId, shown)
    })
    return () => registerStopStreamingHandler(null)
  }, [ensureDriver])

  const connect = useCallback(() => {
    const conversationId = useChatStore.getState().currentConversation?.id
    if (!conversationId) return
    if (driverRef.current?.conversationId === conversationId) void driverRef.current.connect()
    else ensureDriver(conversationId)
  }, [ensureDriver])
  // Reconnect once the backend is healthy again while a connection error is shown.
  useConnectionRecovery(connect)

  /**
   * Deliver a human message to the agent as CONTEXT ONLY — "always send, never
   * always judge" (ADR-0034 addendum).
   *
   * The hand-off suppresses the agent by not invoking it, which is right about
   * tokens and was wrong about MEMORY: the agent's history is its LangGraph
   * checkpoint, so a turn that never reached it leaves a hole, and `@Piloti given
   * that, recheck` then refers to nothing. This closes the hole without making
   * routing probabilistic — the server already ruled that the agent is not
   * addressed; only DELIVERY changes.
   *
   * No turn is opened for it (no view, no acknowledgement to wait for): the
   * frame is answered by design. Best effort: the message is already persisted
   * in Postgres, so a frame that cannot go out costs the agent a line of memory
   * and the thread nothing. With no socket yet it waits for one, among a
   * bounded few, and is discarded with the conversation if none comes up.
   */
  const deliverAsContext = useCallback(
    (messageId: string, content: string, dataSourcesForMessage: string[] | null): void => {
      const conversationId = useChatStore.getState().currentConversation?.id
      if (!conversationId) return
      // The user just wrote in this thread, so they are not an observer any
      // more: the same intent a composer focus declares.
      noteSendIntent()
      ensureDriver(conversationId).deliver({
        type: 'user_message',
        conversation_id: conversationId,
        message_id: messageId,
        text: content,
        data_sources: dataSourcesForMessage,
        context_only: true,
        author_name: user?.name ?? user?.email ?? null,
      })
    },
    [user?.name, user?.email, ensureDriver, noteSendIntent]
  )

  /**
   * The send metadata both paths need: which sources are live, and which of this
   * session's files are attached.
   */
  const collectSendMetadata = useCallback(() => {
    const layoutState = useLayoutStore.getState()
    const enabledDataSources = layoutState.enabledDataSourceIds

    // Get session files
    const sessionId = useChatStore.getState().currentConversation?.id
    const trackedFiles = useDocumentsStore.getState().trackedFiles
    const sessionFiles = sessionId
      ? trackedFiles.filter(
          (f) =>
            f.collectionName === sessionId && (f.status === 'ingesting' || f.status === 'success')
        )
      : []

    // Keep internal knowledge available for base/project/session corpora even though it is hidden from toggles.
    const dataSourcesForMessage = layoutState.knowledgeLayerAvailable
      ? Array.from(new Set([...enabledDataSources, 'knowledge_layer']))
      : enabledDataSources
    return {
      dataSourcesForMessage,
      // On the wire, `[]` selects NO source. Before the source list has loaded
      // (or when it failed to), an empty selection is the store's initial
      // value, not a choice, so it states nothing: `null` is every source the
      // organization allows. Sending it refused every retrieval of the turn
      // ("Research turn has every data source switched off", PostHog Logs).
      // A selection that does exist goes out as it is.
      dataSourcesOnWire:
        layoutState.availableDataSources === null && dataSourcesForMessage.length === 0 ? null : dataSourcesForMessage,
      // Prepare file metadata for display
      messageFiles: sessionFiles.map((f) => ({ id: f.id, fileName: f.fileName })),
    }
  }, [])

  /**
   * Open an agent turn for the question `messageId`: its view starts running
   * now, and the question goes on the wire, or waits for the socket and goes
   * on it the moment it opens. Both send paths share this one definition of
   * "a turn starts", and the mention path can decline to call it at all: the
   * point of MN-7 is that nothing is started rather than started and
   * cancelled.
   */
  const openAgentTurn = useCallback(
    (
      messageId: string,
      content: string,
      dataSourcesForMessage: string[] | null,
      conversationId: string | undefined,
      reasoningEffort?: ChatEffort,
      asked?: CanvasFocus
    ): boolean => {
      // A question typed in the chat while a document is open over it, with a
      // box drawn or a mark selected, points at that place exactly as a canvas
      // question does; an explicit canvas question brings its own.
      const canvas = asked ?? openCanvasFocus() ?? undefined
      if (!conversationId) {
        addErrorCard('system.unknown', 'No active conversation')
        return false
      }
      // Retrieval follows the composer bar ("Asking about this file") and
      // nothing else. A file that merely happens to be open in a peek is
      // context, not scope: sending it as the focus told the agent every bare
      // question was about that file, and a norm question ("Absturzhoehe bei
      // Bruestungen") came back empty because the search was pinned to it.
      const subject = useChatStore.getState().composerSubject
      const subjectName = subject?.filename?.trim() || subject?.title?.trim() || undefined
      // The composer's Aufwand dial. Always stated, so the level the chat
      // shows is the level the turn runs at (`effort-store.ts`). A per-turn
      // override wins and is never remembered. Recorded on the turn too: the
      // answer keeps the level it ran at after the dial moves on.
      const effort = reasoningEffort ?? useEffortStore.getState().levelForSend(conversationId)
      const posthogSessionId = getPosthogSessionId()
      useChatStore.getState().beginTurn(conversationId, messageId, effort)
      // One event per turn that actually starts, from the one place a turn
      // starts. Shape only: whether files are attached, the Aufwand level and
      // how many sources are live. Never the question, never a file name.
      capturePosthog('chat_message_sent', {
        has_attachments: collectSendMetadata().messageFiles.length > 0,
        effort,
        data_source_count: dataSourcesForMessage?.length ?? null,
      })
      // `focus_region` and `reply_in_thread` are being added to the wire; until
      // the generated type carries them they ride on this wider local type.
      const clientTools = viewerClientTools()
      const question: UserMessage & { focus_region?: CanvasFocusRegion | null; reply_in_thread?: boolean } = {
        type: 'user_message',
        conversation_id: conversationId,
        message_id: messageId,
        text: content,
        data_sources: dataSourcesForMessage,
        focus_file_name: canvas ? canvas.fileName : subjectName || null,
        focus_shelf: canvas ? canvas.shelf : (subject?.shelf ?? null),
        focus_document_id: canvas ? canvas.documentId : (subject?.resourceId ?? null),
        focus_version_id: canvas ? canvas.versionId : (subject?.versionId ?? null),
        focus_version_state: openVersionState(canvas ? canvas.versionState : subject?.versionState),
        ...(canvas ? { focus_region: canvas.region ? clampFocusRegion(canvas.region) : null } : {}),
        ...(canvas?.replyInThread ? { reply_in_thread: true } : {}),
        source_preset: useLayoutStore.getState().activeSourcePreset ?? null,
        reasoning_effort: effort,
        // Omitted, not null, while PostHog is off: `forServer` keys on presence.
        ...(posthogSessionId ? { posthog_session_id: posthogSessionId } : {}),
        // The frontend tools this page can run (AG-UI's RunAgentInput.tools): the viewer, when it has
        // room beside the chat. Omitted otherwise, so the server never offers the model the tool (ADR-0144).
        ...(clientTools.length ? { client_tools: clientTools } : {}),
      }
      ensureDriver(conversationId).ask(question)
      return true
    },
    [addErrorCard, collectSendMetadata, ensureDriver]
  )

  /**
   * Send a message the SERVER rules on — THE ADDRESSEE CONTRACT (ADR-0034 §4).
   *
   * Taken by a message that carries mentions, and by a plain message sent while the
   * thread waits on a named person (the addendum's second state, where a remark is
   * not a question). Everything that makes this path different from the fast one
   * follows from one rule: **the server decides who answers.** So persistence is
   * awaited, the `addressees` ruling is read off the response, and an agent turn is
   * opened only when `addressees.agent` is true. When it is false nothing is STARTED
   * — no status, no thinking bubble, no tokens (spec MN-7) — and the thread's
   * awaiting-state explains the silence instead.
   *
   * The message still reaches the agent, as context only (see `deliverAsContext`).
   * Not answering is a routing decision; not remembering was a bug.
   *
   * It also means a refusal (a collaborator tagging a non-participant, a target
   * outside the project, a rate limit) refuses the WHOLE send: nothing is echoed
   * into the thread, so the composer can keep the user's text and say why.
   */
  const sendRuledMessage = useCallback(
    async (content: string, options: SendMessageOptions): Promise<SendMessageOutcome> => {
      const mentions = options.mentions ?? []
      const store = useChatStore.getState()
      const conversationId = store.currentConversation?.id ?? store.ensureSession?.()
      if (!conversationId) {
        addErrorCard('system.unknown', 'No active conversation')
        return { ok: false }
      }

      const { dataSourcesForMessage, dataSourcesOnWire, messageFiles } = collectSendMetadata()
      // Our id, generated up front: it is the anchor the mention request points at,
      // and the idempotency key the server rules on.
      const messageId = uuidv4()

      let ruling: AddresseeSet | null = null
      try {
        // The conversation row has to exist before a message can be posted onto it.
        // Shared with the store's own append path, so it is at most one round trip.
        await store._ensureConversationExists?.()

        const response = await fetch(
          `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id: messageId,
              role: 'user',
              content,
              messageType: 'user',
              metadata: {
                enabledDataSources: dataSourcesForMessage,
                ...(messageFiles.length > 0 ? { messageFiles } : {}),
              },
              createdAt: new Date().toISOString(),
              // Structured references, never a text match on a name (spec MN-3).
              mentions: mentions.map((mention) => ({ targetId: mention.targetId })),
              ...(options.mentionNote ? { mentionNote: options.mentionNote } : {}),
            }),
          }
        )

        if (!response.ok) {
          return { ok: false, failure: await readSendFailure(response) }
        }
        ruling = readAddresseeRuling(await response.json(), messageId)
      } catch {
        // Network/offline: nothing was stored, so nothing is echoed and no turn is
        // opened. The composer keeps the text.
        return { ok: false, failure: { reason: null, message: null } }
      }

      if (!ruling) return { ok: false, failure: { reason: null, message: null } }

      appendLocalUserMessage({
        id: messageId,
        role: 'user',
        content,
        timestamp: new Date(),
        messageType: 'user',
        enabledDataSources: dataSourcesForMessage,
        messageFiles: messageFiles.length > 0 ? messageFiles : undefined,
        // Kept on the message so the bubble can render the tokens as chips
        // without re-deriving anything from the text.
        mentions: mentions.map((mention) => ({ ...mention })),
        addressees: ruling,
      })

      if (!ruling.agent) {
        // The thread now waits for a human. Nothing is STARTED (MN-7) — but the
        // agent still has to see what was written, or the next `@Piloti given
        // that…` has nothing to refer to. Free, silent, best-effort.
        deliverAsContext(messageId, content, dataSourcesOnWire)
        return { ok: true, addressees: ruling }
      }

      const started = openAgentTurn(messageId, content, dataSourcesOnWire, conversationId, options.reasoningEffort)
      return { ok: started, addressees: ruling }
    },
    [addErrorCard, collectSendMetadata, deliverAsContext, openAgentTurn]
  )

  /**
   * Send a message via WebSocket.
   *
   * Two paths, deliberately asymmetric:
   *   - **a thread in its normal state, with nothing tagged**: the message is
   *     echoed and persisted fire-and-forget and the turn opens immediately.
   *     This is the 99% case and it must not pay for the feature (returns a
   *     plain boolean).
   *   - **mentions, or a plain message while the thread waits on a person**:
   *     the addressee contract, where persistence is awaited and the server
   *     decides whether a turn opens at all (returns an outcome).
   */
  const sendMessage = useCallback(
    (content: string, options?: SendMessageOptions): boolean | Promise<SendMessageOutcome> => {
      if (!content.trim()) return false
      if ((options?.mentions && options.mentions.length > 0) || options?.awaitingHuman) {
        return sendRuledMessage(content, options ?? {})
      }
      const { dataSourcesForMessage, dataSourcesOnWire, messageFiles } = collectSendMetadata()
      const message = addUserMessage(content, { enabledDataSources: dataSourcesForMessage, messageFiles })
      // The conversation may have just been created inside addUserMessage.
      const conversationId = useChatStore.getState().currentConversation?.id
      return openAgentTurn(
        message.id,
        content,
        dataSourcesOnWire,
        conversationId,
        options?.reasoningEffort,
        options?.canvas
      )
    },
    [addUserMessage, collectSendMetadata, openAgentTurn, sendRuledMessage]
  )

  /**
   * A note for the turn running in this conversation: the composer's Enter
   * while the asker's own answer streams, or a box drawn on the canvas
   * meanwhile. An unread note is asked as the next question by default.
   */
  const steer = useCallback(
    ({ text, focusRegion, onLeftover }: SteerRequest): boolean => {
      const { currentConversation, turns } = useChatStore.getState()
      const running = runningTurnIn(turns, currentConversation?.id)
      const driver = driverRef.current
      if (!text.trim() || !running || driver?.conversationId !== running.conversationId) return false
      return driver.steer(running.turnId, text.trim(), {
        focusRegion,
        onLeftover: onLeftover ?? ((leftover) => void sendMessage(leftover)),
      })
    },
    [sendMessage]
  )

  // The review canvas over this chat asks through this driver (`canvas-bridge.ts`).
  useEffect(() => registerCanvasChatSteerer((request) => steer(request)), [steer])
  useEffect(
    () =>
      registerCanvasChatSender((question) => {
        const sent = sendMessage(question.text, { reasoningEffort: question.effort, canvas: question.focus })
        const { currentConversation, currentUserMessageId } = useChatStore.getState()
        if (sent !== true || !currentConversation || !currentUserMessageId) return null
        return { conversationId: currentConversation.id, turnId: currentUserMessageId }
      }),
    [sendMessage]
  )

  /**
   * Answer the open `interaction_request`: the typed text, or the chosen
   * option's id for a `choice` prompt. Sent now, or when the socket is back.
   */
  const respondToInteraction = useCallback(
    (response: string) => {
      const { pendingInteraction: pending, currentConversation } = useChatStore.getState()
      if (!pending || !currentConversation) return
      const prompt = currentConversation.messages.findLast(
        (m) => m.messageType === 'prompt' && m.promptId === pending.interactionId
      )
      if (prompt) respondToPrompt(prompt.id, response)
      ensureDriver(currentConversation.id).deliver({
        type: 'interaction_response',
        conversation_id: currentConversation.id,
        turn_id: pending.turnId,
        interaction_id: pending.interactionId,
        answer: pending.input === 'choice' ? { option_id: response } : { text: response },
      })
    },
    [respondToPrompt, ensureDriver]
  )

  return {
    sendMessage,
    respondToInteraction,
    noteSendIntent,
    isLoading,
    pendingInteraction,
    steer,
    canSteer: isConnected && steerOffered,
  }
}
