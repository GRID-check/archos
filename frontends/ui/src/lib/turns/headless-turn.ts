/**
 * Start a chat turn with nobody's browser open (ADR-0106): the BFF opens the
 * chat socket itself, sends one `user_message`, and reports what became of it.
 *
 * The same store-free driver the canvas uses (`createTurnSocket`), over Node's
 * `ws`, which can set the upgrade's headers a browser cannot: the signed
 * `X-Grid-Request-Context` envelope (with the conversation, or the canvas
 * tools have no subject) and `X-AIQ-Mode: headless`, which marks the caller
 * headless so the clarifier is skipped and `ask_user` refuses instead of
 * waiting thirty minutes on a socket nobody reads.
 *
 * The socket goes straight to the backend's chat role, chosen the way
 * `server.js` chooses it (`lib/proxy/backend-target.js`, affinity by
 * conversation), not through the gateway: the gateway resolves a browser's
 * cookie, and the wake has a pinned session with no token. The backend reads
 * a caller on its internal network as internal, and takes who acts from the
 * signed envelope.
 *
 * A turn outlives its socket and persists itself, so this detaches once the
 * turn has started: it waits a moment after `RUN_STARTED` for an early refusal
 * (admission, the budget) and then lets go.
 */

import 'server-only'
import WebSocket from 'ws'
import {
  createTurnSocket,
  type TurnSocket,
  type TurnSocketOptions,
  type WebSocketLike,
} from '@/adapters/api/turn-socket'
import type { ClientMessage } from '@/adapters/api/wire-v2'
import { affinityEnabled, createBackendTargetPicker } from '@/lib/proxy/backend-target.js'

/** A `user_message`, as the client builds it. */
export type HeadlessUserMessage = Extract<ClientMessage, { message_id: string; text: string }>

/** What became of the question. */
export type HeadlessTurnOutcome =
  /** The turn runs (or ran): it persists itself. */
  | { kind: 'started' }
  /** That turn id already ran or runs: nothing to do. */
  | { kind: 'duplicate' }
  /** Another turn of the conversation runs; `if_idle` never supersedes it. Ask again later. */
  | { kind: 'busy' }
  /** Admission or the budget refused it before it ran. */
  | { kind: 'refused'; reason: string }
  /** The server refused the message itself (`invalid_message`, `auth_expired`, `conversation_mismatch`, ...). */
  | { kind: 'rejected'; code: string; message: string | null }
  /** No server took it: none answered, none spoke this wire, or the one that did reads none of `requires`. */
  | { kind: 'unavailable'; reason: string }

export interface HeadlessTurnRequest {
  /** The backend's chat socket, `ws(s)://host/websocket`; `?v=2&conversationId=…` is added. */
  url: string
  conversationId: string
  projectId?: string
  /** The upgrade's headers: the turn context (`turnContextHeaders`) and `x-aiq-mode`. */
  headers: Record<string, string>
  message: HeadlessUserMessage
  /** Hello entries the server must name before the message is sent (`user_message.if_idle`). */
  requires: readonly string[]
  /** How long after `RUN_STARTED` an early refusal is waited for. */
  detachAfterMs?: number
  /** The whole attempt, connect included. */
  timeoutMs?: number
  /** Specs: the driver, and the socket under it. */
  createSocket?: (options: TurnSocketOptions) => TurnSocket
  createWebSocket?: (url: string, headers: Record<string, string>) => WebSocketLike
}

const DEFAULT_DETACH_AFTER_MS = 5_000
const DEFAULT_TIMEOUT_MS = 45_000

/** A socket on Node's `ws`, with the headers a browser cannot set. */
export function nodeWebSocket(url: string, headers: Record<string, string>): WebSocketLike {
  const socket = new WebSocket(url, { headers })
  // `ws` is an EventEmitter: an `error` with no listener throws out of the
  // process. The close that follows every error is what the driver reads.
  socket.on('error', (error) => console.warn('[headless-turn] socket error:', error.message))
  // The browser's WebSocket and `ws` agree on the members the driver uses.
  return socket as unknown as WebSocketLike
}

/** The chat socket's address for a conversation, as `server.js` picks it. */
export function chatSocketUrl(conversationId: string, env: Record<string, string | undefined> = process.env): string {
  const chat = (env.BACKEND_CHAT_URL ?? '').trim().replace(/\/$/, '')
  if (!chat) throw new Error('BACKEND_CHAT_URL is not set: the wake has no chat socket to open')
  const pick = createBackendTargetPicker({
    replicas: Math.max(1, Number.parseInt(env.BACKEND_REPLICAS ?? '1', 10) || 1),
    podTemplate: env.BACKEND_POD_WS_TEMPLATE ?? '',
    affinity: affinityEnabled(env.CHAT_AFFINITY),
    serviceUrl: chat.replace(/^http/, 'ws'),
  })
  return `${pick(conversationId)}/websocket`
}

/** Open the socket, send the question once the server has said it reads it, and report. Never throws. */
export function runHeadlessTurn(request: HeadlessTurnRequest): Promise<HeadlessTurnOutcome> {
  const { message } = request
  const detachAfterMs = request.detachAfterMs ?? DEFAULT_DETACH_AFTER_MS
  return new Promise((resolve) => {
    let settled = false
    let started = false
    let detach: ReturnType<typeof setTimeout> | null = null
    let socket: TurnSocket | null = null

    const finish = (outcome: HeadlessTurnOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      if (detach) clearTimeout(detach)
      socket?.close()
      resolve(outcome)
    }

    const deadline = setTimeout(
      () => finish(started ? { kind: 'started' } : { kind: 'unavailable', reason: 'no answer in time' }),
      request.timeoutMs ?? DEFAULT_TIMEOUT_MS
    )

    socket = (request.createSocket ?? createTurnSocket)({
      conversationId: request.conversationId,
      projectId: request.projectId,
      url: request.url,
      // Nothing to resume: a socket reopened before the turn started sends the
      // question again, under the same id, which the server then runs once.
      openTurns: () => [],
      ladder: { baseMs: 500, maxMs: 2_000, budget: 3 },
      createWebSocket: (url) => (request.createWebSocket ?? nodeWebSocket)(url, request.headers),
      onStatus: (status) => {
        if (status === 'failed' || status === 'incompatible' || status === 'outdated') {
          finish(started ? { kind: 'started' } : { kind: 'unavailable', reason: `socket ${status}` })
          return
        }
        if (status !== 'open' || started || !socket) return
        // A server that does not read `if_idle` would supersede a person's
        // running turn: do not send, ask again later.
        const missing = request.requires.filter((entry) => !socket?.accepts(entry))
        if (missing.length > 0) {
          finish({ kind: 'unavailable', reason: `the server does not read ${missing.join(', ')}` })
          return
        }
        if (!socket.send(message)) finish({ kind: 'unavailable', reason: 'the socket would not take the message' })
      },
      onEvent: (event) => {
        if (event.turn_id !== message.message_id) return
        if (event.type === 'CUSTOM' && event.name === 'rejected') {
          if (event.value.of !== 'user_message') return
          const { code } = event.value
          if (code === 'busy') return finish({ kind: 'busy' })
          if (code === 'duplicate_turn') return finish({ kind: 'duplicate' })
          return finish({ kind: 'rejected', code, message: event.value.message ?? null })
        }
        if (event.type === 'RUN_FINISHED') {
          return finish(
            event.outcome === 'refused'
              ? { kind: 'refused', reason: event.result.text.trim() || 'refused' }
              : { kind: 'started' }
          )
        }
        if (event.type === 'RUN_STARTED') {
          started = true
          detach = setTimeout(() => finish({ kind: 'started' }), detachAfterMs)
          return
        }
        // Anything else of the turn is progress: it runs.
        if (started) finish({ kind: 'started' })
      },
    })
    void socket.connect()
  })
}

/** What became of a stop. */
export type HeadlessCancelOutcome =
  /** The server took the stop and refused nothing: the turn ends itself (`cancelled`) and reports it. */
  | { kind: 'sent' }
  /** No turn runs under that id here (it ended, or never ran): nothing to stop. */
  | { kind: 'not_running' }
  /** The server refused the stop (`auth_expired`, `conversation_mismatch`, `not_asker`, ...). */
  | { kind: 'rejected'; code: string; message: string | null }
  /** No server took it: none answered, or none spoke this wire. */
  | { kind: 'unavailable'; reason: string }

export interface HeadlessCancelRequest {
  /** The backend's chat socket, as for {@link HeadlessTurnRequest}. */
  url: string
  conversationId: string
  /** The turn to stop: for a wake, the wake id. */
  turnId: string
  /** The upgrade's headers, built by the caller: the signed envelope (naming the conversation) and `x-aiq-mode`. */
  headers: Record<string, string>
  /** How long after sending a refusal is waited for. */
  graceMs?: number
  /** The whole attempt, connect included. */
  timeoutMs?: number
  createSocket?: (options: TurnSocketOptions) => TurnSocket
  createWebSocket?: (url: string, headers: Record<string, string>) => WebSocketLike
}

const DEFAULT_CANCEL_GRACE_MS = 2_000
const DEFAULT_CANCEL_TIMEOUT_MS = 20_000

/**
 * Stop a running turn with nobody's browser open: open the chat socket as an
 * internal caller (which may stop any turn, `may_act_for`), send one
 * `cancel_turn`, and wait a moment for a refusal. A stop is accepted without
 * an answer, so silence after the grace is `sent`; `turn_not_found` is the one
 * refusal that is good news. Never throws.
 */
export function cancelHeadlessTurn(request: HeadlessCancelRequest): Promise<HeadlessCancelOutcome> {
  const graceMs = request.graceMs ?? DEFAULT_CANCEL_GRACE_MS
  return new Promise((resolve) => {
    let settled = false
    let sent = false
    let socket: TurnSocket | null = null
    let grace: ReturnType<typeof setTimeout> | null = null

    const finish = (outcome: HeadlessCancelOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      if (grace) clearTimeout(grace)
      socket?.close()
      resolve(outcome)
    }

    const deadline = setTimeout(
      () => finish({ kind: 'unavailable', reason: 'no answer in time' }),
      request.timeoutMs ?? DEFAULT_CANCEL_TIMEOUT_MS
    )

    socket = (request.createSocket ?? createTurnSocket)({
      conversationId: request.conversationId,
      url: request.url,
      openTurns: () => [],
      ladder: { baseMs: 500, maxMs: 2_000, budget: 3 },
      createWebSocket: (url) => (request.createWebSocket ?? nodeWebSocket)(url, request.headers),
      onStatus: (status) => {
        if (status === 'failed' || status === 'incompatible' || status === 'outdated') {
          finish({ kind: 'unavailable', reason: `socket ${status}` })
          return
        }
        if (status !== 'open' || sent || !socket) return
        sent = true
        const accepted = socket.send({
          type: 'cancel_turn',
          conversation_id: request.conversationId,
          turn_id: request.turnId,
        })
        if (!accepted) return finish({ kind: 'unavailable', reason: 'the socket would not take the stop' })
        // The server answers a refusal at once; no answer is the stop taken.
        grace = setTimeout(() => finish({ kind: 'sent' }), graceMs)
      },
      onEvent: (event) => {
        if (event.turn_id !== request.turnId) return
        if (event.type === 'CUSTOM' && event.name === 'rejected' && event.value.of === 'cancel_turn') {
          const { code } = event.value
          return finish(
            code === 'turn_not_found'
              ? { kind: 'not_running' }
              : { kind: 'rejected', code, message: event.value.message ?? null }
          )
        }
        // The turn itself ended on this socket: the stop landed.
        if (event.type === 'RUN_FINISHED') finish({ kind: 'sent' })
      },
    })
    void socket.connect()
  })
}
