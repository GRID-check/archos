/**
 * What a live channel is (ADR-0110): a kind of key, the topics it listens to,
 * who may be in it, and what may be said in it.
 *
 * A channel kind is declared once with {@link defineChannel} and listed in
 * `./registry`. The stream (`./stream`) and the send path (`./send`) are the
 * only code that reads a definition, so authorization, re-authorization, the
 * rate limit and the identity stamp are written once for every channel.
 */

import 'server-only'
import type { ZodType } from 'zod'
import { ApiError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { LimitRule } from '@/lib/limits'
import type { RealtimePeer, UpstreamBase } from './types'

export interface ChannelDefinition<TParams = unknown, TUp extends UpstreamBase = UpstreamBase> {
  /** The key's prefix: `doc` for `doc:<id>`. */
  readonly kind: string
  /** The params of the part after `<kind>:`, or null when it names nothing this kind knows. */
  parse(id: string): TParams | null
  /**
   * The hub topics the channel listens to, in the session's organization. The
   * FIRST is the channel's own: upstream messages are published there; any
   * further topic is listened to only. A channel whose key names a resource
   * with no id of its own (the tenant's Archiv) scopes its topic by the
   * organization; one keyed by a unique id may ignore it.
   */
  topics(params: TParams, organizationId: string): readonly [string, ...string[]]
  /** Throws (404/403) when the session may not be in the channel. Called uncached on open and every re-check. */
  authorize(session: AuthorizedSession, params: TParams): Promise<void>
  /** Throws when the session may not send. Defaults to `authorize`; the send path caches either for `reauthorizeMs`. */
  authorizeSend?(session: AuthorizedSession, params: TParams): Promise<void>
  /** How often an open stream re-checks `authorize`, and how long a send grant is remembered. */
  readonly reauthorizeMs: number
  /** What may travel down. A hub message that does not parse is dropped rather than guessed at. */
  readonly events: ZodType<{ kind: string }>
  /** What a browser may say, if anything. */
  readonly upstream?: {
    readonly schema: ZodType<TUp>
    /** Spent once per message, per member and channel (`./send`), by a message no lane takes. */
    readonly limit: LimitRule
    /**
     * Lanes a message may travel in instead, each with a budget of its own and,
     * when it needs more than being in the channel, an authorization of its
     * own (`./send`). A message is in every lane one of whose `fields` it
     * carries (`presence` counts for a lane with `presence: true`), spends
     * each one's budget and must pass each guarded one, so a reader cannot
     * slip an edit past the edit lane, or a field past its budget, by adding
     * a claim. A burst of motion
     * therefore never refuses the claim that keeps a person in the channel,
     * and a reader's pointer never spends a writer's edit budget.
     */
    readonly lanes?: ReadonlyArray<SendLane<TParams>>
    /** The ephemeral events a message becomes. Presence is handled before this, from `msg.presence`. */
    handle(msg: TUp, peer: RealtimePeer, params: TParams): Array<{ kind: string }>
  }
  /** Present when the channel keeps a gossip roster: the claim's TTL and the client's refresh cadence. */
  readonly presence?: { readonly ttlMs: number; readonly refreshMs: number }
  /** Told of every event the send path published, for a side record (the server roster, `./roster`). Must not throw. */
  observe?(events: ReadonlyArray<{ kind: string }>, params: TParams, organizationId: string): void
}

/** A lane of a channel's upstream: which messages travel in it, what they spend, and who may send them. */
export interface SendLane<TParams = unknown> {
  /** Names the lane's send grant (`<key>#<name>`) and nothing else. */
  readonly name: string
  /** A message carrying any of these fields travels in this lane. */
  readonly fields: readonly string[]
  /** Whether a presence claim travels in this lane too. */
  readonly presence?: boolean
  /** Spent once per message in the lane, per member and channel. */
  readonly limit: LimitRule
  /** Throws when the session may not send in this lane, beyond being allowed in the channel. Cached like the channel's grant. */
  authorize?(session: AuthorizedSession, params: TParams): Promise<void>
}

/** Declare a channel kind. Identity at runtime; the type keeps `parse`, `topics` and `upstream` agreeing on params. */
export function defineChannel<TParams, TUp extends UpstreamBase = UpstreamBase>(
  definition: ChannelDefinition<TParams, TUp>
): ChannelDefinition<TParams, TUp> {
  return definition
}

/**
 * A definition with its params erased, as the registry holds it. Sound because
 * the params a stream or a send hands back to a definition are always the ones
 * its own `parse` produced.
 */
export type AnyChannel = ChannelDefinition<unknown, UpstreamBase>

/** Whether an error is a refusal of access, as opposed to a failure while asking. */
export function isAccessRefusal(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 401 || error.status === 403 || error.status === 404)
}

// ── send grants ─────────────────────────────────────────────────────────────

/**
 * A grant to send in a channel, remembered for the channel's `reauthorizeMs`.
 * A pointer arrives up to twelve times a second, and resolving folder access
 * for each one would cost more than the pointer is worth. A revoked reader can
 * therefore keep sending for at most that long, to a channel whose stream the
 * re-check already closed on them.
 */
const grants = new Map<string, number>()
const MAX_GRANTS = 5_000

const grantKey = (session: AuthorizedSession, key: string) => `${session.organizationId}:${session.userId}:${key}`

async function grant(id: string, reauthorizeMs: number, now: number, check: () => Promise<void>): Promise<void> {
  const until = grants.get(id)
  if (until && until > now) return
  await check()
  if (grants.size >= MAX_GRANTS) grants.clear()
  grants.set(id, now + reauthorizeMs)
}

/**
 * Check that a session may send in a channel and, for each guarded lane the
 * message travels in or touches, in that lane too: each grant remembered for
 * the channel's `reauthorizeMs`, under the channel's key and under
 * `<key>#<lane>` respectively.
 */
export async function authorizeSendCached(
  session: AuthorizedSession,
  channel: AnyChannel,
  params: unknown,
  key: string,
  now = Date.now(),
  lanes: ReadonlyArray<SendLane> = []
): Promise<void> {
  const id = grantKey(session, key)
  await grant(id, channel.reauthorizeMs, now, () => (channel.authorizeSend ?? channel.authorize).call(channel, session, params))
  for (const lane of lanes) {
    if (!lane.authorize) continue
    await grant(`${id}#${lane.name}`, channel.reauthorizeMs, now, () => lane.authorize!.call(lane, session, params))
  }
}

/** Forget a send grant, the channel's and its lanes': an open stream's re-check is never answered from it, and a refusal ends it. */
export function forgetSendGrant(session: AuthorizedSession, key: string): void {
  const id = grantKey(session, key)
  grants.delete(id)
  for (const known of [...grants.keys()]) if (known.startsWith(`${id}#`)) grants.delete(known)
}

/** Clear the remembered grants: for tests. */
export function __resetGrantsForTests(): void {
  grants.clear()
}
