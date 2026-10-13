'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { canvasChatSender } from '@/features/chat/lib/canvas-bridge'
import type { TurnView } from '@/features/chat/lib/turn-fold'
import { useChatStore } from '@/features/chat/store'
import { runningTurnIn } from '@/features/chat/stores/messages-store'
import { useTranslations } from '@/i18n'
import type { StoredThinkingStep } from '@/lib/conversations/message-provenance'
import type { DocumentVersionState } from '@/lib/documents/lifecycle-types'
import {
  CanvasTurnError,
  createCanvasTurnClient,
  type CanvasQuestion,
  type CanvasTurnClient,
  type CanvasTurnClientOptions,
} from '../lib/canvas-turn-client'

/** A box on one page, as shares of the page, top-left origin (the Anmerkung frame). */
export interface CanvasAskRegion {
  page: number
  x: number
  y: number
  w: number
  h: number
}

/** The quick actions, which also say what an answer taken over as an Anmerkung is. */
export const CANVAS_ASK_INTENTS = ['what', 'dimensions', 'oib', 'question'] as const
export type CanvasAskIntent = (typeof CANVAS_ASK_INTENTS)[number]

export type CanvasAskStatus = 'composing' | 'thinking' | 'answered' | 'failed'

/**
 * Which driver carries a question. `chat`: the review is open over the chat,
 * and the question is a turn of the chat's conversation, through its driver
 * (`features/chat/lib/canvas-bridge.ts`). `canvas`: the review stands alone
 * (the Files area), and the question goes into the document's own
 * conversation on this tab's canvas client (`canvas-turn-client.ts`).
 */
export type CanvasAskBackend = 'chat' | 'canvas'

/** One question to Piloti on the canvas, from the box being drawn to the answer. */
export interface CanvasAsk {
  id: string
  /** The turn carrying it, once asked (the chat's message id on the chat backend). */
  turnId: string | null
  backend: CanvasAskBackend | null
  /** The box asked about; null for the whole document. */
  region: CanvasAskRegion | null
  /** The Anmerkung the box belongs to, when it is one. */
  annotationId: string | null
  /** Piloti answers in that Anmerkung's thread instead of in a card. */
  replyInThread: boolean
  question: string
  intent: CanvasAskIntent | null
  view: TurnView | null
  status: CanvasAskStatus
  /** Why it failed without a view to say so (`busy`). */
  error: string | null
  /** Piloti's replies in the thread when it was asked: one more is its answer (reply-in-thread only). */
  baseline: number
  effort: CanvasQuestion['effort'] | null
}

export interface CanvasAskInput {
  /** A composing entry this question comes from: it becomes the asked one. */
  id?: string
  text: string
  region: CanvasAskRegion | null
  annotationId?: string | null
  replyInThread?: boolean
  intent?: CanvasAskIntent | null
  baseline?: number
  effort?: CanvasQuestion['effort'] | null
}

export interface UseCanvasAskOptions {
  documentId: string
  enabled: boolean
  projectId?: string | null
  fileName?: string | null
  versionId?: string | null
  versionState?: DocumentVersionState | null
  shelf?: CanvasQuestion['shelf']
  refreshAuth?: () => Promise<void>
  /**
   * The review is open over the chat (the document is its peek): questions go
   * into the chat's conversation, through its driver, when it has one mounted.
   */
  chatHosted?: boolean
  /** The client factory; specs inject one built on a fake socket. */
  createClient?: (options: CanvasTurnClientOptions) => CanvasTurnClient
}

const storageKey = (documentId: string) => `piloti:canvas-conversation:${documentId}`

/** One conversation per document per tab: the same thread for every question asked on it. */
function conversationIdFor(documentId: string): string {
  try {
    const stored = window.sessionStorage.getItem(storageKey(documentId))
    if (stored) return stored
  } catch {
    // Storage refused (a private window, a sandbox): a fresh conversation per mount.
  }
  const id = uuidv4()
  try {
    window.sessionStorage.setItem(storageKey(documentId), id)
  } catch {
    // As above: the id still works for this mount.
  }
  return id
}

/** Where the chat opens a conversation: `?session=`, the parameter `useSessionUrl` reads. */
export const canvasConversationHref = (conversationId: string, projectId?: string | null): string =>
  projectId
    ? `/app/projects/${encodeURIComponent(projectId)}/chat?session=${encodeURIComponent(conversationId)}`
    : `/app/chat?session=${encodeURIComponent(conversationId)}`

/** A point asked about becomes a box this wide and tall around it (shares of the page). */
const POINT_BOX = 0.08

/** The box a place stands for: a region as it is, a point as a small box around it, kept on its page. */
export function askRegionOf(place: {
  page: number
  x: number
  y: number
  w?: number | null
  h?: number | null
}): CanvasAskRegion {
  if (place.w && place.h) return { page: place.page, x: place.x, y: place.y, w: place.w, h: place.h }
  const round = (value: number) => Math.round(value * 10_000) / 10_000
  const start = (value: number) => round(Math.min(1 - POINT_BOX, Math.max(0, value - POINT_BOX / 2)))
  return { page: place.page, x: start(place.x), y: start(place.y), w: POINT_BOX, h: POINT_BOX }
}

/** A turn's steps in the order they began, for the live line (`liveLine`). */
export const stepsOf = (view: TurnView | null): StoredThinkingStep[] =>
  view ? view.stepOrder.flatMap((id) => (view.steps[id] ? [view.steps[id]] : [])) : []

const statusOf = (view: TurnView): CanvasAskStatus =>
  view.phase === 'running' ? 'thinking' : view.phase === 'failed' ? 'failed' : 'answered'

const blankAsk = (id: string): CanvasAsk => ({
  id,
  turnId: null,
  backend: null,
  region: null,
  annotationId: null,
  replyInThread: false,
  question: '',
  intent: null,
  view: null,
  status: 'composing',
  error: null,
  baseline: 0,
  effort: null,
})

/**
 * Piloti on the review canvas: the questions asked about boxes on the pages
 * (or the whole document), each with its live turn, and which driver carries
 * it ({@link CanvasAskBackend}): the chat's, when the review is open over the
 * chat, so the canvas and the transcript are one conversation in two views;
 * else one document-subject conversation per document per tab.
 *
 * The asks are this tab's. What Piloti does on the document while it answers
 * (its pointer, what it highlights, its proposals, a reply in a thread) is its
 * own doing, through its tools, and arrives through the room like anybody
 * else's: nothing here plays it.
 */
export function useCanvasAsk(options: UseCanvasAskOptions) {
  const t = useTranslations('files')
  const { documentId, enabled, projectId } = options
  const [asks, setAsksState] = useState<CanvasAsk[]>([])
  const [openId, setOpenIdState] = useState<string | null>(null)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const client = useRef<CanvasTurnClient | null>(null)
  // Mirrors of the two states, for callbacks that must keep their identity
  // (the review's `select` closes the card through them on every click).
  const asksRef = useRef<CanvasAsk[]>([])
  const openRef = useRef<string | null>(null)
  // The latest options, read when a client is made and when a question goes:
  // a re-render must not make a new client mid-turn.
  const latest = useRef(options)
  const title = t('review.piloti.conversationTitle', { name: options.fileName ?? '' })
  const titleRef = useRef(title)
  useEffect(() => {
    latest.current = options
    titleRef.current = title
  })

  const setAsks = useCallback((update: (current: CanvasAsk[]) => CanvasAsk[]) => {
    asksRef.current = update(asksRef.current)
    setAsksState(asksRef.current)
  }, [])
  const patch = useCallback(
    (id: string, change: Partial<CanvasAsk>) =>
      setAsks((current) => current.map((ask) => (ask.id === id ? { ...ask, ...change } : ask))),
    [setAsks]
  )
  const setOpen = useCallback((id: string | null) => {
    openRef.current = id
    setOpenIdState(id)
  }, [])

  const remove = useCallback(
    (id: string) => {
      setAsks((current) => current.filter((ask) => ask.id !== id))
      if (openRef.current === id) setOpen(null)
    },
    [setAsks, setOpen]
  )

  const onTurn = useCallback(
    (view: TurnView) => {
      const entry = asksRef.current.find((ask) => ask.turnId === view.turnId)
      if (!entry || entry.view === view) return
      const status = statusOf(view)
      // A thread reply's turn that ended has said what it had to, in the thread.
      if (entry.replyInThread && status === 'answered') return remove(entry.id)
      patch(entry.id, { view, status })
    },
    [patch, remove]
  )

  // The chat backend: the turns are the chat store's, folded by the chat's driver.
  useEffect(
    () =>
      useChatStore.subscribe((state, previous) => {
        if (state.turns === previous.turns) return
        for (const ask of asksRef.current) {
          if (ask.backend !== 'chat' || !ask.turnId || ask.status !== 'thinking') continue
          const view = state.turns[ask.turnId]
          if (view) onTurn(view)
          // Gone while running: the chat ended it (a stop, an interruption it could not recover).
          else if (previous.turns[ask.turnId]) patch(ask.id, { status: 'failed', error: 'interrupted' })
        }
      }),
    [onTurn, patch]
  )

  const clientFor = useCallback((): CanvasTurnClient => {
    if (client.current) return client.current
    const current = latest.current
    const id = conversationIdFor(current.documentId)
    client.current = (current.createClient ?? createCanvasTurnClient)({
      conversationId: id,
      projectId: current.projectId,
      documentId: current.documentId,
      title: titleRef.current,
      refreshAuth: current.refreshAuth,
      onTurn,
      onConversation: () => setConversationId(id),
    })
    return client.current
  }, [onTurn])

  // A different document is a different conversation; leaving closes the socket.
  useEffect(
    () => () => {
      client.current?.close()
      client.current = null
      setAsks(() => [])
      setOpen(null)
      setConversationId(null)
    },
    [documentId, setAsks, setOpen]
  )

  const available = enabled && Boolean(projectId)

  /** Show one ask's card (null: none). A card closed while still waiting for its question goes. */
  const open = useCallback(
    (id: string | null) => {
      const previous = openRef.current
      if (previous && previous !== id) {
        setAsks((current) => current.filter((ask) => !(ask.id === previous && ask.status === 'composing')))
      }
      setOpen(id)
    },
    [setAsks, setOpen]
  )

  /** Open a card on a box, waiting for the question. */
  const compose = useCallback(
    (region: CanvasAskRegion, extra?: { annotationId?: string | null }): string => {
      const id = uuidv4()
      setAsks((current) => [
        ...current.filter((ask) => ask.status !== 'composing'),
        { ...blankAsk(id), region, annotationId: extra?.annotationId ?? null },
      ])
      setOpen(id)
      return id
    },
    [setAsks, setOpen]
  )

  /** Through the chat's driver: the turn id is the chat's message id, known once it is sent. */
  const askInChat = useCallback(
    (entry: CanvasAsk, question: CanvasQuestion): boolean => {
      const send = latest.current.chatHosted ? canvasChatSender() : null
      if (!send) return false
      // The chat's conversation runs one turn at a time, whoever asked it.
      const chat = useChatStore.getState()
      if (runningTurnIn(chat.turns, chat.currentConversation?.id)) {
        patch(entry.id, { backend: 'chat', status: 'failed', error: 'busy' })
        return true
      }
      const opened = send({
        text: question.text,
        effort: question.effort,
        focus: {
          documentId: latest.current.documentId,
          fileName: question.fileName ?? null,
          versionId: question.versionId ?? null,
          versionState: question.versionState ?? null,
          shelf: question.shelf ?? 'project',
          region: question.region ?? null,
          replyInThread: Boolean(question.replyInThread),
        },
      })
      if (!opened) {
        patch(entry.id, { backend: 'chat', status: 'failed', error: 'not_sent' })
        return true
      }
      patch(entry.id, { backend: 'chat', turnId: opened.turnId })
      setConversationId(opened.conversationId)
      const view = useChatStore.getState().turns[opened.turnId]
      if (view) onTurn(view)
      return true
    },
    [onTurn, patch]
  )

  const ask = useCallback(
    (input: CanvasAskInput): string => {
      const id = uuidv4()
      const entry: CanvasAsk = {
        ...blankAsk(id),
        region: input.region,
        annotationId: input.annotationId ?? null,
        replyInThread: Boolean(input.replyInThread),
        question: input.text,
        intent: input.intent ?? null,
        status: 'thinking',
        baseline: input.baseline ?? 0,
        effort: input.effort ?? null,
      }
      setAsks((current) => [...current.filter((existing) => existing.id !== input.id), entry])
      // The card follows its question; a thread reply and a whole-document review have none.
      if (!entry.replyInThread && entry.region) setOpen(id)
      else if (openRef.current === input.id) setOpen(null)
      const { fileName, versionId, versionState, shelf } = latest.current
      const region = input.region
      const question: CanvasQuestion = {
        text: input.text,
        region: region ? { ...region, ...(input.annotationId ? { annotation_id: input.annotationId } : {}) } : null,
        fileName,
        versionId,
        versionState,
        shelf,
        replyInThread: entry.replyInThread,
        effort: input.effort ?? undefined,
      }
      if (askInChat(entry, question)) return id
      patch(id, { backend: 'canvas', turnId: id })
      clientFor()
        .ask(question, id)
        .catch((error: unknown) =>
          patch(id, { status: 'failed', error: error instanceof CanvasTurnError ? error.code : 'unknown' })
        )
      return id
    },
    [askInChat, clientFor, patch, setAsks, setOpen]
  )

  /** Close an ask: a running one is stopped first. */
  const dismiss = useCallback(
    (id: string) => {
      const entry = asksRef.current.find((existing) => existing.id === id)
      if (entry?.status === 'thinking' && entry.turnId) {
        if (entry.backend === 'canvas') client.current?.cancel(entry.turnId)
        else if (useChatStore.getState().turns[entry.turnId]?.phase === 'running') useChatStore.getState().stopStreaming()
      }
      remove(id)
    },
    [remove]
  )

  /** Ask the same question again, as a new turn. */
  const retry = useCallback(
    (id: string) => {
      const entry = asksRef.current.find((existing) => existing.id === id)
      if (!entry || entry.status === 'composing') return
      ask({
        id,
        text: entry.question,
        region: entry.region,
        annotationId: entry.annotationId,
        replyInThread: entry.replyInThread,
        intent: entry.intent,
        baseline: entry.baseline,
        effort: entry.effort,
      })
    },
    [ask]
  )

  const conversationHref = conversationId ? canvasConversationHref(conversationId, projectId) : null

  return useMemo(
    () => ({
      available,
      asks,
      openId,
      open,
      busy: asks.some((entry) => entry.status === 'thinking'),
      compose,
      ask,
      dismiss,
      retry,
      conversationHref,
    }),
    [available, asks, openId, open, compose, ask, dismiss, retry, conversationHref]
  )
}

export type CanvasAskState = ReturnType<typeof useCanvasAsk>
