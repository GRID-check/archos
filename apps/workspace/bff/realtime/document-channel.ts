/**
 * The document room as a live channel: `doc:<documentId>` (ADR-0110; the
 * vocabulary is `lib/annotations/room-types.ts`).
 *
 * Being in the room is reading the document: `getAccessibleDocument(read)`,
 * so a held upload, a restricted folder and a document of another tenant have
 * no room for this reader, by the same rule that hides the document.
 *
 * Besides the browsers, two server-side speakers write into the room, and
 * neither authorizes here, because each follows a decision that was made:
 *
 * - the Anmerkungen service, whose every write is an `annotations.changed`
 *   hint ({@link publishToDocumentRoom});
 * - Piloti, a participant of its own on the canvas ({@link publishAsAgent}):
 *   present, pointing, saying what it does, and highlighting a region. Its
 *   identity is stamped here, `kind: 'piloti'`, one peer per conversation,
 *   with the name of the person it acts for (`forName`), so the room always
 *   sees whose request it works on (ADR-0105; EU AI Act Art. 50). A browser
 *   cannot be Piloti, nor say whom it acts for: the send path stamps every
 *   browser `person` from its session, and the browser's vocabulary
 *   (`roomPostSchema`) has no activity, highlight, label or `forName` to send.
 *
 * A Skizze's editor speaks in the same room (`lib/diagrams/sketch-room-types.ts`):
 * its canvas pointer and selection are motion any reader may send, as are the
 * scene's hash and a request for the whole scene, so a reader in view mode
 * points and stays in step. Its edits (`delta`, `saved`) travel in a lane of
 * their own, which asks for write access to the document and spends
 * `SKETCH_EDIT_LIMIT`. A request for the whole scene (`want`) is any reader's,
 * and spends a small budget of its own (`SKETCH_WANT_LIMIT`), since every
 * writer answers it with the whole scene. A revoked writer can go on sending for at most
 * {@link DOCUMENT_REAUTHORIZE_MS}, as a revoked reader can.
 *
 * Every relayed claim and fact also lands in the server roster (`./roster`),
 * which {@link roomSnapshot} reads: who is here, on which page, scrolled where,
 * with which mark selected and which region half drawn.
 */

import 'server-only'
import { getAccessibleDocument } from '@/lib/documents/access'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
import { ROOM_CLAIM_LIMIT, ROOM_LIMIT, SKETCH_EDIT_LIMIT, SKETCH_WANT_LIMIT } from '@/lib/limits'
import { SKETCH_EDIT_FIELDS, sketchEventsOf } from '@/lib/diagrams/sketch-room-types'
import {
  CURSOR_CHAT_MAX,
  HIGHLIGHT_TTL_MS,
  PRESENCE_REFRESH_MS,
  PRESENCE_TTL_MS,
  roomEventSchema,
  roomPostSchema,
  type AgentActivityState,
  type RoomBox,
  type RoomCursor,
  type RoomEvent,
  type RoomPeer,
} from '@/lib/annotations/room-types'
import { defineChannel } from './channel'
import { publish } from './hub'
import { flushRoster, forgetRosterPeer, noteRosterPeer, readRoster, rosterKey, type RosterEntry, type RosterFacts } from './roster'

/** How often an open stream checks that its reader may still read the document. */
export const DOCUMENT_REAUTHORIZE_MS = 30_000

/** How long a sign of life that is not a presence claim keeps a peer in the server roster. */
const LEASE_MS = PRESENCE_REFRESH_MS * 2

const DOCUMENT_ID = /^[A-Za-z0-9_-]{1,128}$/

/** The channel key a browser opens for a document. */
export const documentChannelKey = (documentId: string) => `doc:${documentId}`

/** The hub topic the room travels on. */
export const documentRoomTopic = (documentId: string) => `rt:doc:${documentId}`

/** The sketch's edits and repair: they keep nobody in the roster and say nothing Piloti's snapshot reads. */
const NOT_RECORDED = new Set<string>(['scene.delta', 'scene.hash', 'scene.want', 'scene.saved'])

/** Note what was said in a room in its server roster. */
function observeRoom(documentId: string, organizationId: string, events: ReadonlyArray<{ kind: string }>): void {
  const key = rosterKey(organizationId, documentChannelKey(documentId))
  for (const raw of events) {
    const event = raw as RoomEvent
    if (event.kind === 'annotations.changed' || event.kind === 'version.published' || NOT_RECORDED.has(event.kind)) continue
    if (event.kind === 'presence') {
      if (event.state === 'gone') forgetRosterPeer(key, event.peer.peerId)
      else noteRosterPeer(key, event.peer, event.ttlMs)
      continue
    }
    const facts: RosterFacts = {}
    if (event.kind === 'cursor') {
      facts.page = event.cursor?.page ?? null
      if (event.draft !== undefined || !event.cursor) {
        facts.draft = event.cursor && event.draft ? { page: event.cursor.page, ...event.draft } : null
      }
    } else if (event.kind === 'viewport') {
      if (event.viewport) facts.viewport = event.viewport
      if (event.selected !== undefined) facts.selected = event.selected
    }
    noteRosterPeer(key, event.peer, LEASE_MS, facts)
  }
}

export const documentChannel = defineChannel({
  kind: 'doc',
  parse: (id) => (DOCUMENT_ID.test(id) ? { documentId: id } : null),
  topics: ({ documentId }) => [documentRoomTopic(documentId)],
  authorize: async (session, { documentId }) => {
    await getAccessibleDocument(session, documentId, 'read')
  },
  reauthorizeMs: DOCUMENT_REAUTHORIZE_MS,
  events: roomEventSchema,
  presence: { ttlMs: PRESENCE_TTL_MS, refreshMs: PRESENCE_REFRESH_MS },
  upstream: {
    schema: roomPostSchema,
    limit: ROOM_LIMIT,
    lanes: [
      // A sketch's edits: a writer's only, and never spent by anyone's motion.
      {
        name: 'sketch-edit',
        fields: SKETCH_EDIT_FIELDS,
        limit: SKETCH_EDIT_LIMIT,
        authorize: async (session, { documentId }) => {
          await getAccessibleDocument(session, documentId, 'write')
        },
      },
      // Asking for the whole scene makes every writer answer with it: its own small budget, any reader's.
      { name: 'sketch-want', fields: ['want'], limit: SKETCH_WANT_LIMIT },
      // Presence and the selected mark are claims: motion must never refuse them.
      { name: 'claim', fields: ['selected'], presence: true, limit: ROOM_CLAIM_LIMIT },
    ],
    handle: (post, peer) => {
      const events: RoomEvent[] = []
      if (post.cursor !== undefined) {
        events.push({
          kind: 'cursor',
          peer,
          cursor: post.cursor,
          tool: post.tool,
          ...(post.draft !== undefined ? { draft: post.cursor ? post.draft : null } : {}),
          ...(post.chat !== undefined ? { chat: post.chat || null } : {}),
        })
      }
      if (post.viewport || post.selected !== undefined) {
        events.push({
          kind: 'viewport',
          peer,
          ...(post.viewport ? { viewport: post.viewport } : {}),
          ...(post.selected !== undefined ? { selected: post.selected } : {}),
        })
      }
      events.push(...sketchEventsOf(post, peer))
      return events
    },
  },
  observe: (events, { documentId }, organizationId) => observeRoom(documentId, organizationId, events),
})

/** Publish one event to everyone in a document's room. Never throws. */
export async function publishToDocumentRoom(documentId: string, event: RoomEvent): Promise<void> {
  await publish(documentRoomTopic(documentId), event)
}

// ── Piloti in the room ──────────────────────────────────────────────────────

/**
 * Who Piloti is in a room: one peer per conversation, so two conversations
 * working on one document are two, carrying the name of the person it acts
 * for when there is one.
 */
export function agentPeer(conversationId: string, onBehalfOf: string, forName?: string | null): RoomPeer {
  const id = conversationId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 56)
  const name = forName?.trim().slice(0, 120)
  return {
    peerId: `piloti-${id}`.padEnd(8, '0'),
    userId: onBehalfOf,
    name: 'Piloti',
    kind: 'piloti',
    ...(name ? { forName: name } : {}),
  }
}

/**
 * The display name of the person Piloti acts for, from the organization
 * directory (itself cached per organization). Fails open to no name: a WorkOS
 * hiccup costs the „für Anna" on the canvas, never Piloti's move.
 */
async function actingName(organizationId: string, userId: string): Promise<string | null> {
  const directory = await loadOrganizationDirectory(organizationId).catch(() => null)
  return directory?.get(userId)?.name ?? null
}

/** What Piloti can do in a room. Boxes and points are shares of the page, 0…1, top-left origin. */
export type AgentRoomOp =
  /** Enter (refresh within {@link PRESENCE_TTL_MS}, or it times out of every roster) or leave the room. */
  | { op: 'presence'; state: 'here' | 'gone' }
  /** Point at a spot, with a few words beside the pointer; `null` takes the pointer off the pages. */
  | { op: 'cursor'; cursor: RoomCursor | null; label?: string }
  /** Say what it is doing („sieht sich Seite 2 an"), optionally with the region it reads; `idle` clears it. */
  | { op: 'activity'; label?: string; state?: AgentActivityState; box?: RoomBox }
  /** Draw a box for a moment to show what it means. */
  | { op: 'highlight'; box: RoomBox; label?: string; ttlMs?: number }

const label = (text: string | undefined) => {
  const trimmed = text?.trim().slice(0, CURSOR_CHAT_MAX)
  return trimmed ? { label: trimmed } : {}
}

/** The room event an agent op becomes, validated as any other room event. Throws on a malformed op. */
export function agentRoomEvent(peer: RoomPeer, op: AgentRoomOp): RoomEvent {
  const event: RoomEvent =
    op.op === 'presence'
      ? { kind: 'presence', peer, state: op.state, ttlMs: PRESENCE_TTL_MS }
      : op.op === 'cursor'
        ? { kind: 'cursor', peer, cursor: op.cursor, tool: 'select', ...label(op.label) }
        : op.op === 'activity'
          ? { kind: 'activity', peer, state: op.state ?? 'reading', ...(op.box ? { box: op.box } : {}), ...label(op.label) }
          : { kind: 'highlight', peer, box: op.box, ttlMs: op.ttlMs ?? HIGHLIGHT_TTL_MS, ...label(op.label) }
  return roomEventSchema.parse(event)
}

/**
 * Act in a document's room as Piloti. The CALLER has authorized: the asker
 * whose conversation this is may read the document. Never fails on delivery;
 * throws only for a malformed op (a box outside the page, a label too long).
 */
export async function publishAsAgent(
  documentId: string,
  organizationId: string,
  agent: { conversationId: string; onBehalfOf: string },
  op: AgentRoomOp
): Promise<RoomEvent> {
  const forName = await actingName(organizationId, agent.onBehalfOf)
  const event = agentRoomEvent(agentPeer(agent.conversationId, agent.onBehalfOf, forName), op)
  await publishToDocumentRoom(documentId, event)
  observeRoom(documentId, organizationId, [event])
  return event
}

/** One participant of a room, as the server last heard of them. */
export interface RoomSnapshotPeer {
  peerId: string
  userId: string
  name: string
  kind: 'person' | 'piloti'
  /** For Piloti: the person it acts for. */
  forName?: string
  /** The page their pointer was last on; null when it is off the pages or never was on them. */
  page: number | null
  viewport: { page: number; y: number } | null
  /** The Anmerkung they have selected. */
  selected: string | null
  /** The region they are dragging out. */
  draft: { page: number; x: number; y: number; w: number; h: number } | null
  /** When their claim runs out, ISO 8601. */
  expiresAt: string
}

const toSnapshotPeer = (entry: RosterEntry): RoomSnapshotPeer => ({
  peerId: entry.peer.peerId,
  userId: entry.peer.userId,
  name: entry.peer.name,
  kind: entry.peer.kind,
  ...(entry.peer.forName ? { forName: entry.peer.forName } : {}),
  page: entry.page,
  viewport: entry.viewport,
  selected: entry.selected,
  draft: entry.draft,
  expiresAt: new Date(entry.expiresAt).toISOString(),
})

/** How much of what Piloti reads a tab carries: a selection, a region half drawn, a scroll, a page. */
const actingFacts = (entry: RosterEntry) =>
  [entry.selected, entry.draft, entry.viewport, entry.page].filter((fact) => fact !== null && fact !== undefined).length

/**
 * One entry per person: a person in two tabs (or a tab that joined twice) is
 * one participant to Piloti, as the tab they act in, the one carrying the most
 * of a selection, a region, a scroll and a page (an editor beside an idle
 * preview), and of equals the one heard last. Piloti stays one per conversation.
 */
function onePerPerson(entries: readonly RosterEntry[]): RosterEntry[] {
  const people = new Map<string, RosterEntry>()
  const rest: RosterEntry[] = []
  const wins = (entry: RosterEntry, known: RosterEntry) =>
    actingFacts(entry) - actingFacts(known) || entry.expiresAt - known.expiresAt
  for (const entry of entries) {
    if (entry.peer.kind !== 'person') {
      rest.push(entry)
      continue
    }
    const known = people.get(entry.peer.userId)
    if (!known || wins(entry, known) > 0) people.set(entry.peer.userId, entry)
  }
  return entries.filter((entry) => rest.includes(entry) || people.get(entry.peer.userId) === entry)
}

/**
 * Who is in a document's room now, as the server last heard (within about a
 * second; `./roster`), one entry per person. Bounded and TTL'd; `[]` when
 * nobody is or the store is down. The CALLER has authorized the reader.
 */
export async function roomSnapshot(documentId: string, organizationId: string): Promise<RoomSnapshotPeer[]> {
  // This process's own last second goes first, so Piloti sees what was just said here.
  await flushRoster()
  const entries = await readRoster(rosterKey(organizationId, documentChannelKey(documentId)))
  return onePerPerson(entries).map(toSnapshotPeer)
}
