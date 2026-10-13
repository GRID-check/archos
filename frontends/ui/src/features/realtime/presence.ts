/**
 * The gossip roster of a live channel: who else is here, kept without a list
 * on the server (ADR-0104).
 *
 * Presence is a claim with a TTL, refreshed every `refreshMs` and withdrawn
 * (`gone`) when the tab goes. A newcomer learns who is already here because
 * everyone answers a stranger's first sign of life with their own claim, a
 * random moment later so a room does not answer in one burst. Any event that
 * carries a peer is a sign of life and extends its lease; a peer whose claim
 * runs out is pruned.
 *
 * Not a hook: `use-channel.ts` drives it, and the tests drive it with fake
 * timers.
 */

import type { RealtimePeer } from '@/lib/realtime/types'

export interface RosterEntry<S> {
  peer: RealtimePeer
  /** When the claim runs out, ms since the epoch. */
  expiresAt: number
  state: S
}

export interface RosterOptions<E, S> {
  selfPeerId: string
  refreshMs: number
  /** How long a sign of life that is not a claim holds a peer. Default twice `refreshMs`. */
  leaseMs?: number
  /** A newly seen peer's state. */
  initial(peer: RealtimePeer): S
  /** Fold an event of the peer into its state; `null` takes the peer out. Presence never reaches it. */
  reduce(state: S, event: E): S | null
  /** Say our own claim. */
  say(state: 'here' | 'gone'): void
  onChange(): void
  random?: () => number
  now?: () => number
}

/** An event as the roster reads it: a `kind`, and a `peer` when it is somebody's. */
export type PeerEvent = { kind: string; peer?: RealtimePeer; state?: unknown; ttlMs?: unknown }

/** How long, at most, a tab waits before answering a stranger: spread so a full room does not answer at once. */
const ANSWER_SPREAD_MS = 350
const ANSWER_MIN_MS = 150
const PRUNE_MS = 2_000

export function createRoster<E extends PeerEvent, S>(options: RosterOptions<E, S>) {
  const { selfPeerId, refreshMs, initial, reduce, say, onChange, random = Math.random, now = Date.now } = options
  const leaseMs = options.leaseMs ?? refreshMs * 2
  const peers = new Map<string, RosterEntry<S>>()
  let answer: ReturnType<typeof setTimeout> | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let prune: ReturnType<typeof setInterval> | null = null
  let leave: (() => void) | null = null

  const answerStranger = () => {
    answer ??= setTimeout(
      () => {
        answer = null
        say('here')
      },
      ANSWER_MIN_MS + random() * ANSWER_SPREAD_MS
    )
  }

  /** Take one event; returns whether it was about a peer (and so handled here). */
  const observe = (event: E): boolean => {
    const { peer } = event
    if (!peer) return false
    if (peer.peerId === selfPeerId) return true
    const known = peers.get(peer.peerId)
    if (event.kind === 'presence') {
      if (event.state === 'gone') {
        if (peers.delete(peer.peerId)) onChange()
        return true
      }
      if (!known && peer.kind === 'person') answerStranger()
      const ttl = typeof event.ttlMs === 'number' ? event.ttlMs : leaseMs
      peers.set(peer.peerId, { peer, state: known?.state ?? initial(peer), expiresAt: now() + ttl })
      onChange()
      return true
    }
    if (!known && peer.kind === 'person') answerStranger()
    const next = reduce(known?.state ?? initial(peer), event)
    if (next === null) peers.delete(peer.peerId)
    else peers.set(peer.peerId, { peer, state: next, expiresAt: Math.max(known?.expiresAt ?? 0, now() + leaseMs) })
    onChange()
    return true
  }

  return {
    observe,
    /** Claim presence now: on every (re)connect. */
    hello: () => say('here'),
    /** Refresh the claim, prune expired peers, and withdraw the claim when the page goes. */
    start() {
      heartbeat ??= setInterval(() => say('here'), refreshMs)
      prune ??= setInterval(() => {
        const at = now()
        let changed = false
        for (const [id, entry] of peers) {
          if (entry.expiresAt >= at) continue
          peers.delete(id)
          changed = true
        }
        if (changed) onChange()
      }, PRUNE_MS)
      if (!leave && typeof window !== 'undefined') {
        leave = () => say('gone')
        window.addEventListener('pagehide', leave)
      }
    },
    /** Stop, withdraw the claim, and forget everyone. */
    stop() {
      if (heartbeat) clearInterval(heartbeat)
      if (prune) clearInterval(prune)
      if (answer) clearTimeout(answer)
      heartbeat = prune = answer = null
      if (leave) window.removeEventListener('pagehide', leave)
      leave = null
      say('gone')
      peers.clear()
    },
    /** Forget everyone without a word: the channel was closed on us. */
    clear() {
      if (peers.size === 0) return
      peers.clear()
      onChange()
    },
    entries: (): RosterEntry<S>[] => [...peers.values()],
    get size() {
      return peers.size
    },
  }
}

export type Roster<E extends PeerEvent, S> = ReturnType<typeof createRoster<E, S>>
