'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AnnotationRequestError,
  createAnnotation,
  deleteAnnotation,
  deleteReply,
  editReply as editReplyRequest,
  getAnnotation,
  listAnnotations,
  replyToAnnotation,
  updateAnnotation,
} from '@/lib/annotations/client'
import {
  compareAnnotations,
  isForReader,
  isGhostMark,
  isLive,
  REPLY_TAKEN_UP_REASON,
  type AnnotationKind,
  type AnnotationShape,
  type AnnotationStatus,
  type AnnotationView,
  type MarkMention,
  type UpdateAnnotationRequest,
} from '@/lib/annotations/types'
import type { RevisionRef } from '@/lib/documents/revision-links'
import { inPool } from '@/lib/utils/in-pool'
import { useChatStore } from '@/features/chat'
import { inboxClient, type InboxClient } from '@/lib/inbox/client'
import { ARCHIVE_UNDO_MS, useUndoableArchive } from '@/features/collaboration/hooks/use-undoable-archive'
import { useLiveEvents } from '@/features/collaboration/hooks/use-live-events'
import { useCanvasAsk, type UseCanvasAskOptions } from './use-canvas-ask'
import { useDocumentRoom, type RoomTransport } from './use-document-room'

/** `ask`: drag a box and ask Piloti about it (P). */
export type ReviewTool = 'select' | 'point' | 'region' | 'ask'
export type ReviewFilter = 'open' | 'closed'

/** A burst of hints naming more marks than this reads the list once instead of each mark on its own. */
export const HINT_READ_ONE_BY_ONE = 8

/** How long a mark must stay open before opening it counts as reading its news: J/K past it does not. */
export const MARK_NEWS_SETTLE_MS = 400

/**
 * Opening a mark is reading its news: the reader's informational inbox items
 * anchored on it (a reply, the mark closed, Piloti's finished work) are read,
 * through the inbox's own client (`POST /api/inbox/read` with the anchor), so
 * the inbox stops calling news the reader has just seen. Requests stay open:
 * seeing a mark is not answering it. Called only for a mark whose dot says it
 * has news (the review's `unread`, the same rows): most marks a reader opens
 * have none, and a write for each was a request for nothing. Best effort; a
 * miss costs an unread row, whose dot the next read of `unread` brings back.
 */
export function readMarkNews(documentId: string, annotationId: string, client: InboxClient = inboxClient): void {
  void client.markMarkRead({ documentId, annotationId }).catch(() => undefined)
}

/** How long the review waits after the inbox changed before it reads which marks have news: one read for a burst. */
export const UNREAD_READ_DELAY_MS = 250

const NO_MARKS: ReadonlySet<string> = new Set()

/** How long a decision taken by a key (E, ⌫) waits before it is sent: the toast's „Rückgängig" window. */
export const DECISION_UNDO_MS = ARCHIVE_UNDO_MS

/** A status move held back for the undo window: where the key moved the mark, and where it stands on the server. */
interface HeldDecision {
  /** The document the key was pressed on: the decision is sent there even if the pane has moved on. */
  documentId: string
  status: 'open' | 'resolved' | 'dismissed'
  expectedStatus: AnnotationStatus
  /** Said when the move, once sent, is refused for any reason but a colleague's move (that is the conflict notice). */
  onFailed?: () => void
}

/**
 * A change asked while a decision on the same mark is held: the decision is
 * let go, and the change is rebased onto where the mark really stands. Moving
 * it back to that status is no change at all.
 */
function rebased(input: UpdateAnnotationRequest, held: HeldDecision): UpdateAnnotationRequest {
  const { status, expectedStatus, ...rest } = input
  if (status === undefined || status === held.expectedStatus) return rest
  return { ...rest, status, expectedStatus: expectedStatus === held.status ? held.expectedStatus : expectedStatus }
}

/**
 * How the document stands among its Fassungen under other names, as the
 * reader may see it (`RevisionLinks`, `lib/documents/revision-links.ts`): the document
 * that replaces it, and the ones it replaces.
 */
export interface ReviewRevision {
  replacedBy: RevisionRef | null
  replaces: readonly RevisionRef[]
}

/**
 * The open marks of a document this one replaces, listed read-only in its
 * review to be carried on; `load` is `error` when its list could not be read,
 * so the group says so and offers a retry rather than vanishing.
 */
export interface CarriedGroup {
  from: RevisionRef
  annotations: AnnotationView[]
  load: 'ready' | 'error'
}

/** How many replaced documents a review lists the open marks of: the direct predecessors, a few at most. */
export const CARRY_GROUPS_MAX = 3

/** How many carries „Alle übernehmen" has in flight at once: quick for thirty marks, gentle on the server. */
export const CARRY_AT_ONCE = 4

/** A place picked on a page and not yet saved: a point, or a region dragged out. */
export interface ReviewDraft {
  page: number
  shape: AnnotationShape
  x: number
  y: number
  w: number | null
  h: number | null
}

/**
 * Everything a review of one document holds, shared by the inline preview and
 * the focused review, so a mark selected in one is selected in the other and
 * a tab is in the room once: the Anmerkungen, the room, the tool in hand, the
 * draft, the selection, the filter, and the questions asked of Piloti on the
 * canvas (`use-canvas-ask.ts`). Piloti itself is in the room, as a peer.
 *
 * The list is the server's: every write replaces its row with what the API
 * answered, and a change somebody else made (a room hint) re-reads the list,
 * so a resolver's name, a number or a colleague's reply always comes from the
 * server rather than from a guess here.
 */
export function useDocumentReview(
  documentId: string,
  {
    enabled,
    transport,
    piloti: pilotiOptions,
    viewerUserId,
    revision,
    inbox = inboxClient,
  }: {
    enabled: boolean
    transport?: RoomTransport
    /** The inbox's typed client: which marks have unread news, and reading it. A spec passes its own. */
    inbox?: InboxClient
    /** Asking Piloti on the canvas; absent (or without a project) it is not offered. */
    piloti?: Omit<UseCanvasAskOptions, 'documentId' | 'enabled'>
    /** The signed-in person as the page knows them (the shelf's `currentUserId`), for when the room is not up. */
    viewerUserId?: string | null
    /** The documents it replaces and the one that replaces it, as the reader may see them. */
    revision?: ReviewRevision | null
  }
) {
  const room = useDocumentRoom(documentId, { enabled, transport })
  const canvas = useCanvasAsk({ ...pilotiOptions, documentId, enabled })
  /**
   * Who is reading: the room's own word once it has welcomed this tab, else
   * the page's (`viewerUserId`), else the session's user id the app keeps
   * (`useChatStore`'s `currentUserId`, set from `useAuth`). „Für Sie"
   * and „Mir zuweisen" must not go blank while the room is down, and a
   * mention of the reader stands out (`MarkBody`'s `viewerId`) before the room
   * answers. The one answer to „who reads" in the review.
   */
  const sessionUserId = useChatStore((state) => state.currentUserId)
  const me = room.self?.userId ?? viewerUserId ?? sessionUserId ?? null
  const [readLoad, setLoad] = useState<'loading' | 'ready' | 'error'>('loading')
  /**
   * The document the list in hand was read for. A pane reused for another
   * document renders once with the last one's list before its effect asks
   * again, and in that render `ready` would hand the last document's marks to
   * whatever counts them under the new one's id (the pane's tally for
   * Dateien's chip): until the new document's list answers, it is loading.
   */
  const [listedFor, setListedFor] = useState<string | null>(null)
  const load = readLoad === 'ready' && listedFor !== documentId ? 'loading' : readLoad
  /** The marks as the server last answered; `annotations` below shows them with the held decisions. */
  const [stored, setAnnotations] = useState<AnnotationView[]>([])
  const [canAnnotate, setCanAnnotate] = useState(false)
  /** The organization lets events wake Piloti: an @Piloti reply is the server's to answer, and a mark can be delegated. */
  const [pilotiWakes, setPilotiWakes] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [tool, setToolState] = useState<ReviewTool>('select')
  const [draft, setDraft] = useState<ReviewDraft | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Which mark this reader has open, for the room: Piloti resolves „diese Anmerkung“ by it.
  const { sendSelection } = room
  useEffect(() => sendSelection(selectedId), [selectedId, sendSelection])

  /**
   * The marks whose thread has news this reader has not read: the inbox's
   * informational items anchored on them, unread (`GET /api/inbox/unread-anchors`,
   * one bounded read for the document). A dot on the pin and the row. Read
   * again when the inbox changes (the `inbox.changed` nudge on the tab's live
   * channel, sent once the row is written; the room's hint goes out before
   * it, so reading on the hint would race the row), when the tab returns to
   * view, and on the slow poll while the channel is down (`useLiveEvents`).
   */
  const [unread, setUnread] = useState<ReadonlySet<string>>(NO_MARKS)
  const unreadRead = useRef({ documentId, ticket: 0 })
  unreadRead.current.documentId = documentId
  const fetchUnread = useCallback(async () => {
    const ticket = ++unreadRead.current.ticket
    const ids = await inbox.unreadMarks(documentId).catch(() => null)
    // Only the newest read, for the document still shown; a failed read keeps the dots there are.
    if (!ids || unreadRead.current.ticket !== ticket || unreadRead.current.documentId !== documentId) return
    setUnread(new Set(ids))
  }, [documentId, inbox])
  useEffect(() => {
    if (!enabled) return
    const asked = unreadRead.current
    setUnread(NO_MARKS)
    void fetchUnread()
    // Leaving the document (or closing the review) lets no read of its dots land.
    return () => {
      asked.ticket += 1
    }
  }, [enabled, fetchUnread])
  const unreadTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (unreadTimer.current) clearTimeout(unreadTimer.current)
    },
    []
  )
  /**
   * Whether the review is in front of the reader ({@link watchMarksSetNews}):
   * then a change in the inbox also reads the rows about new marks, which no
   * dot carries (`readMarksSetNews`). It cannot loop: a read that finds
   * nothing unread (`affected: 0`) sends no `inbox.changed`
   * (`markMarksSetReadFor`).
   */
  const marksSetWatched = useRef(false)
  const readMarksSetNews = useCallback(() => {
    void inbox.markMarksSetRead(documentId).catch(() => undefined)
  }, [documentId, inbox])
  const readInbox = useCallback(() => {
    void fetchUnread()
    if (marksSetWatched.current) readMarksSetNews()
  }, [fetchUnread, readMarksSetNews])
  useLiveEvents({
    enabled,
    onEvent: (event) => {
      if (event.kind !== 'inbox.changed') return
      if (unreadTimer.current) clearTimeout(unreadTimer.current)
      unreadTimer.current = setTimeout(readInbox, UNREAD_READ_DELAY_MS)
    },
    onRefresh: readInbox,
  })

  // A mark with news that stays open has been read, and so has its news in the
  // inbox: its dot goes at once, and news that arrives while it is open is read
  // too (the inbox's nudge reads `unread` again, which brings the dot back first).
  // A mark without a dot has nothing to read, and writes nothing.
  const selectedHasNews = selectedId !== null && unread.has(selectedId)
  useEffect(() => {
    if (!enabled || !selectedId || !selectedHasNews) return
    const timer = setTimeout(() => {
      setUnread((current) => {
        const next = new Set(current)
        next.delete(selectedId)
        return next
      })
      readMarkNews(documentId, selectedId, inbox)
    }, MARK_NEWS_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [enabled, documentId, selectedId, selectedHasNews, inbox])
  /**
   * The review of this document is open in front of the reader: its rows
   * about new marks are read („Anna hat 15 Anmerkungen gesetzt“), now and on
   * every change in the inbox until the returned function is called (the
   * review closes, or the document changes). They fold per document and anchor
   * on the newest mark only for their link, so no pin's dot carries them
   * (`listUnreadAnchors`), and seeing the review is seeing the marks they tell
   * about. Best effort; a miss leaves the row unread.
   */
  const watchMarksSetNews = useCallback(() => {
    marksSetWatched.current = true
    readMarksSetNews()
    return () => {
      marksSetWatched.current = false
    }
  }, [readMarksSetNews])
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [filter, setFilter] = useState<ReviewFilter>('open')
  /** „Für Sie“: only the marks that are this reader's ({@link isForReader}), the same ones Dateien counts „für Sie“. */
  const [mine, setMine] = useState(false)
  const [notice, setNotice] = useState<'conflict' | null>(null)
  /**
   * The open marks of the documents this one replaces, read through the same
   * list as their own reviews (`GET …/annotations` of each), while nothing
   * replaces this one: a mark is carried to the current Fassung, and that is
   * here only while this document is it.
   */
  const [carried, setCarried] = useState<CarriedGroup[]>([])
  // By value: a new array naming the same documents (every listing re-read) is not a change.
  const sourcesKey = JSON.stringify(
    revision?.replacedBy
      ? []
      : (revision?.replaces ?? []).slice(0, CARRY_GROUPS_MAX).map(({ id, filename }) => ({ id, filename }))
  )
  const sources = useMemo(() => JSON.parse(sourcesKey) as RevisionRef[], [sourcesKey])
  /** Which read of the replaced documents' marks may still land: the newest, for the document still shown. */
  const carriedRead = useRef(0)
  const fetchCarried = useCallback(async () => {
    const ticket = ++carriedRead.current
    const groups = await Promise.all(
      sources.map(async (from): Promise<CarriedGroup> => {
        // A document gone meanwhile has nothing to carry; any other failure is said, with a retry.
        const listed = await listAnnotations(from.id).catch((error: unknown) =>
          error instanceof AnnotationRequestError && error.status === 404 ? { annotations: [] } : null
        )
        if (!listed) return { from, annotations: [], load: 'error' }
        const open = listed.annotations.filter((annotation) => annotation.status === 'open')
        return { from, annotations: open, load: 'ready' }
      })
    )
    if (carriedRead.current === ticket) {
      setCarried(groups.filter((group) => group.load === 'error' || group.annotations.length > 0))
    }
  }, [sources])
  /** Read the replaced documents' marks again, after a group could not be read. */
  const retryCarried = useCallback(() => void fetchCarried(), [fetchCarried])
  /**
   * Piloti's answers to a check of a replaced document's marks land in THAT
   * document's threads, whose room this review is not in: once such a check
   * ends, its marks are read again, so each row shows what Piloti found.
   */
  const checking = useRef(new Set<string>())
  useEffect(() => {
    let ended = false
    for (const ask of canvas.asks) {
      if (!ask.checkFixed || ask.checkFixed.documentId === documentId) continue
      if (ask.status === 'thinking') checking.current.add(ask.id)
      else if (checking.current.delete(ask.id)) ended = true
    }
    if (ended) void fetchCarried()
  }, [canvas.asks, documentId, fetchCarried])
  useEffect(() => {
    if (!enabled) return
    setCarried([])
    void fetchCarried()
    // Leaving the document (or closing the review) lets no read of its predecessors land.
    return () => {
      carriedRead.current += 1
    }
  }, [enabled, documentId, fetchCarried])

  /**
   * Which reads may still land. A read of one mark lands only if it is the
   * latest asked for that mark and no list read was asked since; a drop counts
   * as newer than any read in flight. The document that asked must still be
   * the one shown: the pane is not keyed by document, so a read of A that
   * answers after B opened must not draw A's mark on B.
   */
  const reads = useRef({ documentId, list: 0, mark: new Map<string, number>() })
  reads.current.documentId = documentId
  const bumpMark = useCallback((annotationId: string) => {
    const next = (reads.current.mark.get(annotationId) ?? 0) + 1
    reads.current.mark.set(annotationId, next)
    return next
  }, [])

  const fetchList = useCallback(async () => {
    const ticket = ++reads.current.list
    const result = await listAnnotations(documentId)
    if (reads.current.documentId !== documentId || reads.current.list !== ticket) return result.annotations
    setAnnotations(result.annotations)
    setCanAnnotate(result.canAnnotate)
    setPilotiWakes(result.pilotiWakes)
    setListedFor(documentId)
    setLoad('ready')
    return result.annotations
  }, [documentId])

  useEffect(() => {
    if (!enabled) return
    setLoad('loading')
    setDraft(null)
    setSelectedId(null)
    fetchList().catch(() => setLoad('error'))
  }, [enabled, fetchList, attempt])

  const replace = useCallback((next: AnnotationView) => {
    setAnnotations((current) =>
      [...current.filter((annotation) => annotation.id !== next.id), next].sort(compareAnnotations)
    )
  }, [])
  const drop = useCallback(
    (annotationId: string) => {
      // Gone is newer than any read of it still on its way.
      bumpMark(annotationId)
      setAnnotations((current) => current.filter((annotation) => annotation.id !== annotationId))
      setSelectedId((current) => (current === annotationId ? null : current))
    },
    [bumpMark]
  )

  /**
   * Somebody else changed the Anmerkungen: read again what the hint names,
   * each mark on its own (`GET …/annotations/{id}`), not the whole list. A
   * mark that is not there any more for this reader leaves the list. Several
   * hints in a burst (a batch of replies) are one round of reads; a burst that
   * names more marks than {@link HINT_READ_ONE_BY_ONE} reads the list once.
   * Subscribed on the room's stable callbacks, never on `room`.
   */
  const { onAnnotationsChanged, peerId } = room
  useEffect(() => {
    if (!enabled) return
    let timer: ReturnType<typeof setTimeout> | null = null
    let named = new Set<string>()
    // Cleared with the subscription: an answer for the document left behind lands nowhere.
    let live = true
    const readNamed = () => {
      timer = null
      const ids = [...named]
      named = new Set()
      if (ids.length > HINT_READ_ONE_BY_ONE) {
        void fetchList().catch(() => {})
        return
      }
      for (const id of ids) {
        const ticket = bumpMark(id)
        const list = reads.current.list
        const current = () => live && reads.current.mark.get(id) === ticket && reads.current.list === list
        getAnnotation(documentId, id)
          .then((fresh) => {
            if (current()) replace(fresh)
          })
          .catch((error: unknown) => {
            if (current() && error instanceof AnnotationRequestError && error.status === 404) drop(id)
          })
      }
    }
    const unsubscribe = onAnnotationsChanged((event) => {
      if (event.actor.peerId && event.actor.peerId === peerId) return
      for (const id of event.annotationIds) named.add(id)
      if (timer) clearTimeout(timer)
      timer = setTimeout(readNamed, 120)
    })
    return () => {
      live = false
      unsubscribe()
      if (timer) clearTimeout(timer)
    }
  }, [enabled, onAnnotationsChanged, peerId, fetchList, documentId, replace, drop, bumpMark])

  // A hint is a nudge, and a dropped one must cost seconds, not a stale list: the
  // list is read again when the room comes back after a drop, and when the tab
  // comes back into view (a laptop woken from sleep heard nothing meanwhile).
  const { status: roomStatus } = room
  const wasLive = useRef(roomStatus === 'live')
  const everLive = useRef(roomStatus === 'live')
  useEffect(() => {
    const live = roomStatus === 'live'
    // Back after a drop, not the first connect: the first read is the mount's own.
    const back = live && !wasLive.current && everLive.current
    wasLive.current = live
    everLive.current ||= live
    if (enabled && back) void fetchList().catch(() => {})
  }, [enabled, roomStatus, fetchList])
  useEffect(() => {
    if (!enabled || typeof document === 'undefined') return
    const onVisible = () => {
      if (document.visibilityState === 'visible') void fetchList().catch(() => {})
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [enabled, fetchList])

  /**
   * A write a colleague beat: say so, and show what they did. A reply Piloti
   * took up is no colleague's move: the card that tried says that itself.
   */
  const guard = useCallback(
    async <T,>(act: () => Promise<T>): Promise<T> => {
      try {
        return await act()
      } catch (error) {
        if (error instanceof AnnotationRequestError && error.status === 409) {
          if (error.reason !== REPLY_TAKEN_UP_REASON) setNotice('conflict')
          void fetchList().catch(() => {})
        }
        throw error
      }
    },
    [fetchList]
  )

  const write = useMemo(() => ({ peerId: room.peerId }), [room.peerId])

  // One card beside the pages at a time: a mark's thread, the draft, or a
  // question to Piloti. Opening one puts the others away.
  const closeAskCard = canvas.open
  const select = useCallback(
    (annotationId: string | null) => {
      if (annotationId) closeAskCard(null)
      setSelectedId(annotationId)
    },
    [closeAskCard]
  )
  const placeDraft = useCallback(
    (next: ReviewDraft | null) => {
      if (next) closeAskCard(null)
      setDraft(next)
    },
    [closeAskCard]
  )
  const piloti = useMemo(
    () => ({
      ...canvas,
      compose: (...args: Parameters<typeof canvas.compose>) => {
        setDraft(null)
        setSelectedId(null)
        setToolState('select')
        return canvas.compose(...args)
      },
      ask: (input: Parameters<typeof canvas.ask>[0]) => {
        if (input.region && !input.replyInThread) {
          setDraft(null)
          setSelectedId(null)
        }
        return canvas.ask(input)
      },
      open: (id: string | null) => {
        if (id) {
          setDraft(null)
          setSelectedId(null)
        }
        canvas.open(id)
      },
    }),
    [canvas]
  )

  const setTool = useCallback((next: ReviewTool) => {
    setToolState(next)
    if (next !== 'select') setSelectedId(null)
  }, [])

  /** Set a mark at the draft, or at `place` (an answer of Piloti's taken over at its box). */
  const create = useCallback(
    async (
      content: {
        kind: AnnotationKind
        body: string
        mentions?: MarkMention[]
        assigneeUserId?: string | null
        dueOn?: string | null
      },
      place: ReviewDraft | null = draft
    ) => {
      if (!place) return null
      const { mentions, ...fields } = content
      const created = await guard(() =>
        createAnnotation(documentId, { ...place, ...fields, ...(mentions && mentions.length > 0 ? { mentions } : {}) }, write)
      )
      replace(created)
      setDraft(null)
      setToolState('select')
      setSelectedId(created.id)
      setFilter('open')
      return created
    },
    [documentId, draft, guard, replace, write]
  )

  /**
   * Decisions taken by a key (E, ⌫), held back for {@link DECISION_UNDO_MS}
   * before they are sent, through the inbox archive's own deferral
   * (`useUndoableArchive`): „Rückgängig" in the toast lets go of one without
   * touching the server, so an undone slip leaves no trace, no inbox row, no
   * score. Shown at once, and sent when the window closes, the page is hidden
   * or the review goes; with the status the mark had (`expectedStatus`), so a
   * colleague's move meanwhile is the conflict notice, never overwritten.
   */
  const [held, setHeld] = useState<ReadonlyMap<string, HeldDecision>>(new Map())
  const heldRef = useRef(held)
  const storedRef = useRef(stored)
  useEffect(() => {
    heldRef.current = held
    storedRef.current = stored
  })
  const letGo = useCallback((annotationId: string) => {
    setHeld((current) => {
      if (!current.has(annotationId)) return current
      const next = new Map(current)
      next.delete(annotationId)
      return next
    })
  }, [])
  /**
   * Held decisions whose write has started. They are still shown until the
   * answer comes, but no longer anything „Rückgängig", a change or a delete
   * can take back: those go to the server as they are, and a status the
   * write moved meanwhile is the usual conflict notice.
   */
  const sending = useRef(new Set<string>())
  const holdOn = useCallback(
    (annotationId: string) => (sending.current.has(annotationId) ? undefined : heldRef.current.get(annotationId)),
    []
  )
  const sendHeld = useCallback(
    async (annotationId: string) => {
      const decision = holdOn(annotationId)
      if (!decision) return
      sending.current.add(annotationId)
      try {
        const { status, expectedStatus } = decision
        const updated = await guard(() =>
          updateAnnotation(decision.documentId, annotationId, { status, expectedStatus }, write)
        )
        // A pane that moved to another document meanwhile shows that one: the answer lands nowhere.
        if (reads.current.documentId === decision.documentId) replace(updated)
      } catch (error) {
        if (!(error instanceof AnnotationRequestError && error.status === 409)) decision.onFailed?.()
      } finally {
        sending.current.delete(annotationId)
        letGo(annotationId)
      }
    },
    [holdOn, guard, replace, write, letGo]
  )
  const { request: holdBack, undo: releaseHold } = useUndoableArchive(sendHeld, DECISION_UNDO_MS)

  /** Take a mark to `status` by a key, undoable for a moment. False when a decision on it is already held. */
  const decide = useCallback(
    (annotation: Pick<AnnotationView, 'id' | 'status'>, status: HeldDecision['status'], onFailed?: () => void) => {
      if (heldRef.current.has(annotation.id)) return false
      const decision: HeldDecision = { documentId, status, expectedStatus: annotation.status, onFailed }
      heldRef.current = new Map(heldRef.current).set(annotation.id, decision)
      setHeld(heldRef.current)
      holdBack(annotation.id)
      return true
    },
    [documentId, holdBack]
  )
  /** „Rückgängig": the held decision is let go, and nothing was sent. */
  const undoDecision = useCallback(
    (annotationId: string) => {
      // Already on its way: nothing is left to take back.
      if (sending.current.has(annotationId)) return
      releaseHold(annotationId)
      const next = new Map(heldRef.current)
      next.delete(annotationId)
      heldRef.current = next
      letGo(annotationId)
    },
    [releaseHold, letGo]
  )

  const update = useCallback(
    async (annotationId: string, change: UpdateAnnotationRequest) => {
      const pending = holdOn(annotationId)
      if (pending) undoDecision(annotationId)
      const input = pending ? rebased(change, pending) : change
      const unchanged = storedRef.current.find((annotation) => annotation.id === annotationId)
      if (Object.keys(input).length === 0 && unchanged) return unchanged
      const updated = await guard(() => updateAnnotation(documentId, annotationId, input, write))
      replace(updated)
      return updated
    },
    [documentId, guard, replace, write, holdOn, undoDecision]
  )

  /** What the review shows: the server's marks, each held decision applied. */
  const annotations = useMemo(
    () =>
      held.size === 0
        ? stored
        : stored.map((annotation) => {
            const decision = held.get(annotation.id)
            return decision ? { ...annotation, status: decision.status } : annotation
          }),
    [stored, held]
  )

  /**
   * Answer in a thread. `addressesPiloti` is the composer's @Piloti mention,
   * `mentions` whom the person picked in its „@" picker; the answer says
   * whether the server wakes Piloti for it (`wake`), and the reply's id, which
   * a tab that asks Piloti itself turns into the turn id.
   */
  const reply = useCallback(
    async (
      annotationId: string,
      body: string,
      options: { addressesPiloti?: boolean; mentions?: MarkMention[] } = {}
    ) => {
      const result = await guard(() =>
        replyToAnnotation(
          documentId,
          annotationId,
          {
            body,
            ...(options.addressesPiloti ? { addressesPiloti: true } : {}),
            ...(options.mentions && options.mentions.length > 0 ? { mentions: options.mentions } : {}),
          },
          write
        )
      )
      replace(result.annotation)
      return result
    },
    [documentId, guard, replace, write]
  )

  /**
   * Reword one's own reply, with whom it mentions as the composer kept them.
   * Never wakes Piloti. A reply Piloti took up meanwhile is refused (409,
   * `REPLY_TAKEN_UP_REASON`) and the list is read again.
   */
  const editReply = useCallback(
    async (annotationId: string, replyId: string, body: string, mentions: MarkMention[]) => {
      const updated = await guard(() => editReplyRequest(documentId, annotationId, replyId, { body, mentions }, write))
      replace(updated)
      return updated
    },
    [documentId, guard, replace, write]
  )

  /** Delete one's own reply, refused as {@link editReply} is; the thread shows it gone at once. */
  const removeReply = useCallback(
    async (annotationId: string, replyId: string) => {
      await guard(() => deleteReply(documentId, annotationId, replyId, write))
      setAnnotations((current) =>
        current.map((annotation) =>
          annotation.id === annotationId
            ? { ...annotation, replies: annotation.replies.filter((reply) => reply.id !== replyId) }
            : annotation
        )
      )
    },
    [documentId, guard, write]
  )

  const remove = useCallback(
    async (annotationId: string) => {
      if (holdOn(annotationId)) undoDecision(annotationId)
      await guard(() => deleteAnnotation(documentId, annotationId, write))
      drop(annotationId)
    },
    [documentId, guard, write, drop, holdOn, undoDecision]
  )

  /**
   * „Auf aktuelle Fassung übernehmen": the mark goes on with the Fassung the
   * document shows now, in place (`carryToCurrent`), or, for a mark of a
   * document another one replaced, as a linked mark of that one. The status
   * the card showed goes with it, so a mark a colleague closed meanwhile is the
   * conflict notice. Both lists are read again: the mark moved between them.
   */
  const carry = useCallback(
    async (annotation: Pick<AnnotationView, 'id' | 'documentId' | 'status'>) => {
      const after = await guard(() =>
        updateAnnotation(annotation.documentId, annotation.id, { carryToCurrent: true, expectedStatus: annotation.status }, write)
      )
      if (after.documentId === documentId) replace(after)
      if (annotation.documentId !== documentId || after.documentId !== documentId) {
        await Promise.all([fetchList().catch(() => undefined), fetchCarried()])
      }
      return after
    },
    [documentId, guard, write, replace, fetchList, fetchCarried]
  )

  /**
   * „Erledigen" on a mark of a replaced document, listed here read-only: what
   * Piloti's check found fixed, closed by the person where it was set, with
   * the status the row showed. Its list is read again, whatever the answer:
   * the mark leaves it, or shows where a colleague took it.
   */
  const resolveCarried = useCallback(
    async (annotation: Pick<AnnotationView, 'id' | 'documentId' | 'status'>) => {
      try {
        return await guard(() =>
          updateAnnotation(annotation.documentId, annotation.id, { status: 'resolved', expectedStatus: annotation.status }, write)
        )
      } finally {
        // A colleague's move first is the conflict notice; either way the row shows where the mark stands.
        await fetchCarried()
      }
    },
    [guard, write, fetchCarried]
  )

  /**
   * „Alle übernehmen": the same PATCH as {@link carry} for each mark, at most
   * {@link CARRY_AT_ONCE} at a time, and the lists read ONCE after the last:
   * thirty marks are thirty PATCHes and, when any crossed documents or a
   * colleague beat one, one read of this list and one of each replaced
   * document's, not two to four reads per mark. A mark carried in place takes
   * the PATCH's answer and needs no read. How many went, and how many did not.
   */
  const carryAll = useCallback(
    async (marks: ReadonlyArray<Pick<AnnotationView, 'id' | 'documentId' | 'status'>>) => {
      const outcomes = await inPool(marks, CARRY_AT_ONCE, async (annotation) => {
        try {
          const after = await updateAnnotation(
            annotation.documentId,
            annotation.id,
            { carryToCurrent: true, expectedStatus: annotation.status },
            write
          )
          return { annotation, after, error: null }
        } catch (error) {
          return { annotation, after: null, error }
        }
      })
      let crossed = false
      let conflict = false
      for (const { annotation, after, error } of outcomes) {
        if (error instanceof AnnotationRequestError && error.status === 409) conflict = true
        if (!after) continue
        if (after.documentId === documentId) replace(after)
        if (annotation.documentId !== documentId || after.documentId !== documentId) crossed = true
      }
      if (conflict) setNotice('conflict')
      if (crossed || conflict) await Promise.all([fetchList().catch(() => undefined), fetchCarried()])
      const failed = outcomes.filter((outcome) => outcome.after === null).length
      return { carried: outcomes.length - failed, failed }
    },
    [documentId, write, replace, fetchList, fetchCarried]
  )

  const counts = useMemo(
    () => ({
      open: annotations.filter((annotation) => annotation.status === 'open').length,
      proposed: annotations.filter((annotation) => annotation.status === 'proposed').length,
      closed: annotations.filter((annotation) => !isLive(annotation)).length,
    }),
    [annotations]
  )

  const listed = useMemo(
    () =>
      annotations.filter(
        (annotation) =>
          (filter === 'open' ? isLive(annotation) : !isLive(annotation)) &&
          (!mine || isForReader(annotation, me))
      ),
    [annotations, filter, mine, me]
  )

  /**
   * Step to the next or previous mark, in the order the list shows them: what
   * the filter and „Mine" leave, Piloti's proposals first, as their group
   * leads the list. Only marks drawn on the sheet: this Fassung's, and the
   * ghosts of an earlier one ({@link isGhostMark}), which are listed under
   * Offen and drawn where they stood. A closed mark of an earlier Fassung is
   * listed and not drawn, so a key does not land on it. From nothing
   * selected, J starts at the first and K at the last.
   */
  const step = useCallback(
    (direction: 1 | -1, scope: 'live' | 'proposed' = 'live') => {
      const shown = scope === 'proposed' ? annotations.filter((annotation) => annotation.status === 'proposed') : listed
      const walk = [
        ...shown.filter((annotation) => annotation.status === 'proposed'),
        ...shown.filter((annotation) => annotation.status !== 'proposed'),
      ].filter((annotation) => annotation.onCurrentFassung || isGhostMark(annotation, documentId))
      if (walk.length === 0) return null
      const index = walk.findIndex((annotation) => annotation.id === selectedId)
      const next =
        index === -1
          ? walk[direction === 1 ? 0 : walk.length - 1]
          : walk[(index + direction + walk.length) % walk.length]
      if (!next) return null
      setSelectedId(next.id)
      return next
    },
    [annotations, listed, selectedId, documentId]
  )

  const retry = useCallback(() => setAttempt((value) => value + 1), [])
  const dismissNotice = useCallback(() => setNotice(null), [])

  // One object while nothing in it changed: a host that re-renders for its own
  // reasons hands the same review on, and what is memoised under it stays put.
  return useMemo(
    () => ({
      documentId,
      room,
      piloti,
      load,
      retry,
      annotations,
      listed,
      counts,
      canAnnotate,
      pilotiWakes,
      tool,
      setTool,
      draft,
      setDraft: placeDraft,
      selectedId,
      select,
      hoveredId,
      hover: setHoveredId,
      filter,
      setFilter,
      mine,
      setMine,
      notice,
      dismissNotice,
      create,
      update,
      decide,
      undoDecision,
      reply,
      editReply,
      removeReply,
      remove,
      step,
      me,
      revision: revision ?? null,
      carried,
      retryCarried,
      carry,
      carryAll,
      resolveCarried,
      unread,
      watchMarksSetNews,
    }),
    [
      documentId,
      room,
      piloti,
      load,
      retry,
      annotations,
      listed,
      counts,
      canAnnotate,
      pilotiWakes,
      tool,
      setTool,
      draft,
      placeDraft,
      selectedId,
      select,
      hoveredId,
      filter,
      mine,
      notice,
      dismissNotice,
      create,
      update,
      decide,
      undoDecision,
      me,
      reply,
      editReply,
      removeReply,
      remove,
      step,
      revision,
      carried,
      retryCarried,
      carry,
      carryAll,
      resolveCarried,
      unread,
      watchMarksSetNews,
    ]
  )
}

export type DocumentReview = ReturnType<typeof useDocumentReview>
