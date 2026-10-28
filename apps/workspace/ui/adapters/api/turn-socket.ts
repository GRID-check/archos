/**
 * The chat socket, v2 (`docs/design/chat-wire-v2.md` §e.2): connect, send,
 * reconnect, and nothing that interprets a turn. Every frame is parsed by
 * `parseWireEvent` and handed on; `foldTurnEvent` is the only reader.
 *
 * - **Version, both ways.** The upgrade asks for `?v=2`, and close code 4426
 *   means this page is older than the server: `outdated`, and no reconnect.
 *   The other way round is the `hello`: the server's first frame says it
 *   speaks v2. Until it arrives the socket is not `open` and sends nothing. A
 *   socket that stays silent for {@link HELLO_TIMEOUT_MS}, or opens with
 *   anything else, reached a server that does not speak this wire (an agent
 *   rolled back to the agent runtime's stock socket accepts the upgrade and ignores `?v=2`):
 *   the attempt failed, and when the ladder is spent the status is
 *   `incompatible`, not `failed`, because the network is fine.
 * - **Optional fields, by the hello.** The server reads what the client sends
 *   strictly: an unknown field refuses the message. A field added to a client
 *   message is therefore sent only to a server whose hello names it in
 *   `accepts` ({@link forServer}): during a rolling deploy the socket may have
 *   reached a pod one release older, and a Stop it refused would leave the
 *   turn running. The check is made on the socket that sends, so a message
 *   held across a reconnect is shaped for the server it finally reaches. A
 *   whole message type the hello does not name (`steer`) is not sent at all:
 *   `send` returns false and the caller keeps it (a note becomes the next
 *   question).
 * - **Drift.** After the hello, a frame this page cannot parse means the
 *   server speaks a newer v2 than this bundle: `outdated`, as for 4426. It is
 *   never dropped and waited past, because a turn whose next `seq` cannot be
 *   read can never fold another event, its terminal included. Additive drift
 *   (an unknown key; an unknown `type`, step `kind` or `CUSTOM` name) parses:
 *   `parseWireEvent` reads it, and the fold passes over what it does not know.
 * - **Resume.** On every reopen, each running turn is re-`attach`ed from the
 *   last seq its view folded; the server replays from there and continues live.
 *   The caller owns those cursors (`openTurns`), so there is one `lastSeq`.
 * - **Liveness.** While a turn runs, the server beats every `every_ms`. Three
 *   beats with no frame this page could read and the socket is dropped and
 *   reopened, and `onSilent` names the turns it was waiting on, so the caller
 *   can stop waiting on a turn that stays silent across reopens. A question not
 *   yet acknowledged (`RUN_STARTED`) is the caller's to watch (`openTurns`
 *   leaves it out); a turn waiting for its stages (`settled`) gets no beats.
 * - **Backoff.** `createRetryLadder`, with the auth refresh before each attempt:
 *   the handshake is the only point where the gateway reads the cookie. The
 *   hello is the evidence that starts the ladder over. `partysocket` was weighed
 *   for this (MIT, 210 KB, one polyfill) and not taken: the ladder is already
 *   ours, and its send queue would replay stale client messages that `attach`
 *   makes wrong.
 * - **A page away is not a server down** (`page-lifecycle.ts`). A phone that
 *   locks freezes the page and iOS kills the socket; a phone on site loses the
 *   network. While the page is hidden or offline no attempt is made and the
 *   ladder keeps its budget (`suspended`, `offline`): twelve rungs spent on a
 *   frozen page used to be gone in four minutes of a ten-minute lock, and the
 *   reader came back to „lost". The moment it is visible and online again (or
 *   restored from the back/forward cache) the socket reopens from the first
 *   rung, and every open turn is attached from its last seq. A ready socket
 *   that heard nothing while the page was away for longer than a beat is
 *   reopened too: it may be dead without its close having fired. A watchdog or
 *   hello timer that fires late, having slept through a freeze, measured the
 *   freeze: it is no strike against the turn and no sign of another dialect.
 */

import { createRetryLadder, type RetryLadderOptions } from '@/shared/utils/backoff'
import { getWebSocketUrl } from './config'
import { browserPageLifecycle, isActive, sleptThrough, type PageLifecycle } from './page-lifecycle'
import {
  CLOSE_CLIENT_OUTDATED,
  WIRE_VERSION,
  parseHello,
  parseWireEvent,
  type ClientMessage,
  type Hello,
  type WireEvent,
} from './wire-v2'

export type TurnSocketStatus =
  | 'connecting'
  | 'open'
  | 'reconnecting'
  /** The ladder is spent and the last attempt never reached a server. */
  | 'failed'
  /** The ladder is spent and the last attempt reached a server that does not speak wire v2. */
  | 'incompatible'
  /** The server speaks a newer wire than this page: 4426, or a frame this bundle cannot read. */
  | 'outdated'
  /** The page is hidden (locked, in the background): nothing is tried until it is visible. */
  | 'suspended'
  /** The browser has no network: nothing is tried until it is back. */
  | 'offline'
  | 'closed'

/** A turn still running, and the last seq its view folded. */
export interface OpenTurn {
  turnId: string
  lastSeq: number
  /** Finished, waiting only for its post-answer stages: attached on reopen, never watched. */
  settled?: true
}

export interface TurnSocketOptions {
  conversationId: string
  projectId?: string
  /** Base URL; same-origin `/websocket` by default. */
  url?: string
  onEvent: (event: WireEvent) => void
  onStatus?: (status: TurnSocketStatus) => void
  /** The turns to attach on reopen, and the ones the watchdog guards. */
  openTurns: () => readonly OpenTurn[]
  /** The watchdog dropped the socket: these running turns said nothing for three beats. */
  onSilent?: (turnIds: readonly string[]) => void
  /** Refresh the auth cookie before each attempt. A failure does not stop the attempt. */
  refreshAuth?: () => Promise<void>
  /**
   * Default: 1 s doubling to 30 s, 12 attempts, which outlasts a rolling deploy
   * of both tiers. Attempts are made, and so counted, only while the page is
   * visible and online.
   */
  ladder?: RetryLadderOptions
  /**
   * How a socket is opened: the browser's `WebSocket` by default. A server
   * caller (the BFF's wake job, ADR-0106) passes one built on Node's `ws`,
   * which can set the upgrade's headers a browser cannot.
   */
  createWebSocket?: (url: string) => WebSocketLike
  /** Whether the page is visible and online, and when it is again. The browser's by default; none on a server. */
  lifecycle?: PageLifecycle
}

/** The part of a WebSocket this driver uses, which the browser's and Node's `ws` both have. */
export interface WebSocketLike {
  readonly readyState: number
  onopen: ((event: Event) => void) | null
  onmessage: ((event: MessageEvent) => void) | null
  onclose: ((event: CloseEvent) => void) | null
  onerror: ((event: Event) => void) | null
  send: (data: string) => void
  close: () => void
}

export interface TurnSocket {
  /** Open, or keep open. After the ladder gave up, a new ladder: this is a new request. */
  connect: () => Promise<void>
  /**
   * False when the socket is not open (no hello yet), or when its server does
   * not read this message type (`forServer` returned null); nothing is queued.
   */
  send: (message: ClientMessage) => boolean
  /** Whether the open socket's server named `entry` in its hello (`steer`, `user_message.trigger`). */
  accepts: (entry: string) => boolean
  /** Drop the current socket, if any, and open a fresh one now, from the first rung. */
  reconnect: () => void
  close: () => void
}

/**
 * How long a socket that opened may take to say hello. The server sends it
 * right after `accept()`, the version check and the token check, all in
 * process, so it is one round trip behind `onopen`; the gateway's scope lookup
 * happens before the upgrade completes and does not count. Five seconds is
 * many times that, and short enough that a server in another dialect costs one
 * rung of the ladder rather than a turn.
 */
export const HELLO_TIMEOUT_MS = 5_000

/**
 * `message` as the server whose hello said `accepts` can read it: an optional
 * field it does not name is left out, and the rest of the message still goes.
 * Without the field the server does what it did before it existed: a Stop
 * without `shown` keeps everything streamed so far.
 */
export const forServer = (message: ClientMessage, accepts: ReadonlySet<string>): ClientMessage | null => {
  // A note for the running turn is a message type of its own, and a server
  // that does not name it refuses the frame. Not sent: the caller keeps it and
  // asks it as the next question once the turn has ended.
  if (message.type === 'steer') return accepts.has('steer') ? message : null
  if (message.type === 'cancel_turn' && message.shown && !accepts.has('cancel_turn.shown')) {
    const { shown: _unread, ...rest } = message
    return rest
  }
  // The PostHog session id links the turn's Langfuse trace to the recording. A
  // server that does not read it refuses the whole question, the key present
  // even as null, so the key goes, not the value.
  if (message.type !== 'user_message') return message
  let shaped = message
  if (shaped.posthog_session_id !== undefined && !accepts.has('user_message.posthog_session_id')) {
    const { posthog_session_id: _unread, ...rest } = shaped
    shaped = rest
  }
  // A box on the review canvas and the ask to answer in its thread. An older
  // server answers the question about the whole document and in the chat only,
  // which is what it did before the canvas could ask: better than refusing it.
  if (shaped.focus_region !== undefined && !accepts.has('user_message.focus_region')) {
    const { focus_region: _unread, ...rest } = shaped
    shaped = rest
  }
  if (shaped.reply_in_thread !== undefined && !accepts.has('user_message.reply_in_thread')) {
    const { reply_in_thread: _unread, ...rest } = shaped
    shaped = rest
  }
  // The two fields a turn an event woke carries (the BFF's wake job). An older
  // server would run it as a typed question; the job checks `accepts` itself
  // before it sends one, because without `if_idle` it would supersede.
  if (shaped.trigger !== undefined && !accepts.has('user_message.trigger')) {
    const { trigger: _unread, ...rest } = shaped
    shaped = rest
  }
  if (shaped.if_idle !== undefined && !accepts.has('user_message.if_idle')) {
    const { if_idle: _unread, ...rest } = shaped
    shaped = rest
  }
  // The frontend tools this page can run (ADR-0144). An older server would refuse the question; without
  // the field it answers as it did before, with no viewer actions.
  if (shaped.client_tools !== undefined && !accepts.has('user_message.client_tools')) {
    const { client_tools: _unread, ...rest } = shaped
    shaped = rest
  }
  return shaped
}

/** The heartbeat interval assumed until the server states its own. */
const DEFAULT_BEAT_MS = 20_000
const DEAD_AFTER_BEATS = 3
const OPEN = 1

/** A frame as JSON, or `undefined` when it is not JSON at all. */
const jsonOf = (data: unknown): unknown => {
  try {
    return JSON.parse(String(data))
  } catch {
    return undefined
  }
}

const typeOf = (raw: unknown): string => {
  const record = raw !== null && typeof raw === 'object' ? (raw as { type?: unknown; name?: unknown }) : {}
  return [record.type, record.name].filter((part) => typeof part === 'string').join(':') || typeof raw
}

export function createTurnSocket(options: TurnSocketOptions): TurnSocket {
  const ladder = createRetryLadder(options.ladder ?? { baseMs: 1_000, maxMs: 30_000, budget: 12 })
  const lifecycle = options.lifecycle ?? browserPageLifecycle()
  let unsubscribe: (() => void) | null = null
  /** When the page last went hidden or offline, until it is back. */
  let awaySince: number | null = isActive(lifecycle) ? null : Date.now()
  /** When the current socket last carried a frame. */
  let heardAt = 0
  const warned = new Set<string>()
  let socket: WebSocketLike | null = null
  let opening: Promise<void> | null = null
  let stopped = true
  /** The current socket's server said hello: it speaks v2, and `send` may use it. */
  let ready = false
  /** The optional client fields the current socket's server named in its hello. */
  let accepts: ReadonlySet<string> = new Set()
  /** Why the last attempt failed, which names the status when the ladder is spent. */
  let lastFailure: 'failed' | 'incompatible' = 'failed'
  let everyMs = DEFAULT_BEAT_MS
  let watchdog: ReturnType<typeof setTimeout> | null = null

  const status = (next: TurnSocketStatus): void => options.onStatus?.(next)

  /** Once per cause and frame type: a server in another dialect would otherwise fill the console. */
  const warnOnce = (what: string, raw?: unknown): void => {
    const detail = raw === undefined ? '' : typeOf(raw)
    const key = `${what}:${detail}`
    if (!warned.has(key)) console.warn(`[turn-socket] ${what}`, detail)
    warned.add(key)
  }

  const disarm = (): void => {
    if (watchdog) clearTimeout(watchdog)
    watchdog = null
  }

  /** Detach and close the current socket without its close event starting anything. */
  const drop = (): void => {
    const current = socket
    socket = null
    ready = false
    accepts = new Set()
    disarm()
    if (!current) return
    current.onopen = current.onmessage = current.onclose = current.onerror = null
    current.close()
  }

  /** Why no attempt can be seen through now, or null when one can. */
  const away = (): 'suspended' | 'offline' | null =>
    !lifecycle.visible ? 'suspended' : !lifecycle.online ? 'offline' : null

  const retry = (): void => {
    const waiting = away()
    if (waiting) {
      // No attempt while nobody can see it through: the ladder keeps its
      // place and its budget, and the page's return reopens the socket.
      ladder.cancel()
      status(waiting)
      return
    }
    status('reconnecting')
    // A rung that falls due on a page gone away since tries nothing either.
    if (!ladder.schedule(() => (away() ? retry() : void open()))) status(lastFailure)
  }

  /** Drop whatever there is and open now, from the first rung. */
  const reopen = (): void => {
    ladder.reset()
    drop()
    void open()
  }

  /** The server does not speak this wire: this attempt failed, the next may reach another pod. */
  const incompatible = (): void => {
    lastFailure = 'incompatible'
    drop()
    retry()
  }

  /** The server speaks a newer wire than this page can read: reload, as for 4426. */
  const outdated = (): void => {
    drop()
    stopped = true
    status('outdated')
  }

  /** The page was away while this timer ran: what it measured is the page, not the server. */
  const wasAway = (armedAt: number, ms: number): boolean =>
    awaySince !== null || !isActive(lifecycle) || sleptThrough(armedAt, ms)

  /** Time out a socket that opened and has not said hello. */
  const awaitHello = (): void => {
    disarm()
    const armedAt = Date.now()
    watchdog = setTimeout(() => {
      watchdog = null
      // A freeze between the open and the hello is not another dialect.
      if (wasAway(armedAt, HELLO_TIMEOUT_MS)) {
        drop()
        return retry()
      }
      warnOnce('no hello within the timeout')
      incompatible()
    }, HELLO_TIMEOUT_MS)
  }

  /** Watch the running turns: three beats with no frame and the socket is dead. */
  const arm = (): void => {
    disarm()
    const armedAt = Date.now()
    const ms = DEAD_AFTER_BEATS * everyMs
    watchdog = setTimeout(() => {
      watchdog = null
      const silent = options
        .openTurns()
        .filter((turn) => !turn.settled)
        .map((turn) => turn.turnId)
      if (silent.length === 0) return
      drop()
      // Silence heard while the page was away is the page's, not the turn's:
      // reopened when it is back, and no strike against the turn.
      if (!wasAway(armedAt, ms)) options.onSilent?.(silent)
      retry()
    }, ms)
  }

  const send = (message: ClientMessage): boolean => {
    if (!ready || socket?.readyState !== OPEN) return false
    const shaped = forServer(message, accepts)
    if (!shaped) return false
    socket.send(JSON.stringify(shaped))
    return true
  }

  /** The hello: the server speaks v2. Now the socket is open, and every open turn is attached. */
  const greeted = (hello: Hello): void => {
    ready = true
    accepts = new Set(hello.value.accepts ?? [])
    ladder.reset()
    status('open')
    for (const turn of options.openTurns()) {
      send({ type: 'attach', conversation_id: options.conversationId, turn_id: turn.turnId, after_seq: turn.lastSeq })
    }
    arm()
  }

  const receive = (data: unknown): void => {
    heardAt = Date.now()
    const raw = jsonOf(data)
    if (!ready) {
      const hello = parseHello(raw)
      if (hello) return greeted(hello)
      warnOnce('opened with something other than a v2 hello', raw)
      return incompatible()
    }
    const event = parseWireEvent(raw)
    if (!event) {
      warnOnce('not a v2 event this page can read', raw)
      return outdated()
    }
    if (event.type === 'CUSTOM' && event.name === 'heartbeat') everyMs = event.value.every_ms
    arm()
    options.onEvent(event)
  }

  const urlOf = async (): Promise<string> => {
    const base = options.url ?? (await getWebSocketUrl())
    const params = new URLSearchParams({ v: String(WIRE_VERSION), conversationId: options.conversationId })
    if (options.projectId) params.set('projectId', options.projectId)
    return `${base}${base.includes('?') ? '&' : '?'}${params}`
  }

  const connectOnce = async (): Promise<void> => {
    status('connecting')
    await options.refreshAuth?.().catch(() => undefined)
    const url = await urlOf()
    if (stopped) return
    lastFailure = 'failed'
    const ws: WebSocketLike = options.createWebSocket ? options.createWebSocket(url) : new WebSocket(url)
    socket = ws
    ws.onopen = () => {
      if (socket === ws) awaitHello()
    }
    ws.onmessage = (message: MessageEvent) => {
      if (socket === ws) receive(message.data)
    }
    ws.onclose = (event: CloseEvent) => {
      if (socket !== ws) return
      socket = null
      ready = false
      disarm()
      if (stopped) return
      if (event.code === CLOSE_CLIENT_OUTDATED) {
        stopped = true
        status('outdated')
        return
      }
      retry()
    }
  }

  const open = (): Promise<void> => {
    if (stopped || socket) return Promise.resolve()
    opening ??= connectOnce().finally(() => (opening = null))
    return opening
  }

  /** The page went hidden or offline. An open socket is kept: it may well live through it. */
  const suspend = (): void => {
    awaySince ??= Date.now()
    if (stopped || socket || opening) return
    // A rung waiting to fire is not spent on a page nobody can see through.
    retry()
  }

  /**
   * The page is visible and online again. No socket, one still opening, or a
   * ready one that heard nothing while the page was away longer than a beat
   * (iOS may have killed it without its close reaching us): reopen now, from
   * the first rung. A socket that kept talking through it is kept.
   */
  const resume = (): void => {
    const since = awaySince
    awaySince = null
    if (stopped) return
    const quietSince = since !== null && heardAt < since && Date.now() - since > everyMs
    if (socket && ready && !quietSince) return
    reopen()
  }

  const listen = (): void => {
    unsubscribe ??= lifecycle.subscribe({ resume, suspend })
  }

  return {
    connect: () => {
      stopped = false
      listen()
      if (ladder.spent) ladder.reset()
      return open()
    },
    send,
    accepts: (entry) => ready && accepts.has(entry),
    reconnect: () => {
      stopped = false
      listen()
      reopen()
    },
    close: () => {
      stopped = true
      unsubscribe?.()
      unsubscribe = null
      ladder.cancel()
      drop()
      status('closed')
    },
  }
}
