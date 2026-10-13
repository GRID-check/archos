'use client'

/**
 * One live channel in a component (ADR-0110): its status, who the server takes
 * this tab to be, the gossip roster when the channel has presence, and a
 * throttled `send`.
 *
 * The channel reaches the server through a {@link ChannelLink}: by default the
 * tab's shared connection (`./connection`), or a scripted stand-in in specs and
 * `/dev` previews.
 *
 * The roster lives in a ref and reaches React once per animation frame at most,
 * so a room of pointers does not re-render its surface a dozen times a second
 * per person.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RealtimeSelf, UpstreamBase } from '@/lib/realtime/types'
import { getRealtimeConnection, type ChannelStatus, type RealtimeConnection } from './connection'
import { createRoster, type PeerEvent, type RosterEntry } from './presence'

/** One channel's share of the stream, as a link delivers it. */
export type ChannelFrame =
  | { kind: 'event'; event: unknown }
  | { kind: 'welcome'; self: RealtimeSelf }
  | { kind: 'revoked' }

/** How one channel reaches the server. The seam specs and `/dev` previews script. */
export interface ChannelLink<TUp extends UpstreamBase = UpstreamBase> {
  /** Open the channel. Returns the close. */
  connect(handlers: { onFrame: (frame: ChannelFrame) => void; onOpen: () => void; onDrop: () => void }): () => void
  post(msg: TUp): void
}

/** The production link: the channel on the tab's shared connection. */
export function realtimeLink<TUp extends UpstreamBase>(
  ch: string,
  connection: RealtimeConnection = getRealtimeConnection()
): ChannelLink<TUp> {
  return {
    connect({ onFrame, onOpen, onDrop }) {
      let last: ChannelStatus | null = null
      return connection.join(ch, {
        onEvent: (event) => onFrame({ kind: 'event', event }),
        onWelcome: (self) => onFrame({ kind: 'welcome', self }),
        onClosed: () => onFrame({ kind: 'revoked' }),
        onStatus: (status) => {
          if (status === last) return
          last = status
          if (status === 'live') onOpen()
          else if (status === 'offline') onDrop()
        },
      })
    },
    post: (msg) => connection.send(ch, msg),
  }
}

export interface SendOptions {
  /** Send at most once per this many ms, always the latest message, and the last one for sure. */
  throttleMs?: number
  /** Messages throttle per lane; a pointer must not wait behind a scroll. Default `default`. */
  lane?: string
}

export interface ChannelOptions<E, S> {
  enabled: boolean
  /** Defaults to {@link realtimeLink}. Keep it stable (memoize): a new link reconnects. */
  link?: ChannelLink
  /** The channel's vocabulary: an event, or null to drop what does not parse. */
  parse(event: unknown): E | null
  /** Every parsed event, including those the roster consumed. */
  onEvent?(event: E): void
  /** A gossip roster: peers' state, folded from their events. Keep it stable. */
  presence?: {
    refreshMs: number
    leaseMs?: number
    initial(peer: RosterEntry<S>['peer']): S
    reduce(state: S, event: E): S | null
  }
}

const newPeerId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().replace(/-/g, '').slice(0, 20)
    : Math.random().toString(36).slice(2, 22).padEnd(12, '0')

/** A sender that sends at most once per `interval`, always the latest value, and the last one for sure. */
function throttle<T>(interval: number, send: (value: T) => void) {
  let last = 0
  let pending: { value: T } | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = () => {
    timer = null
    if (!pending) return
    last = Date.now()
    const { value } = pending
    pending = null
    send(value)
  }
  return {
    push(value: T) {
      pending = { value }
      const wait = interval - (Date.now() - last)
      if (wait <= 0) flush()
      else timer ??= setTimeout(flush, wait)
    },
    cancel() {
      if (timer) clearTimeout(timer)
      timer = null
      pending = null
    },
  }
}

type Message = Record<string, unknown>

export function useChannel<E extends PeerEvent, S = undefined>(
  ch: string | null,
  { enabled, link: given, parse, onEvent, presence }: ChannelOptions<E, S>
) {
  const peerId = useMemo(newPeerId, [])
  const link = useMemo(() => given ?? (ch ? realtimeLink(ch) : null), [given, ch])
  const active = enabled && link !== null
  const [status, setStatus] = useState<ChannelStatus>('connecting')
  const [self, setSelf] = useState<RealtimeSelf | null>(null)
  const [peers, setPeers] = useState<RosterEntry<S>[]>([])
  const frame = useRef<number | null>(null)
  const handlers = useRef({ parse, onEvent })
  handlers.current = { parse, onEvent }
  const lanes = useRef(new Map<string, ReturnType<typeof throttle<Message>>>())
  const roster = useRef<ReturnType<typeof createRoster<E, S>> | null>(null)

  const commit = useCallback(() => {
    if (frame.current !== null) return
    const run = () => {
      frame.current = null
      setPeers(roster.current?.entries() ?? [])
    }
    frame.current =
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame(run)
        : (setTimeout(run, 16) as unknown as number)
  }, [])

  useEffect(() => {
    if (!active || !link) return
    const post = (msg: Message) => link.post({ ...msg, peerId } as UpstreamBase)
    const list = presence
      ? createRoster<E, S>({
          selfPeerId: peerId,
          refreshMs: presence.refreshMs,
          leaseMs: presence.leaseMs,
          initial: presence.initial,
          reduce: presence.reduce,
          say: (state) => post({ presence: state }),
          onChange: commit,
        })
      : null
    roster.current = list
    const lanesNow = lanes.current

    setStatus('connecting')
    const close = link.connect({
      onOpen: () => {
        setStatus('live')
        list?.hello()
      },
      onDrop: () => setStatus('offline'),
      onFrame: (next) => {
        if (next.kind === 'welcome') {
          setSelf(next.self)
          setStatus('live')
          return
        }
        if (next.kind === 'revoked') {
          setStatus('offline')
          list?.clear()
          return
        }
        const event = handlers.current.parse(next.event)
        if (!event) return
        list?.observe(event)
        handlers.current.onEvent?.(event)
      },
    })
    list?.start()
    return () => {
      for (const lane of lanesNow.values()) lane.cancel()
      lanesNow.clear()
      list?.stop()
      roster.current = null
      close()
      setPeers([])
    }
  }, [active, link, peerId, presence, commit])

  useEffect(
    () => () => {
      if (frame.current !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame.current)
    },
    []
  )

  /** Say something in the channel; the tab's `peerId` is added. */
  const send = useCallback(
    (msg: Message, { throttleMs = 0, lane = 'default' }: SendOptions = {}) => {
      if (!active || !link) return
      const deliver = (value: Message) => link.post({ ...value, peerId } as UpstreamBase)
      if (throttleMs <= 0) {
        deliver(msg)
        return
      }
      let sender = lanes.current.get(lane)
      if (!sender) {
        sender = throttle<Message>(throttleMs, deliver)
        lanes.current.set(lane, sender)
      }
      sender.push(msg)
    },
    [active, link, peerId]
  )

  /** How many others (that `which` accepts) are in the channel now, from the roster's ref: no render needed to ask. */
  const peerCount = useCallback(
    (which?: (peer: RosterEntry<S>['peer']) => boolean) =>
      which ? (roster.current?.entries().filter((entry) => which(entry.peer)).length ?? 0) : (roster.current?.size ?? 0),
    []
  )

  return { peerId, status: active ? status : ('offline' as ChannelStatus), self, peers, send, peerCount }
}
