'use client'

/**
 * A surface kept current by a hint channel (ADR-0110): the client half of
 * "nothing live is state". The channel says that something changed; the
 * surface re-reads through its API. This hook owns the part every such surface
 * needs and would otherwise write again:
 *
 * - **Bursts are one re-read.** Hints are folded (`fold`) for `coalesceMs`, plus
 *   up to `jitterMs` at random, so twenty viewers of one object do not re-read
 *   in step after a colleague's bulk change.
 * - **A missed hint is not lost.** Every time the channel comes up (the first
 *   time, after a drop, after a phone woke, after the tab's connection
 *   reopened for another channel, which the server's welcome marks) the
 *   surface is told `resync`, its "read everything" change.
 * - **Nothing after unmount.** A pending re-read dies with the surface.
 * - **Not while the surface is busy.** `holdWhile` says the surface has
 *   optimistic writes on the wire (the Files workspace's moves): a re-read then
 *   would put rows back that are about to leave. The burst is kept, still
 *   folding every hint that arrives, and asked again every `holdMs`.
 *
 * The surface's own echo arrives too, and re-reading it is harmless: the
 * answer is the server's truth.
 */

import { useEffect, useRef } from 'react'
import { useChannel, type ChannelLink } from './use-channel'

/** How long a burst of hints is gathered into one re-read. */
export const LIVE_HINT_COALESCE_MS = 400

/** Up to this much more, at random, per burst, so the viewers of one object do not re-read in step. */
export const LIVE_HINT_JITTER_MS = 600

export interface LiveHintOptions<E extends { kind: string }, C> {
  enabled?: boolean
  /** The channel's vocabulary: a hint, or null to drop what does not parse. */
  parse(event: unknown): E | null
  /** Fold a hint into the change gathered so far (`null` at the start of a burst). */
  fold(gathered: C | null, event: E): C
  /** The change to deliver whenever the channel comes up: whatever changed while nobody listened. */
  resync: C
  /** One call per burst, with the folded change. Need not be stable. */
  onChange(change: C): void
  /** Defaults to the tab's shared connection. Keep it stable. */
  link?: ChannelLink
  coalesceMs?: number
  jitterMs?: number
  /** True while a re-read would undo the surface's own optimistic writes. Need not be stable. */
  holdWhile?: () => boolean
  /** How often a held burst asks again. */
  holdMs?: number
}

/** How often a held burst asks again whether the surface is still busy. */
export const LIVE_HINT_HOLD_MS = 500

export function useLiveHints<E extends { kind: string }, C>(
  key: string | null,
  {
    enabled = true,
    parse,
    fold,
    resync,
    onChange,
    link,
    coalesceMs = LIVE_HINT_COALESCE_MS,
    jitterMs = LIVE_HINT_JITTER_MS,
    holdWhile,
    holdMs = LIVE_HINT_HOLD_MS,
  }: LiveHintOptions<E, C>
): void {
  const latest = useRef({ fold, resync, onChange, coalesceMs, jitterMs, holdWhile, holdMs })
  latest.current = { fold, resync, onChange, coalesceMs, jitterMs, holdWhile, holdMs }
  const pending = useRef<{ change: C } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flush = useRef((): void => {
    timer.current = null
    if (latest.current.holdWhile?.()) {
      // Kept, not dropped: hints that arrive meanwhile still fold into it.
      timer.current = setTimeout(() => flush.current(), latest.current.holdMs)
      return
    }
    const due = pending.current
    pending.current = null
    if (due) latest.current.onChange(due.change)
  })
  const gather = useRef((change: (gathered: C | null) => C) => {
    pending.current = { change: change(pending.current?.change ?? null) }
    if (timer.current) return
    const { coalesceMs: wait, jitterMs: spread } = latest.current
    timer.current = setTimeout(() => flush.current(), wait + Math.random() * spread)
  })

  const { status, self } = useChannel<E>(key, {
    enabled,
    link,
    parse,
    onEvent: (event) => gather.current((gathered) => latest.current.fold(gathered, event)),
  })

  // Up: everything once. The welcome comes with every (re)connect that carries
  // the channel, including the reopen for a changed channel set, which goes
  // from live to live without the status ever reading offline.
  useEffect(() => {
    if (status === 'live') gather.current(() => latest.current.resync)
  }, [status, self])

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
      pending.current = null
    },
    [key]
  )
}
