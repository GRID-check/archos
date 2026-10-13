/**
 * Who is in a channel right now, kept on the server so it can be read without
 * being in the channel (ADR-0104): the snapshot Piloti reads when it is asked
 * about what a person is looking at.
 *
 * The browsers' roster is gossip and stays so; this is a side record of the
 * same claims, written from what the server relays (`./send`, and the agent
 * path in `./document-channel`). It is NOT state to converge on either: TTL'd,
 * bounded, lossy, and correct only to within a second or so.
 *
 * ## Shape in Dragonfly
 *
 * One hash per channel and organization, `rt:roster:<org>:<channel key>`, one
 * field per peer and fact (`<peerId>|id`, `<peerId>|page`, …). A fact is its
 * own field so two replicas relaying two facts of one peer never overwrite each
 * other, and no write reads first. The `id` field carries the claim's expiry;
 * a peer whose claim ran out is dropped (and deleted) on read. The hash itself
 * expires {@link KEY_TTL_MS} after the last write, and holds at most
 * {@link MAX_PEERS} peers: a new peer past that is not recorded.
 *
 * Writes are coalesced per process and flushed every {@link FLUSH_MS}, so a
 * pointer moving twelve times a second costs one write a second at most.
 * Without `REDIS_URL` the same record is kept in this process.
 */

import 'server-only'
import type { RealtimePeer } from './types'

/** The facts kept per peer. All but `peer` and `expiresAt` are optional. */
export interface RosterFacts {
  /** The page the pointer was last on. */
  page?: number | null
  viewport?: { page: number; y: number } | null
  /** The Anmerkung (or other mark) the peer has selected. */
  selected?: string | null
  /** The region the peer is dragging out, with its page. */
  draft?: { page: number; x: number; y: number; w: number; h: number } | null
}

export interface RosterEntry extends Required<RosterFacts> {
  peer: RealtimePeer
  /** When the claim runs out, ms since the epoch. */
  expiresAt: number
}

export const MAX_PEERS = 64
export const KEY_TTL_MS = 60_000
export const FLUSH_MS = 1_000
const FACTS = ['page', 'viewport', 'selected', 'draft'] as const

/** The backing store: a hash per roster, fields set and deleted, read whole. */
export interface RosterBackend {
  write(key: string, set: Record<string, string>, remove: string[], ttlMs: number, maxIds: number): Promise<void>
  read(key: string): Promise<Record<string, string>>
  remove(key: string, fields: string[]): Promise<void>
}

export const rosterKey = (organizationId: string, channelKey: string) => `rt:roster:${organizationId}:${channelKey}`

// ── coalescing ──────────────────────────────────────────────────────────────

type Pending = { set: Map<string, string>; remove: Set<string> }
const pending = new Map<string, Pending>()
let timer: ReturnType<typeof setTimeout> | null = null

const pendingFor = (key: string): Pending => {
  let entry = pending.get(key)
  if (!entry) {
    entry = { set: new Map(), remove: new Set() }
    pending.set(key, entry)
  }
  return entry
}

function scheduleFlush(): void {
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    void flushRoster()
  }, FLUSH_MS)
  ;(timer as { unref?: () => void }).unref?.()
}

/** Record a peer's claim and any facts it carries. `ttlMs`: how long the claim holds. */
export function noteRosterPeer(key: string, peer: RealtimePeer, ttlMs: number, facts: RosterFacts = {}): void {
  const entry = pendingFor(key)
  const id = `${peer.peerId}|id`
  entry.remove.delete(id)
  entry.set.set(id, JSON.stringify({ peer, expiresAt: Date.now() + ttlMs }))
  for (const fact of FACTS) {
    if (facts[fact] === undefined) continue
    const field = `${peer.peerId}|${fact}`
    entry.remove.delete(field)
    entry.set.set(field, JSON.stringify(facts[fact]))
  }
  scheduleFlush()
}

/** A peer left. */
export function forgetRosterPeer(key: string, peerId: string): void {
  const entry = pendingFor(key)
  for (const fact of ['id', ...FACTS]) {
    entry.set.delete(`${peerId}|${fact}`)
    entry.remove.add(`${peerId}|${fact}`)
  }
  scheduleFlush()
}

/** Write what is pending. Never throws. */
export async function flushRoster(): Promise<void> {
  if (timer) clearTimeout(timer)
  timer = null
  const batch = [...pending.entries()]
  pending.clear()
  const store = getBackend()
  await Promise.all(
    batch.map(([key, { set, remove }]) =>
      store
        .write(key, Object.fromEntries(set), [...remove], KEY_TTL_MS, MAX_PEERS)
        .catch((error: unknown) => console.warn('[realtime] roster write failed:', error))
    )
  )
}

/** The peers in a roster now, at most {@link MAX_PEERS}, longest-present claim first. Never throws: `[]` on failure. */
export async function readRoster(key: string, now = Date.now()): Promise<RosterEntry[]> {
  let fields: Record<string, string>
  try {
    fields = await getBackend().read(key)
  } catch (error) {
    console.warn('[realtime] roster read failed:', error)
    return []
  }
  const byPeer = new Map<string, Record<string, unknown>>()
  for (const [field, raw] of Object.entries(fields)) {
    const cut = field.lastIndexOf('|')
    if (cut <= 0) continue
    const value = safeJson(raw)
    if (value === undefined) continue
    const peerId = field.slice(0, cut)
    const facts = byPeer.get(peerId) ?? {}
    facts[field.slice(cut + 1)] = value
    byPeer.set(peerId, facts)
  }
  const entries: RosterEntry[] = []
  const stale: string[] = []
  for (const [peerId, facts] of byPeer) {
    const id = facts.id as { peer?: RealtimePeer; expiresAt?: number } | undefined
    if (!id?.peer || typeof id.expiresAt !== 'number' || id.expiresAt < now) {
      stale.push(...['id', ...FACTS].map((fact) => `${peerId}|${fact}`))
      continue
    }
    entries.push({
      peer: id.peer,
      expiresAt: id.expiresAt,
      page: (facts.page as number | null | undefined) ?? null,
      viewport: (facts.viewport as RosterEntry['viewport'] | undefined) ?? null,
      selected: (facts.selected as string | null | undefined) ?? null,
      draft: (facts.draft as RosterEntry['draft'] | undefined) ?? null,
    })
  }
  if (stale.length > 0) void getBackend().remove(key, stale).catch(() => undefined)
  return entries.slice(0, MAX_PEERS)
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
}

// ── backends ────────────────────────────────────────────────────────────────

/** The record in this process: one replica, development, tests. */
export function createInProcessRosterBackend(now: () => number = Date.now): RosterBackend {
  const hashes = new Map<string, { fields: Map<string, string>; expiresAt: number }>()
  const live = (key: string) => {
    const hash = hashes.get(key)
    if (hash && hash.expiresAt < now()) hashes.delete(key)
    return hashes.get(key)
  }
  return {
    async write(key, set, remove, ttlMs, maxIds) {
      const hash = live(key) ?? { fields: new Map<string, string>(), expiresAt: 0 }
      for (const field of remove) hash.fields.delete(field)
      const ids = [...hash.fields.keys()].filter((field) => field.endsWith('|id')).length
      let room = maxIds - ids
      for (const [field, value] of Object.entries(set)) {
        const peerId = field.slice(0, field.lastIndexOf('|'))
        const known = hash.fields.has(`${peerId}|id`)
        if (!known && field.endsWith('|id')) {
          if (room <= 0) continue
          room -= 1
        } else if (!known && !(`${peerId}|id` in set)) continue
        hash.fields.set(field, value)
      }
      hash.expiresAt = now() + ttlMs
      hashes.set(key, hash)
    },
    async read(key) {
      return Object.fromEntries(live(key)?.fields ?? [])
    },
    async remove(key, fields) {
      const hash = live(key)
      for (const field of fields) hash?.fields.delete(field)
    },
  }
}

interface RedisCommands {
  hgetall(key: string): Promise<Record<string, string>>
  hdel(key: string, ...fields: string[]): Promise<unknown>
  hkeys(key: string): Promise<string[]>
  multi(): { hset(key: string, values: Record<string, string>): unknown; hdel(key: string, ...fields: string[]): unknown; pexpire(key: string, ms: number): unknown; exec(): Promise<unknown> }
  on(event: string, listener: (error: unknown) => void): unknown
}

/** Dragonfly: the record every replica shares. */
export function createRedisRosterBackend(url: string): RosterBackend {
  // Lazy require keeps ioredis out of bundles that never set REDIS_URL.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const IORedis = require('ioredis')
  const client = new IORedis(url, {
    connectTimeout: 1000,
    commandTimeout: 1000,
    maxRetriesPerRequest: 1,
    // A roster write is a second late or not at all; queue the first rather than lose it to a cold connection.
    enableOfflineQueue: true,
    lazyConnect: false,
  }) as RedisCommands
  client.on('error', (error) => console.warn('[realtime] roster redis error:', error))
  return {
    async write(key, set, remove, ttlMs, maxIds) {
      const fields = Object.entries(set)
      const newIds = fields.filter(([field]) => field.endsWith('|id'))
      let admitted = set
      if (newIds.length > 0) {
        // Bound the roster: a new peer past the cap is not recorded. Racy by a write or two across replicas, which is fine.
        const known = new Set(await client.hkeys(key))
        let room = maxIds - [...known].filter((field) => field.endsWith('|id')).length
        admitted = {}
        for (const [field, value] of fields) {
          const peerId = field.slice(0, field.lastIndexOf('|'))
          if (!known.has(`${peerId}|id`)) {
            if (!(`${peerId}|id` in set)) continue
            if (field.endsWith('|id')) {
              if (room <= 0) continue
              room -= 1
            }
          }
          admitted[field] = value
        }
      }
      const tx = client.multi()
      if (remove.length > 0) tx.hdel(key, ...remove)
      if (Object.keys(admitted).length > 0) tx.hset(key, admitted)
      tx.pexpire(key, ttlMs)
      await tx.exec()
    },
    read: (key) => client.hgetall(key),
    async remove(key, fields) {
      if (fields.length > 0) await client.hdel(key, ...fields)
    },
  }
}

let backend: RosterBackend | null = null

function getBackend(): RosterBackend {
  if (backend) return backend
  const url = process.env.REDIS_URL
  try {
    backend = url ? createRedisRosterBackend(url) : createInProcessRosterBackend()
  } catch (error) {
    console.warn('[realtime] no redis roster, keeping it in-process:', error)
    backend = createInProcessRosterBackend()
  }
  return backend
}

/** Test seam: a backend (or the default again), and nothing pending. */
export function __setRosterBackendForTests(next: RosterBackend | null): void {
  if (timer) clearTimeout(timer)
  timer = null
  pending.clear()
  backend = next
}
