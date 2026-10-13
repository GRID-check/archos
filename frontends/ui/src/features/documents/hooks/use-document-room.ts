'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { postToRoom, roomPath } from '@/lib/annotations/client'
import {
  CURSOR_INTERVAL_MS,
  PRESENCE_REFRESH_MS,
  roomFrameSchema,
  VIEWPORT_INTERVAL_MS,
  type RoomCursor,
  type RoomEvent,
  type RoomFrame,
  type RoomPeer,
  type RoomPost,
  type RoomViewport,
} from '@/lib/annotations/room-types'

/** How a room reaches the server: the live SSE stream and its POST, or a stand-in (the `/dev` preview). */
export interface RoomTransport {
  /** Open the stream. Returns the close. */
  connect(handlers: { onFrame: (frame: RoomFrame) => void; onOpen: () => void; onDrop: () => void }): () => void
  post(post: RoomPost): void
}

/** The production transport: `GET /api/documents/:id/live` (SSE) down, `POST` up. */
export function sseRoomTransport(documentId: string): RoomTransport {
  return {
    connect({ onFrame, onOpen, onDrop }) {
      if (typeof EventSource === 'undefined') {
        onDrop()
        return () => {}
      }
      const source = new EventSource(roomPath(documentId))
      source.onopen = onOpen
      source.onerror = onDrop
      source.onmessage = (message) => {
        try {
          const parsed = roomFrameSchema.safeParse(JSON.parse(message.data))
          if (!parsed.success) return
          if (parsed.data.kind === 'revoked') source.close()
          onFrame(parsed.data)
        } catch {
          // A frame that is not JSON is not ours to guess at.
        }
      }
      return () => source.close()
    },
    post: (post) => void postToRoom(documentId, post),
  }
}

/** One other viewer, as this tab knows them now. */
export interface RoomPeerState {
  peer: RoomPeer
  /** Where their pointer is on the pages; null when it is off them. */
  cursor: RoomCursor | null
  tool: 'select' | 'point' | 'region'
  viewport: RoomViewport | null
  /** When their presence claim runs out, ms since the epoch. */
  expiresAt: number
}

export type RoomStatus = 'connecting' | 'live' | 'offline'

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

/**
 * This tab in a document's room: who else is looking, where their pointers
 * are, where they are scrolled to, and that the Anmerkungen changed
 * (`lib/annotations/room-types.ts`).
 *
 * Presence is a claim with a TTL, refreshed every ten seconds and withdrawn
 * when the tab goes. A newcomer learns who is already here because everyone
 * answers a stranger's first claim with their own, so the server keeps no
 * list. Pointers go up at most every 80ms and viewports every 200ms; a
 * receiver glides between them (`LiveCursor`), so twelve updates a second
 * read as continuous motion.
 *
 * State lives in a ref and reaches React once per animation frame at most, so a
 * room of pointers does not re-render the review twelve times a second per
 * person.
 */
export function useDocumentRoom(
  documentId: string,
  { enabled, transport }: { enabled: boolean; transport?: RoomTransport }
) {
  const peerId = useMemo(newPeerId, [])
  const link = useMemo(() => transport ?? sseRoomTransport(documentId), [transport, documentId])
  const [status, setStatus] = useState<RoomStatus>('connecting')
  const [self, setSelf] = useState<Omit<RoomPeer, 'peerId'> | null>(null)
  const [peers, setPeers] = useState<RoomPeerState[]>([])
  const peersRef = useRef(new Map<string, RoomPeerState>())
  const frame = useRef<number | null>(null)
  const listeners = useRef(new Set<(event: Extract<RoomEvent, { kind: 'annotations.changed' }>) => void>())
  const lastTool = useRef<'select' | 'point' | 'region'>('select')

  const commit = useCallback(() => {
    if (frame.current !== null) return
    const run = () => {
      frame.current = null
      setPeers([...peersRef.current.values()])
    }
    frame.current = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(run) : (setTimeout(run, 16) as unknown as number)
  }, [])

  const cursorSender = useMemo(
    () =>
      throttle<{ cursor: RoomCursor | null; tool: 'select' | 'point' | 'region' }>(CURSOR_INTERVAL_MS, (value) =>
        link.post({ peerId, cursor: value.cursor, tool: value.tool })
      ),
    [link, peerId]
  )
  const viewportSender = useMemo(
    () => throttle<RoomViewport>(VIEWPORT_INTERVAL_MS, (viewport) => link.post({ peerId, viewport })),
    [link, peerId]
  )

  useEffect(() => {
    if (!enabled) return
    const peersNow = peersRef.current
    let announceTimer: ReturnType<typeof setTimeout> | null = null
    const announce = () => link.post({ peerId, presence: 'here' })
    /** Answer a stranger with our own claim, once, a moment later: everyone answering at once is a burst. */
    const answerStranger = () => {
      announceTimer ??= setTimeout(
        () => {
          announceTimer = null
          announce()
        },
        150 + Math.random() * 350
      )
    }

    const onEvent = (event: RoomEvent) => {
      if (event.kind === 'annotations.changed') {
        for (const listener of listeners.current) listener(event)
        return
      }
      const { peer } = event
      if (peer.peerId === peerId) return
      const known = peersNow.get(peer.peerId)
      if (event.kind === 'presence') {
        if (event.state === 'gone') {
          peersNow.delete(peer.peerId)
        } else {
          if (!known) answerStranger()
          peersNow.set(peer.peerId, {
            peer,
            cursor: known?.cursor ?? null,
            tool: known?.tool ?? 'select',
            viewport: known?.viewport ?? null,
            expiresAt: Date.now() + event.ttlMs,
          })
        }
      } else if (event.kind === 'cursor') {
        // A pointer is also a sign of life: someone moving it is here.
        if (!known) answerStranger()
        peersNow.set(peer.peerId, {
          peer,
          cursor: event.cursor,
          tool: event.tool ?? known?.tool ?? 'select',
          viewport: known?.viewport ?? null,
          expiresAt: Math.max(known?.expiresAt ?? 0, Date.now() + PRESENCE_REFRESH_MS * 2),
        })
      } else if (event.kind === 'viewport') {
        peersNow.set(peer.peerId, {
          peer,
          cursor: known?.cursor ?? null,
          tool: known?.tool ?? 'select',
          viewport: event.viewport,
          expiresAt: Math.max(known?.expiresAt ?? 0, Date.now() + PRESENCE_REFRESH_MS * 2),
        })
      }
      commit()
    }

    setStatus('connecting')
    const close = link.connect({
      onOpen: () => {
        setStatus('live')
        announce()
      },
      onDrop: () => setStatus('offline'),
      onFrame: (frame) => {
        if (frame.kind === 'welcome') {
          setSelf(frame.self)
          setStatus('live')
        } else if (frame.kind === 'revoked') {
          setStatus('offline')
          peersNow.clear()
          commit()
        } else onEvent(frame.event)
      },
    })
    const heartbeat = setInterval(announce, PRESENCE_REFRESH_MS)
    const prune = setInterval(() => {
      const now = Date.now()
      let changed = false
      for (const [id, state] of peersNow) {
        if (state.expiresAt < now) {
          peersNow.delete(id)
          changed = true
        }
      }
      if (changed) commit()
    }, 2_000)
    const leave = () => link.post({ peerId, presence: 'gone' })
    window.addEventListener('pagehide', leave)
    return () => {
      window.removeEventListener('pagehide', leave)
      clearInterval(heartbeat)
      clearInterval(prune)
      if (announceTimer) clearTimeout(announceTimer)
      cursorSender.cancel()
      viewportSender.cancel()
      leave()
      close()
      peersNow.clear()
    }
  }, [enabled, link, peerId, commit, cursorSender, viewportSender])

  useEffect(
    () => () => {
      if (frame.current !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame.current)
    },
    []
  )

  /** Say where this tab's pointer is on the pages (null: off them), and what it is doing. */
  const sendCursor = useCallback(
    (cursor: RoomCursor | null, tool: 'select' | 'point' | 'region' = lastTool.current) => {
      lastTool.current = tool
      if (enabled) cursorSender.push({ cursor, tool })
    },
    [enabled, cursorSender]
  )

  const sendViewport = useCallback(
    (viewport: RoomViewport) => {
      if (enabled) viewportSender.push(viewport)
    },
    [enabled, viewportSender]
  )

  /** Hear about changes to the Anmerkungen; returns the unsubscribe. */
  const onAnnotationsChanged = useCallback(
    (listener: (event: Extract<RoomEvent, { kind: 'annotations.changed' }>) => void) => {
      listeners.current.add(listener)
      return () => {
        listeners.current.delete(listener)
      }
    },
    []
  )

  return { peerId, status: enabled ? status : 'offline', self, peers, sendCursor, sendViewport, onAnnotationsChanged }
}

export type DocumentRoom = ReturnType<typeof useDocumentRoom>
