'use client'

/**
 * What the `canvas_activity` card reads about its document: where each mark
 * stands now, and the first page's picture.
 *
 * The marks are a live view (ADR-0105: the card is a live receipt of the
 * objects the turn produced). The card reads them once it has been seen, and
 * while it is on screen it listens to the document's room (`doc:<id>`,
 * ADR-0104) and reads them again on every `annotations.changed`, debounced as
 * the review does it. The hint is never the data: every change is a fresh
 * read through the annotations client.
 *
 * ## One subscription per document, not per card
 *
 * A chat can hold many cards on one document, and the tab's connection carries
 * at most {@link MAX_CHANNELS_PER_CONNECTION} channels. So the cards of a tab
 * share one record per document, kept in this module: one join of the
 * document's channel however many of its cards are on screen, one debounced
 * read per burst of hints, and one list every card renders from. The channel
 * is joined when the first card on that document comes on screen and left
 * when the last one leaves the screen or unmounts.
 *
 * The cards together hold at most {@link CARD_CHANNEL_BUDGET} documents' channels,
 * the first that came on screen; the rest of the connection is left to the
 * surfaces that need a channel to work (the review's room). A card past the
 * budget still reads on sight and shows no live indicator; it is promoted, and
 * reads again, when a channel frees up.
 *
 * Both reads fail soft: a card that cannot read the live list falls back to
 * the decision its message stored, and one with no thumbnail draws a plain
 * page.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { listAnnotations } from '@/lib/annotations/client'
import { roomEventSchema } from '@/lib/annotations/room-types'
import type { AnnotationView } from '@/lib/annotations/types'
import { MAX_CHANNELS_PER_CONNECTION } from '@/lib/realtime/types'
import type { ChannelStatus } from '@/features/realtime/connection'
import { realtimeLink } from '@/features/realtime/use-channel'
import { documentRoomChannel } from '@/features/documents/hooks/use-document-room'
import type { LiveMark } from '../lib/canvas-activity'

/** A burst of hints (a batch of replies) is one read; the review waits as long (`use-document-review.ts`). */
export const CHANGE_DEBOUNCE_MS = 120

/** How many document channels the cards of one tab hold at once: half the connection, the rest is the review's. */
export const CARD_CHANNEL_BUDGET = MAX_CHANNELS_PER_CONNECTION / 2

const liveOf = (annotation: AnnotationView): LiveMark => ({
  status: annotation.status,
  canEdit: annotation.canEdit,
  acceptedByName: annotation.acceptedByName,
  closedByName: annotation.closedByName,
  assigneeUserId: annotation.assigneeUserId,
  dueOn: annotation.dueOn,
  kind: annotation.kind,
  body: annotation.body,
})

export interface LiveMarks {
  /**
   * One mark as the canvas has it now: undefined while unknown (not read yet,
   * or the read failed), `gone` when the list was read and no longer holds it.
   */
  lookup: (annotationId: string) => LiveMark | 'gone' | undefined
  /** Read the list again. Resolves to the fresh lookup, or null when the read failed. */
  refresh: () => Promise<((annotationId: string) => LiveMark | 'gone') | null>
  /** Adopt what a write returned, without a second read. */
  adopt: (annotation: AnnotationView) => void
  /** Drop one mark that a write found missing (404). */
  forget: (annotationId: string) => void
  /** Whether the document's live channel is open for this card now: changes on the canvas reach it. */
  connected: boolean
}

type MarkMap = ReadonlyMap<string, LiveMark | 'gone'>

const lookupIn =
  (marks: MarkMap) =>
  (annotationId: string): LiveMark | 'gone' =>
    marks.get(annotationId) ?? 'gone'

// ── The tab's shared record per document ────────────────────────────────────

interface DocumentMarks {
  /** The last list read, by whichever card asked. */
  list: MarkMap | null
  /** Reads started and the newest applied, so a slow old read never overwrites a newer one. */
  started: number
  applied: number
  reading: Promise<MarkMap | null> | null
  /** One more read queued behind the one in flight, for a caller that needs what happened after it started. */
  again: Promise<MarkMap | null> | null
  /** The React subscribers: every mounted card on this document. */
  renders: Set<() => void>
  /** The cards on this document that are on screen now. */
  watchers: number
  /** When the first of them came on screen, for the budget's order. */
  since: number
  /** The leave of the channel, while joined. */
  leave: (() => void) | null
  status: ChannelStatus | 'off'
  debounce: ReturnType<typeof setTimeout> | null
}

const documents = new Map<string, DocumentMarks>()
let watchOrder = 0

function recordOf(documentId: string): DocumentMarks {
  let record = documents.get(documentId)
  if (!record) {
    record = {
      list: null,
      started: 0,
      applied: 0,
      reading: null,
      again: null,
      renders: new Set(),
      watchers: 0,
      since: 0,
      leave: null,
      status: 'off',
      debounce: null,
    }
    documents.set(documentId, record)
  }
  return record
}

const notify = (record: DocumentMarks) => {
  for (const render of [...record.renders]) render()
}

/** Forget a document nobody shows any more, so a card mounted later starts from its own read. */
function prune(documentId: string, record: DocumentMarks): void {
  if (record.renders.size > 0 || record.watchers > 0 || record.reading) return
  if (documents.get(documentId) === record) documents.delete(documentId)
}

function startRead(documentId: string, record: DocumentMarks): Promise<MarkMap | null> {
  const ticket = ++record.started
  const reading = listAnnotations(documentId)
    .then((response) => {
      const next: MarkMap = new Map(response.annotations.map((annotation) => [annotation.id, liveOf(annotation)]))
      if (ticket > record.applied) {
        record.applied = ticket
        record.list = next
        notify(record)
      }
      return record.list
    })
    .catch(() => null)
    .finally(() => {
      if (record.reading === reading) record.reading = null
      prune(documentId, record)
    })
  record.reading = reading
  return reading
}

/**
 * Read a document's marks for every card on it.
 *
 * `fresh: false` joins a read already in flight (the first sight, a catch-up).
 * `fresh: true` is for a caller that knows something changed after that read
 * may have started (a hint, a 409): it queues one more read behind it, shared
 * by everyone who asks while it waits.
 */
function readMarks(documentId: string, { fresh }: { fresh: boolean }): Promise<MarkMap | null> {
  const record = recordOf(documentId)
  if (!record.reading) return startRead(documentId, record)
  if (!fresh) return record.reading
  record.again ??= record.reading.then(() => {
    record.again = null
    return record.reading ?? startRead(documentId, record)
  })
  return record.again
}

function setStatus(record: DocumentMarks, status: DocumentMarks['status']): void {
  if (record.status === status) return
  record.status = status
  notify(record)
}

function onChanged(documentId: string, record: DocumentMarks): void {
  if (record.debounce) clearTimeout(record.debounce)
  record.debounce = setTimeout(() => {
    record.debounce = null
    void readMarks(documentId, { fresh: true })
  }, CHANGE_DEBOUNCE_MS)
}

function join(documentId: string, record: DocumentMarks): void {
  if (record.leave) return
  setStatus(record, 'connecting')
  const link = realtimeLink(documentRoomChannel(documentId))
  record.leave = link.connect({
    onOpen: () => {
      // Back from a drop: nothing is replayed, so whatever changed meanwhile is read.
      if (record.status === 'offline') void readMarks(documentId, { fresh: false })
      setStatus(record, 'live')
    },
    onDrop: () => setStatus(record, 'offline'),
    onFrame: (frame) => {
      if (frame.kind === 'revoked') return setStatus(record, 'offline')
      if (frame.kind === 'welcome') return setStatus(record, 'live')
      const parsed = roomEventSchema.safeParse(frame.event)
      if (parsed.success && parsed.data.kind === 'annotations.changed') onChanged(documentId, record)
    },
  })
  // Whatever changed while nobody listened (off screen, past the budget) is read now.
  void readMarks(documentId, { fresh: false })
}

function part(record: DocumentMarks): void {
  if (record.debounce) clearTimeout(record.debounce)
  record.debounce = null
  const leave = record.leave
  record.leave = null
  leave?.()
  setStatus(record, 'off')
}

/** Hold the first {@link CARD_CHANNEL_BUDGET} watched documents' channels, in the order they came on screen. */
function rebalance(): void {
  const watched = [...documents.entries()]
    .filter(([, record]) => record.watchers > 0)
    .sort(([, a], [, b]) => a.since - b.since)
  watched.forEach(([documentId, record], index) => {
    if (index < CARD_CHANNEL_BUDGET) join(documentId, record)
    else part(record)
  })
}

/** A card on this document came on screen. Returns its leaving, which is idempotent. */
function watchDocument(documentId: string): () => void {
  const record = recordOf(documentId)
  if (record.watchers++ === 0) record.since = ++watchOrder
  rebalance()
  let left = false
  return () => {
    if (left) return
    left = true
    record.watchers -= 1
    if (record.watchers > 0) return
    part(record)
    rebalance()
    prune(documentId, record)
  }
}

function subscribeTo(documentId: string, render: () => void): () => void {
  const record = recordOf(documentId)
  record.renders.add(render)
  return () => {
    record.renders.delete(render)
    prune(documentId, record)
  }
}

const currentList = (documentId: string): MarkMap | null => documents.get(documentId)?.list ?? null
const isConnected = (documentId: string): boolean => documents.get(documentId)?.status === 'live'

/** Test seam: drop every document's record and channel. */
export function __resetCanvasDocuments(): void {
  for (const record of documents.values()) part(record)
  documents.clear()
  watchOrder = 0
}

// ── The hook ────────────────────────────────────────────────────────────────

/** What this card's own writes returned since the list it was shown over. */
interface Writes {
  base: MarkMap | null
  marks: MarkMap
}

const NO_WRITES: Writes = { base: null, marks: new Map() }

/**
 * The document's marks as the canvas has them: read once `seen` turns true,
 * and kept current while `onScreen` holds.
 */
export function useLiveMarks(documentId: string, { seen, onScreen }: { seen: boolean; onScreen: boolean }): LiveMarks {
  const subscribe = useCallback((render: () => void) => subscribeTo(documentId, render), [documentId])
  const list = useSyncExternalStore(
    subscribe,
    () => currentList(documentId),
    () => null
  )
  const connected = useSyncExternalStore(
    subscribe,
    () => isConnected(documentId),
    () => false
  )
  // What this card's writes returned, over the list they were made on. Kept
  // apart from the shared list so a write made before any read landed tells
  // about its own mark only: absent from a list nobody has read is „unknown",
  // not „gone". A newer list, from any card's read, supersedes them.
  const [writes, setWrites] = useState<Writes>(NO_WRITES)
  const since = writes.base === list ? writes.marks : NO_WRITES.marks

  useEffect(() => {
    if (seen) void readMarks(documentId, { fresh: false })
  }, [documentId, seen])

  useEffect(() => (onScreen ? watchDocument(documentId) : undefined), [documentId, onScreen])

  const refresh = useCallback(async () => {
    const next = await readMarks(documentId, { fresh: true })
    return next ? lookupIn(next) : null
  }, [documentId])

  const write = useCallback(
    (annotationId: string, mark: LiveMark | 'gone') => {
      const base = currentList(documentId)
      setWrites((previous) => ({
        base,
        marks: new Map(previous.base === base ? previous.marks : undefined).set(annotationId, mark),
      }))
    },
    [documentId]
  )

  const adopt = useCallback((annotation: AnnotationView) => write(annotation.id, liveOf(annotation)), [write])
  const forget = useCallback((annotationId: string) => write(annotationId, 'gone'), [write])

  const lookup = useCallback(
    (annotationId: string) => since.get(annotationId) ?? (list === null ? undefined : lookupIn(list)(annotationId)),
    [list, since]
  )

  return { lookup, refresh, adopt, forget, connected }
}

/**
 * The signed URL of the document's first-page picture, or null.
 *
 * The ingest renders it from page 1 of the PDF with the page's own proportions
 * (400px on the long edge), so a mark's normalized place on page 1 is the same
 * place on this picture. `/api/documents/{id}/thumbnail` answers `{ url: null }`
 * for a document without one; that, a refusal and a network failure all read
 * as null here, and the card draws the plain page instead.
 */
export function useFirstPageThumbnail(documentId: string, enabled: boolean): string | null {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    fetch(`/api/documents/${encodeURIComponent(documentId)}/thumbnail`)
      .then((response) => (response.ok ? response.json() : null))
      .then((body: unknown) => {
        const value = typeof body === 'object' && body !== null ? (body as { url?: unknown }).url : null
        if (!cancelled) setUrl(typeof value === 'string' ? value : null)
      })
      .catch(() => {
        if (!cancelled) setUrl(null)
      })
    return () => {
      cancelled = true
    }
  }, [documentId, enabled])

  return url
}
