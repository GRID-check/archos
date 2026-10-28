import { useRef, useEffect, useLayoutEffect, useCallback, useState, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useChatStore } from '@/features/chat/store'

import type { ChatMessage } from '@/features/chat/types'
import type { StoredThinkingStep } from '@/lib/conversations/message-provenance'
import { useAnswerRevealStore } from '@/features/chat/stores/answer-reveal-store'
import type { UserMessageAuthor } from '@/features/chat/components/UserMessage'
import type { Finding } from '@/lib/conversations/message-findings'
import { useCommissionRun } from '@/features/runs/hooks/use-commission-run'
import { continuationBrief, findingBrief } from '@/features/runs/lib/carry-forward'
import { AGENT_MENTION_ID } from '@/lib/mentions/types'
import { useMessageAnchor } from '@/features/collaboration/hooks/use-message-anchor'
import { useSharedThread } from '@/features/collaboration/hooks/use-shared-thread'
import { useSpectatedTurn } from '@/features/collaboration/hooks/use-spectated-turn'
import { useAwaitingState } from '@/features/collaboration/hooks/use-sharing'
import { motionEntrance, motionInstant, motionQuickExit } from '@/components/motion'
import type { Variants } from 'motion/react'
import { glideScrollTo, type GlideHandle } from '../../lib/glide-scroll'
import { useAuth } from '@/adapters/auth'
import { useReducedMotion } from '@/hooks/use-reduced-motion'
import { useTranslations } from '@/i18n'
import { useShowReasoningSkills } from '@/lib/user-preferences/use-show-reasoning-skills'
import {
  isDisplayableMessage,
  isTransientConnectionError,
  selectThreadPhase,
} from '../../lib/thread-phase'
import {
  readThreadPosition,
  rememberThreadPosition,
  type ThreadPosition,
} from '../../lib/thread-positions'
import {
  answerGist,
  turnEnding,
  RECONNECTED_NOTE_MS,
  ROW_GAP_PX,
  FOLD_HOLD_MS,
  UNSEEN_SLACK_PX,
  READER_SCROLL_MS,
  GESTURE_SETTLE_MS,
  RETRY_ANCHOR_WINDOW_MS,
  layoutTop,
  visibleBottom,
} from './chat-area-helpers'

export interface ChatAreaProps {
  /** Whether the user is authenticated */
  isAuthenticated?: boolean
  /** Callback when sign in is clicked */
  onSignIn?: () => void
  /**
   * Whether the collaboration surfaces are reachable for this org (ADR-0032…0035,
   * dark-launched behind the per-org `collaboration` flag).
   *
   * **Defaults to false, and false means "exactly today"** (spec NF-8): no
   * conversation read, no live subscription, no authorship, no banners — the
   * local-first chat path is untouched. Even with the flag on, a conversation the
   * server reports as private keeps that path; only a shared one switches to the
   * server-authoritative one (ADR-0033).
   */
  canCollaborate?: boolean
}

export function useChatAreaController({
  isAuthenticated = false,
  onSignIn,
  canCollaborate = false,
}: ChatAreaProps) {
  const { currentConversation, isStreaming, currentUserMessageId, isRecoveryPending } =
    useChatStore(
      useShallow((s) => ({
        currentConversation: s.currentConversation,
        isStreaming: s.isStreaming,
        currentUserMessageId: s.currentUserMessageId,
        isRecoveryPending: s.isRecoveryPending,
      }))
    )
  // What the thread is: still being read from storage, loading its messages,
  // the empty canvas, or a thread. The same selector decides whether
  // `MainLayout` lifts the composer, so the two never disagree.
  const threadPhase = useChatStore(selectThreadPhase)
  const pendingMessagesFor = useChatStore((s) => s.pendingMessagesFor)
  const setPendingMessagesFor = useChatStore((s) => s.setPendingMessagesFor)
  // The stream ends before the answer's text is all on screen: the answer
  // finishes what its pace held back, then settles. The Herleitung's header
  // stays live until then (`answer-reveal-store.ts`); it folded long before,
  // when the answer's first words arrived, so the settle changes no height.
  const revealingId = useAnswerRevealStore((s) => s.revealingId)
  const turnLive = isStreaming || revealingId !== null
  // How each of this client's turns ENDED. Read for the Herleitung's status:
  // a turn that has no answer message is not therefore a lost one (a run was
  // handed off, a question refused, the reader pressed Stop).
  const turns = useChatStore((s) => s.turns)
  // Turns that FAILED here. The store drops a failed turn's view in the step
  // after the fold marks it (`failTurn`), before its error card is added, and
  // with neither on screen the turn read as lost: „Unterbrochen" and a
  // recovery spinner flashed in front of a failure. Noted as the fold marks it.
  const failedTurnIdsRef = useRef(new Set<string>())
  useEffect(() => {
    if (typeof useChatStore.subscribe !== 'function') return
    return useChatStore.subscribe((state) => {
      for (const view of Object.values(state.turns ?? {})) {
        if (view.phase === 'failed') failedTurnIdsRef.current.add(view.turnId)
      }
    })
  }, [])

  // The project this thread is scoped to. Read here for one reason: the
  // „Als Aktenvermerk schreiben" chip is only offered where a draft has
  // somewhere to be filed (ledger 23).
  const activeProjectId = useChatStore((s) => s.projectId)
  const setComposerPrefill = useChatStore((s) => s.setComposerPrefill)
  const stableStepsRef = useRef(new Map<string, StoredThinkingStep[]>())
  const dismissErrorCard = useChatStore((s) => s.dismissErrorCard)
  const retryLastUserMessage = useChatStore((s) => s.retryLastUserMessage)
  const t = useTranslations('research')
  const tCollaboration = useTranslations('collaboration')
  const { user } = useAuth()
  const currentUserId = user?.id ?? null
  // Fetched ONCE for the whole transcript and passed down to each answer.
  // Reading it inside AgentResponse would fire one GET per message and re-render
  // every answer when it settled; the list renders once, so the preference does.
  const { showReasoningSkills } = useShowReasoningSkills()

  // ── The ADR-0033 seam ───────────────────────────────────────────────────────
  // One hook owns "is this thread shared, load it from the server, keep it
  // reconciled". With `canCollaborate` false — the default — it does nothing at
  // all, so the local-first path below is byte-identical to today's.
  const {
    shared,
    myRole,
    loading: sharedLoading,
    accessLost,
    turnInFlight,
    clearTurnInFlight,
    noteTurnActivity,
    typists,
    unreadAfterMessageId,
    lastArrival,
    participants,
    engagement,
    engagementSuggestion,
    setEngagement,
    authorOf,
  } = useSharedThread({
    conversationId: currentConversation?.id ?? null,
    enabled: canCollaborate,
    currentUserId,
  })

  // ── Watching a colleague's turn (ADR-0039) ──────────────────────────────────
  // Only for a turn that is NOT this reader's: the asker already has the frames
  // on their own agent socket, and a second copy would render the answer twice.
  // Everything else — a private thread, a gated org, no turn running — resolves
  // to `enabled: false`, and the hook then opens no connection at all.
  const isForeignTurn = Boolean(
    shared && turnInFlight && turnInFlight.actorUserId !== currentUserId && !isStreaming
  )
  const { turn: spectatedTurn, live: spectatingLive } = useSpectatedTurn({
    conversationId: currentConversation?.id ?? null,
    enabled: isForeignTurn,
    // Every frame restarts the staleness clock. This used to be derived from
    // `answer.length` + `steps.length`, which stand still for the whole of a
    // single long tool call (the reducer merges repeats into the step it
    // already has) — so a six-minute `ris_search` looked like silence and the
    // banner was torn down mid-turn.
    onFrame: noteTurnActivity,
  })

  /*
    Two wires from the spectated stream back to the banner.

    FAILED clears it. A turn that dies without persisting an assistant message —
    cancelled, or a server-side persist that failed — never publishes `ended`,
    which is published as a side effect of that write, so the observer would
    otherwise sit behind a locked composer until the staleness clock ran out.

    DONE deliberately does NOT clear it. `done` is the terminal frame, which
    strictly precedes persistence — and the whole live view is gated on
    `turnInFlight`, so clearing on `done` unmounted the finished answer the
    observer was reading and left them blank until the persisted message landed a
    round trip later. On the very case this was written for (no persist at all)
    it threw away a completed answer and replaced it with nothing. The persisted
    message's own `ended` event is what clears it; until then the completed
    spectated answer stays on screen, which is the truthful thing to show.

    Any frame at all is evidence the turn is alive, which restarts the clock —
    that is what lets the timeout be short without cutting off a long turn. That
    wire is `onFrame` on the hook itself, below.
  */
  useEffect(() => {
    if (isForeignTurn && spectatedTurn?.phase === 'failed') clearTurnInFlight()
  }, [isForeignTurn, spectatedTurn?.phase, clearTurnInFlight])

  // One label, two renderings (the static banner and the live stream), so the
  // observer's headline cannot change wording just because frames started
  // arriving.
  const turnInFlightLabel = useMemo(() => {
    if (!turnInFlight) return ''
    if (turnInFlight.actorUserId && turnInFlight.actorUserId === currentUserId) {
      return tCollaboration('thread.turnInFlightYou')
    }
    return tCollaboration('thread.turnInFlight', {
      name: authorOf(turnInFlight.actorUserId)?.name ?? tCollaboration('inbox.unknownActor'),
    })
  }, [turnInFlight, currentUserId, authorOf, tCollaboration])

  // Stick-to-bottom scroll controller refs/state (replaces the old count-based
  // scrollIntoView). `scrollContainerRef` is the scroll viewport; `contentRef`
  // is the growing message list we observe for height changes. It excludes
  // the anchor spacer, which the observer itself resizes.
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  // Whether growth below is FOLLOWED (auto-scroll). Kept in a ref (not just
  // state) so the ResizeObserver callback reads a fresh value without being
  // re-created on every scroll. Only the reader engages it: a scroll they drove
  // to the end of the content, or the jump-to-latest button. A scroll the page
  // caused (a clamp as a collapsing panel shrinks the list, a glide) never
  // does: reading a clamp as "the reader is at the bottom" chased a reader at
  // the settle, seven programmatic scrolls in a row (motion audit, 2026-10).
  const followRef = useRef(true)
  // When the reader last touched the scroll (wheel, touch, pointer, key), and
  // the scroll height at the last scroll event: together they tell a scroll the
  // reader drove from one the layout caused.
  const lastReaderInputRef = useRef(0)
  const lastScrollHeightRef = useRef(0)
  // A finger is on the thread. Following waits until it lifts and the fling's
  // scroll stops, so a programmatic scroll never fights a hand mid-gesture.
  const touchActiveRef = useRef(false)
  // The reader asked to follow the anchored turn by pressing jump-to-latest.
  const jumpedRef = useRef(false)
  // The pending follow scroll, so the anchor can cancel one queued before the
  // send (a stale rAF could otherwise cancel the send's glide).
  const followRafRef = useRef(0)
  // The running anchor glide, stopped by the reader's input or a thread swap.
  const glideRef = useRef<GlideHandle | null>(null)
  // When the reader last retried an errored answer: the re-sent question is
  // not glided to when it is already within a viewport of where it would land.
  const retryAtRef = useRef(-Infinity)
  // Rows whose removal must not animate (the error card a retry replaces).
  const instantExitIdsRef = useRef(new Set<string>())
  const [showScrollButton, setShowScrollButton] = useState(false)

  // ── New-question top-anchor bookkeeping (ChatGPT/Claude pattern) ────────────
  // When a NEW user message is sent we pin THAT message near the top of the
  // viewport and let the answer stream fill downward, instead of the stick-to-
  // bottom controller chasing the growing answer (which scrolled the question
  // off-screen). The anchored question's turn carries `data-chat-anchor` so the
  // effect can find it in the committed DOM (motion.div doesn't attach a
  // forwarded ref synchronously); `anchorSpacerRef` is an invisible min-height
  // block below the list that guarantees there is always enough scroll room to
  // bring the question to the top (imperatively sized, and refitted as the
  // answer grows, so it needs no extra render); `prevAnchorIdRef`
  // debounces the anchor so it fires once per newly-sent question (and never
  // on mount / session restore, where the opening effect below owns
  // scrolling).
  const anchorSpacerRef = useRef<HTMLDivElement>(null)
  // Whether a sent question is anchored to the top right now: from its send
  // until the thread is swapped. While it is, the spacer is kept FITTED
  // (`fitAnchorSpacer`) rather than a fixed viewport.
  const anchoredRef = useRef(false)
  // Latest reduced-motion preference for the anchor scroll (a JS scrollIntoView
  // overrides the CSS scroll-behavior gate, so honour it explicitly). Ref-held so
  // the anchor effect's deps stay tied to the turn id, not this preference.
  const prefersReducedMotion = useReducedMotion()
  const reducedMotionRef = useRef(prefersReducedMotion)
  reducedMotionRef.current = prefersReducedMotion

  // A thread row's motion. Built once; the refs are read when a row enters or
  // leaves, so a row's removal sees the retry that asked for it to be instant.
  //
  // Leaving, the row gives up its height with its opacity (and the list's gap
  // above it, as a negative margin), clipped while it goes. With
  // `presenceAffectsLayout={false}` nothing else closes the gap, and an
  // opacity-only exit left a hole for 180 ms and then snapped every row below.
  const rowEnter = prefersReducedMotion ? motionInstant : motionEntrance
  const rowLeave = prefersReducedMotion ? motionInstant : motionQuickExit
  const rowVariants = useMemo<Variants>(
    () => ({
      hidden: { opacity: 0, y: 4 },
      shown: () => ({
        opacity: 1,
        y: 0,
        transition: reducedMotionRef.current ? motionInstant : motionEntrance,
      }),
      leave: (id: string) => ({
        opacity: 0,
        height: 0,
        marginTop: -ROW_GAP_PX,
        overflow: 'hidden',
        transition:
          instantExitIdsRef.current.has(id) || reducedMotionRef.current
            ? motionInstant
            : motionQuickExit,
      }),
    }),
    []
  )

  const messages = currentConversation?.messages
  // Commissioning from inside the thread: an open finding to clear, or a
  // report to carry forward. Null when there is no project or conversation.
  const commissionRun = useCommissionRun(activeProjectId ?? null, currentConversation?.id ?? null)
  const commissionFromFinding = useCallback(
    async (finding: Finding): Promise<boolean> => {
      if (!commissionRun) return false
      const brief = findingBrief(finding)
      return commissionRun.commission(brief.question, brief.context)
    },
    [commissionRun]
  )
  const continueRun = useCallback(
    async (message: ChatMessage): Promise<void> => {
      if (!commissionRun) return
      const brief = continuationBrief(message)
      await commissionRun.commission(brief.question, brief.context, brief.documents)
    },
    [commissionRun]
  )

  // Filter to only show displayable message types in the chat area
  // Assistant text messages (full reports) are displayed in the Details Panel instead.
  // A dropped connection is not a message either: it is said by the quiet
  // status line above the composer (`connectionNote`), not by a card that
  // collapses out of the thread when the socket comes back.
  const displayableMessages = useMemo(
    () => (messages ?? []).filter(isDisplayableMessage),
    [messages]
  )
  const connectionLost = useMemo(
    () => (messages ?? []).some(isTransientConnectionError),
    [messages]
  )

  const isEmpty = displayableMessages.length === 0
  // The skeleton, not the greeting, while the thread's messages are on their
  // way: from storage, from the server, or (for a first-time recipient of a
  // shared thread) from the shared read, whose history lands a moment after
  // the conversation is materialised empty.
  const sharedHistoryPending = shared && sharedLoading && isEmpty
  const showSkeleton =
    threadPhase === 'hydrating' || threadPhase === 'loading' || sharedHistoryPending
  const listReady = !showSkeleton
  // The shared read is a history fetch like the store's own, so it names the
  // thread pending in the store too: `MainLayout` reads the phase from there,
  // and decided "empty" on its own it lifted the composer over this skeleton.
  // Only a claim this view made is released here; a store fetch that named the
  // thread first clears its own (a release here would greet the reader while
  // it is still in flight). Before paint, so the two are never seen apart.
  const sharedPendingClaimRef = useRef<string | null>(null)
  useLayoutEffect(() => {
    const id = currentConversation?.id ?? null
    if (sharedHistoryPending && id) {
      if (sharedPendingClaimRef.current === id || pendingMessagesFor === id) return
      sharedPendingClaimRef.current = id
      setPendingMessagesFor?.(id)
      return
    }
    const claimed = sharedPendingClaimRef.current
    if (!claimed) return
    sharedPendingClaimRef.current = null
    if (pendingMessagesFor === claimed) setPendingMessagesFor?.(null)
  }, [sharedHistoryPending, currentConversation?.id, pendingMessagesFor, setPendingMessagesFor])
  // Whether the list now on screen replaces the skeleton (the frame before was
  // the skeleton): only then does it fade in.
  const skeletonShownRef = useRef(showSkeleton)
  const listArrivesFromSkeleton = skeletonShownRef.current
  useEffect(() => {
    skeletonShownRef.current = showSkeleton
  }, [showSkeleton])

  // The connection, said quietly in the status dock: lost while this page
  // reconnects, then „Wieder verbunden" for a moment once it has. Derived from
  // the thread's transient connection errors, which the recovery hook dismisses
  // when the socket is back; a thread switch is not a reconnect.
  const [connectionNote, setConnectionNote] = useState<'lost' | 'restored' | null>(
    connectionLost ? 'lost' : null
  )
  const [connectionSeen, setConnectionSeen] = useState({
    conversationId: currentConversation?.id,
    lost: connectionLost,
  })
  if (connectionSeen.conversationId !== currentConversation?.id) {
    setConnectionSeen({ conversationId: currentConversation?.id, lost: connectionLost })
    setConnectionNote(connectionLost ? 'lost' : null)
  } else if (connectionSeen.lost !== connectionLost) {
    setConnectionSeen({ conversationId: currentConversation?.id, lost: connectionLost })
    setConnectionNote(connectionLost ? 'lost' : 'restored')
  }
  useEffect(() => {
    if (connectionNote !== 'restored') return
    const timer = setTimeout(() => setConnectionNote(null), RECONNECTED_NOTE_MS)
    return () => clearTimeout(timer)
  }, [connectionNote])

  /**
   * The other half of an inbox deep link: `#message-<id>` scrolls to the message
   * the notification was actually about, once it has rendered. Without it the
   * recipient arrives at the bottom of the thread with no idea which message
   * concerns them — and the inbox row is already marked read.
   */
  const anchoredMessageIds = useMemo(
    () => displayableMessages.map((m) => m.id),
    [displayableMessages]
  )
  // The thread the link landed in. Its opening position is the link's: the
  // bottom jump and the follow below must not move the reader off the message
  // the link was about (they used to, a frame after it landed).
  const deepLinkedConversationRef = useRef<string | undefined>(undefined)
  const { highlightedId: highlightedMessageId, isTargetPending } = useMessageAnchor(
    anchoredMessageIds,
    {
      conversationId: currentConversation?.id ?? null,
      // All of the thread is here: a target missing now is missing from it, and
      // stops holding the thread's placement and follow. Not while a shared
      // thread's history is still arriving, which is where an inbox link's
      // message usually is.
      ready: listReady && !sharedLoading,
      onLand: () => {
        deepLinkedConversationRef.current = currentConversation?.id
        glideRef.current?.stop()
        followRef.current = false
        jumpedRef.current = false
      },
    }
  )

  // ── Multi-author bookkeeping (shared threads only) ──────────────────────────
  // Authorship per message, plus whether it CONTINUES a run by the same author.
  // Grouping is computed here rather than in the bubble because it is a property
  // of the sequence, not of a message: a run is broken by anyone else speaking and
  // by the agent answering in between.
  const authorship = useMemo(() => {
    const byMessageId = new Map<string, { author: UserMessageAuthor; grouped: boolean }>()
    if (!shared) return byMessageId

    let previousAuthorKey: string | null = null
    for (const message of displayableMessages) {
      const isUserMessage = message.messageType === 'user' || message.role === 'user'
      if (!isUserMessage) {
        // The agent answering ends the run: the next human message starts fresh.
        previousAuthorKey = null
        continue
      }

      // A user message with no author can only be one this browser just wrote —
      // the optimistic echo, before the server's copy (which carries the author)
      // has come back. Attributing it to the reader avoids a flash of "Someone".
      const userId = message.authorUserId ?? currentUserId ?? null
      const person = authorOf(userId)
      const key = userId ?? `unattributed:${message.id}`

      byMessageId.set(message.id, {
        author: {
          userId,
          name: person?.name ?? message.authorName ?? null,
          avatarUrl: person?.profilePictureUrl ?? message.authorAvatarUrl ?? null,
          isYou: Boolean(userId && currentUserId && userId === currentUserId),
        },
        grouped: key === previousAuthorKey,
      })
      previousAuthorKey = key
    }
    return byMessageId
  }, [shared, displayableMessages, authorOf, currentUserId])

  // Where the reader left off (spec CC-19). Anchored on the server-held read mark,
  // then advanced past the reader's OWN messages — a separator whose first item is
  // your own message would be telling you that you have not read yourself.
  //
  // The anchor is resolved against the FULL message list, not the displayable
  // subset: the read receipt marks the newest mapped message, which may be a full
  // report (rendered in the details panel, not here), and an anchor that cannot be
  // found would silently drop the divider on the next open.
  const unreadDividerBeforeId = useMemo(() => {
    if (!shared || !unreadAfterMessageId) return null
    const all = messages ?? []
    const anchorIndex = all.findIndex((m) => m.id === unreadAfterMessageId)
    if (anchorIndex < 0) return null
    const displayableIds = new Set(displayableMessages.map((m) => m.id))
    for (const message of all.slice(anchorIndex + 1)) {
      if (!displayableIds.has(message.id)) continue
      const mine = authorship.get(message.id)?.author.isYou === true
      if (!mine) return message.id
    }
    return null
  }, [shared, unreadAfterMessageId, messages, displayableMessages, authorship])

  // ── The hand-back offer (ADR-0034 addendum, the last transition) ────────────
  // The state machine is: asking Piloti → tag a human → waiting → they answer →
  // **hand back?** → asking Piloti. Every transition but the last one had a visible
  // affordance; this is the last one. The wait itself is read from the server, never
  // computed here, so this offer and the banner cannot disagree.
  const { awaiting, release } = useAwaitingState(
    currentConversation?.id ?? null,
    canCollaborate && shared
  )
  const threadAwaitsHuman = (awaiting?.pending.length ?? 0) > 0

  // Dismissal is per resolution point, so a later answer offers again.
  const [handbackDismissedFor, setHandbackDismissedFor] = useState<string | null>(null)

  /**
   * Whether the thread is sitting at a resolution point — and who answered.
   *
   * Derived from the thread itself rather than from a live transition, on purpose:
   * the asker usually arrives *after* the colleague answered (hours later, from
   * another device), and an offer that only existed in the browser that watched the
   * message land would be missing in exactly that case.
   */
  const handback = useMemo((): {
    anchorId: string
    people: Array<{ userId: string; name: string }>
  } | null => {
    if (!shared || threadAwaitsHuman) return null

    // Who this thread has actually ASKED. A message whose server-computed addressee
    // set names people and NOT the agent is the hand-off (MN-1/MN-2); the structured
    // mentions are the fallback for a message stored before that ruling was kept.
    const asked = new Set<string>()
    for (const message of displayableMessages) {
      if (message.addressees) {
        if (!message.addressees.agent) {
          for (const userId of message.addressees.users) asked.add(userId)
        }
        continue
      }
      const mentions = message.mentions ?? []
      if (mentions.length === 0) continue
      if (mentions.some((mention) => mention.targetId === AGENT_MENTION_ID)) continue
      for (const mention of mentions) asked.add(mention.targetId)
    }
    if (asked.size === 0) return null

    // The trailing run of messages by people who were asked. Anything else ends it:
    // the agent has already answered (nothing to hand back), or the reader had the
    // last word (they are mid-thought, and it is not their own answer to offer on).
    const answerers: Array<{ userId: string; name: string }> = []
    let anchorId: string | null = null
    for (let index = displayableMessages.length - 1; index >= 0; index -= 1) {
      const message = displayableMessages[index]
      const isUserMessage = message.messageType === 'user' || message.role === 'user'
      if (!isUserMessage) break
      const userId = message.authorUserId ?? null
      if (!userId || userId === currentUserId || !asked.has(userId)) break
      anchorId ??= message.id
      if (answerers.some((person) => person.userId === userId)) continue
      answerers.unshift({
        userId,
        name: authorOf(userId)?.name ?? message.authorName ?? tCollaboration('inbox.unknownActor'),
      })
    }
    if (!anchorId || answerers.length === 0) return null
    return { anchorId, people: answerers }
  }, [shared, threadAwaitsHuman, displayableMessages, currentUserId, authorOf, tCollaboration])

  const showHandback = handback !== null && handbackDismissedFor !== handback.anchorId

  /**
   * Accepting PRE-FILLS the composer and focuses it — it never sends. The message
   * has to stay honestly authored: a button that fired a turn would either put words
   * under the user's name that they did not write, or produce an answer to a question
   * nobody can see, in a thread several people read as a shared record.
   *
   * The `@Piloti` token rides along as a STRUCTURED mention: without it the
   * prefill would send as plain text and route by the engagement mode instead of
   * to the agent (MN-3 — a mention is never re-derived from text).
   */
  const handleHandback = useCallback(() => {
    if (!handback) return
    const agentName = tCollaboration('mentions.picker.agentName')
    setComposerPrefill(`@${agentName} ${tCollaboration('mentions.handback.prefill')}`, [
      { targetId: AGENT_MENTION_ID, display: agentName },
    ])
    setHandbackDismissedFor(handback.anchorId)
  }, [handback, setComposerPrefill, tCollaboration])

  /**
   * "Stattdessen Piloti fragen" from inside the wait (spec MN-9.3).
   *
   * Pre-fills rather than sending, for the same reason the hand-back offer does:
   * the message stays honestly authored, and a turn with no user-authored question
   * produces "Based on the discussion above…". A STRUCTURED `@Piloti` mention is
   * what releases the wait server-side — bare `@Piloti` text would not, so the
   * mention travels with the prefill.
   */
  const handleAskAgent = useCallback(() => {
    const agentName = tCollaboration('mentions.picker.agentName')
    setComposerPrefill(`@${agentName} `, [{ targetId: AGENT_MENTION_ID, display: agentName }])
  }, [setComposerPrefill, tCollaboration])

  /**
   * "Rückfrage an Matthias" — the reader was asked something they cannot answer
   * without more information.
   *
   * Pre-fills `@{asker} ` WITH its structured mention, which routes the message
   * as a mention: the asker's own request closes as `asked_back` rather than as
   * an answer they never gave, and the thread keeps waiting — on them. A
   * text-only prefill would send the same question as plain text, settle the
   * request, tell the asker "they answered", and hand the thread back to Piloti
   * in the middle of a human conversation.
   */
  const handleAskBack = useCallback(
    (asker: { userId: string; name: string }) => {
      setComposerPrefill(`@${asker.name} `, [{ targetId: asker.userId, display: asker.name }])
    },
    [setComposerPrefill]
  )

  // Entrance-animation bookkeeping: messages already present when a conversation
  // renders (hydration / session switch) must NOT animate in — only messages
  // appended afterwards get the fade-rise entrance. Seeded synchronously so the
  // very first render already knows which ids are "old".
  //
  // Seeded again when the thread's messages ARRIVE (the skeleton gives way to
  // the list): seeded while it loaded, the set was empty, and every message of
  // a thread opened from the server played its entrance as it landed.
  const hydratedIdsRef = useRef<Set<string> | null>(null)
  // The follow-ups rails already there at the seed: a restored rail is simply
  // there, only one a live stage delivers fades in.
  const hydratedRailIdsRef = useRef(new Set<string>())
  const hydratedConversationIdRef = useRef<string | undefined>(currentConversation?.id)
  const hydratedListReadyRef = useRef(listReady)
  // Questions whose Herleitung this view showed live. It stays for them after
  // the settle even when the turn took no step, because the header was the
  // working cue from the send: removing it at the settle would pull the answer
  // up by its height in the frame the turn ends.
  const liveShownIdsRef = useRef(new Set<string>())
  if (
    hydratedIdsRef.current === null ||
    hydratedConversationIdRef.current !== currentConversation?.id ||
    hydratedListReadyRef.current !== listReady
  ) {
    const sameThread = hydratedConversationIdRef.current === currentConversation?.id
    hydratedConversationIdRef.current = currentConversation?.id
    hydratedListReadyRef.current = listReady
    hydratedIdsRef.current = new Set(displayableMessages.map((m) => m.id))
    hydratedRailIdsRef.current = new Set(
      displayableMessages.filter((m) => m.stages?.followUps).map((m) => m.id)
    )
    if (!sameThread) liveShownIdsRef.current = new Set()
  }
  const hydratedIds = hydratedIdsRef.current
  // A colleague's answer, watched live, is swapped for its persisted row when
  // that lands. The swap is like for like (the same answer surface), so the
  // row is placed, not entered: an entrance there replayed the answer the
  // observer had just watched being written.
  if (spectatedTurn?.messageId) hydratedIds.add(spectatedTurn.messageId)

  // Each question's turn (the messages up to the next question), and the
  // React key of each row, in one pass over the thread. Derived per row inside
  // the render loop, it sliced the rest of the thread once per question on
  // every delta flush.
  //
  // A turn's answer row is keyed by its QUESTION, not by its own id: a turn
  // handed to a run swaps its answer for the run's message, a different id in
  // the same place, and keyed by id the row left and a new one entered in the
  // slot the reader was looking at (lifecycle L15).
  const threadLayout = useMemo(() => {
    const turnOf = new Map<string, ChatMessage[]>()
    const rowKeyOf = new Map<string, string>()
    let question: ChatMessage | null = null
    let answerKeyed = false
    for (const message of displayableMessages) {
      if (message.messageType === 'user' || message.role === 'user') {
        question = message
        answerKeyed = false
        turnOf.set(message.id, [])
        continue
      }
      if (!question) continue
      turnOf.get(question.id)?.push(message)
      if (message.messageType === 'agent_response' && !answerKeyed) {
        answerKeyed = true
        rowKeyOf.set(message.id, `answer:${question.id}`)
      }
    }
    return { turnOf, rowKeyOf, lastQuestionId: question?.id ?? null }
  }, [displayableMessages])

  /**
   * The Herleitung of a user message: the steps the turn's fold wrote onto it,
   * live or restored alike. A deep-research step is the run block's
   * (`RunBlockMessage`), not the turn's.
   */
  const getStepsForUserMessage = (messageId: string): StoredThinkingStep[] => {
    const steps = (
      currentConversation?.messages.find((m) => m.id === messageId)?.thinkingSteps ?? []
    ).filter((step) => step.scope !== 'deep')
    // The filter builds a new array per call. Hand back the previous one while
    // its steps are the same objects, so the memoised ChatThinking of a turn that
    // did not change skips the render every delta flush of the live answer.
    const previous = stableStepsRef.current.get(messageId)
    if (
      previous &&
      previous.length === steps.length &&
      previous.every((step, i) => step === steps[i])
    ) {
      return previous
    }
    stableStepsRef.current.set(messageId, steps)
    return steps
  }

  // ── The live turn ──────────────────────────────────────────────────────────
  // This client's current question and the answer it has drawn so far. Whether
  // that answer has begun decides the Herleitung's fold and the end of the
  // steps phase; its id decides which answer row waits for the fold.
  const currentTurnHasSteps = currentUserMessageId
    ? getStepsForUserMessage(currentUserMessageId).length > 0
    : false
  const currentTurn = useMemo(() => {
    if (!currentUserMessageId) return null
    const index = displayableMessages.findIndex((m) => m.id === currentUserMessageId)
    if (index < 0) return null
    const rest = displayableMessages.slice(index + 1)
    const nextQuestion = rest.findIndex((m) => m.messageType === 'user' || m.role === 'user')
    const messages = nextQuestion >= 0 ? rest.slice(0, nextQuestion) : rest
    const answer = messages.find((m) => m.messageType === 'agent_response')
    return {
      messages,
      answerId: answer?.id ?? null,
      // Begun the moment the answer has ANYTHING to draw: its masthead or a
      // card can arrive before its first word, and an answer that opened with
      // either used to render under the open panel and jump up by its height.
      answerBegun: Boolean(
        answer && (answer.content.trim() || answer.answerMeta || answer.cards?.some(Boolean))
      ),
      stopped: answer?.stopped === true,
      failed: answer?.failed === true,
      gist: answer ? answerGist(answer) : '',
    }
  }, [currentUserMessageId, displayableMessages])

  // Whether this turn's answer has EVER begun. A retraction empties the answer
  // and `answerBegun` goes false again, which reopened the Herleitung over the
  // answer's held frame (155 → 555 px, the answer pushed down by 248 px) only
  // to fold it again in one frame at the next round's first word. The answer
  // holds its own frame through a retraction now, so the panel stays folded.
  const [answerBegunFor, setAnswerBegunFor] = useState<string | null>(null)
  if (currentTurn?.answerBegun && currentUserMessageId && answerBegunFor !== currentUserMessageId) {
    setAnswerBegunFor(currentUserMessageId)
  }
  const answerHasBegun =
    Boolean(currentTurn?.answerBegun) ||
    (currentUserMessageId !== null && answerBegunFor === currentUserMessageId)

  // The answer's first words fold the Herleitung above it, and the answer is
  // WITHHELD until that fold is done: mounted at once, its first line painted
  // below an open panel (below the fold, on most screens) and was then yanked
  // up by the panel's height, 400 px, as the reader started reading it. Held,
  // it mounts where it stays, directly under the folded bar. Only an answer
  // this view watched begin, under a Herleitung that had steps to fold, and
  // only one not on screen yet: an answer row a snapshot mounted before its
  // first word (its sources, no text) is already where it stays, and holding
  // it pulled it out of the thread and back in.
  //
  // The hold runs from the fold's start to its end, whatever the turn does
  // meanwhile: keyed on the live turn, a Stop or an end inside the fold
  // released it at once, and the answer mounted under the fading panel.
  const renderedIdsRef = useRef(new Set<string>())
  const foldStarts =
    turnLive &&
    currentTurnHasSteps &&
    currentTurn?.answerBegun &&
    currentTurn.answerId &&
    !hydratedIds.has(currentTurn.answerId) &&
    !renderedIdsRef.current.has(currentTurn.answerId)
      ? currentTurn.answerId
      : null
  const [foldHoldId, setFoldHoldId] = useState<string | null>(null)
  const [releasedHoldId, setReleasedHoldId] = useState<string | null>(null)
  if (foldStarts && foldStarts !== foldHoldId && foldStarts !== releasedHoldId)
    setFoldHoldId(foldStarts)
  useEffect(() => {
    if (!foldHoldId || releasedHoldId === foldHoldId) return
    const timer = setTimeout(
      () => setReleasedHoldId(foldHoldId),
      prefersReducedMotion ? 0 : FOLD_HOLD_MS
    )
    return () => clearTimeout(timer)
  }, [foldHoldId, releasedHoldId, prefersReducedMotion])
  const holdId = foldStarts ?? foldHoldId
  const heldAnswerId = holdId && releasedHoldId !== holdId ? holdId : null

  // The settle, said once (WCAG 4.1.3). One stable region for the thread's
  // lifetime, written only when this client's turn ends: a live region that
  // mounts with its text is not announced, and one written per frame would be
  // read per frame. The header's own status says what Piloti is doing; this
  // says the answer is there to be read, and what it comes to. A turn that
  // ended without an answer of its own says how, in the Herleitung's own word
  // for it: „Antwort fertig" over a failed answer, or over the provisional
  // message of a turn handed to a run, said the opposite of what happened.
  const [turnNote, setTurnNote] = useState({ live: turnLive, text: '' })
  if (turnNote.live !== turnLive) {
    let text = ''
    if (!turnLive && currentTurn && currentUserMessageId) {
      const view = turns?.[currentUserMessageId]
      const failed =
        currentTurn.failed ||
        view?.phase === 'failed' ||
        failedTurnIdsRef.current.has(currentUserMessageId) ||
        currentTurn.messages.some(
          (m) =>
            m.messageType === 'error' && m.errorData?.errorCode !== 'agent.response_interrupted'
        )
      const ending = turnEnding(view, currentTurn.messages, failed)
      if (currentTurn.stopped) text = t('chatArea.status.stopped')
      else if (ending === 'failed') text = t('chatArea.status.failed')
      else if (ending === 'handed_off') text = t('chatArea.status.handedOff')
      else if (ending === 'refused') text = t('chatArea.status.refused')
      else if (!currentTurn.answerId) text = ''
      else if (currentTurn.gist)
        text = t('chatArea.status.answerReadyWith', { gist: currentTurn.gist })
      else text = t('chatArea.status.answerReady')
    }
    setTurnNote({ live: turnLive, text })
  }
  // The steps phase of an anchored turn: the reader is watching the Herleitung
  // grow under their question, and that growth is not "newer content below".
  const stepsPhaseRef = useRef(false)
  stepsPhaseRef.current = turnLive && !answerHasBegun
  const turnLiveRef = useRef(turnLive)
  turnLiveRef.current = turnLive

  // ── Scroll controller ──────────────────────────────────────────────────────
  // Follows growth below ONLY while the reader has asked for it (`followRef`),
  // so a reader who scrolled up to read is never yanked back down, and surfaces
  // the jump button when there is unseen content below.
  //
  // "Below" is measured to the END OF THE CONTENT (the anchor spacer's top),
  // not to the scroll height: while a question is anchored the spacer's room
  // sits under the content, and measured against the scroll height every live
  // turn read as "not at the bottom" and showed the button.

  /** How far the content's end lies below what the reader can see over the composer. */
  const unseenBelow = useCallback((): number => {
    const container = scrollContainerRef.current
    const spacer = anchorSpacerRef.current
    if (!container || !spacer) return 0
    return spacer.getBoundingClientRect().top - visibleBottom(container)
  }, [])

  /** Bring the content's end to just above the composer. */
  const scrollToContentEnd = useCallback(
    (behavior: ScrollBehavior) => {
      const el = scrollContainerRef.current
      if (!el) return
      const delta = unseenBelow()
      if (Math.abs(delta) < 1) return
      el.scrollTo({ top: el.scrollTop + delta, behavior })
    },
    [unseenBelow]
  )

  /** Show the jump button exactly while there is unseen content below. */
  const updateScrollButton = useCallback(() => {
    const show = !stepsPhaseRef.current && !followRef.current && unseenBelow() > UNSEEN_SLACK_PX
    setShowScrollButton((prev) => (prev === show ? prev : show))
  }, [unseenBelow])

  // The reader's hands on the scroll. A scroll event within READER_SCROLL_MS of
  // one of these (or of the previous reader-driven scroll, which carries a
  // touch fling's momentum) is the reader's; anything else the page caused.
  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return
    const touched = () => {
      lastReaderInputRef.current = performance.now()
    }
    const touchStart = () => {
      touchActiveRef.current = true
      touched()
    }
    const touchEnd = () => {
      touchActiveRef.current = false
      touched()
    }
    const events = ['wheel', 'touchmove', 'pointerdown'] as const
    for (const type of events) container.addEventListener(type, touched, { passive: true })
    container.addEventListener('touchstart', touchStart, { passive: true })
    container.addEventListener('touchend', touchEnd, { passive: true })
    container.addEventListener('touchcancel', touchEnd, { passive: true })
    window.addEventListener('keydown', touched)
    return () => {
      for (const type of events) container.removeEventListener(type, touched)
      container.removeEventListener('touchstart', touchStart)
      container.removeEventListener('touchend', touchEnd)
      container.removeEventListener('touchcancel', touchEnd)
      window.removeEventListener('keydown', touched)
    }
  }, [isEmpty, listReady])

  // The thread on screen, as the scroll bookkeeping last saw it (set by the
  // opening effect, below the anchor's).
  const shownConversationIdRef = useRef<string | undefined>(undefined)

  /**
   * Where the reader is, as the first row they can see: kept per thread, so a
   * thread switched away from and back to reopens where it was left.
   */
  const capturePosition = useCallback((): ThreadPosition | null => {
    const container = scrollContainerRef.current
    const content = contentRef.current
    if (!container || !content) return null
    if (unseenBelow() <= UNSEEN_SLACK_PX) return { atEnd: true }
    const top = container.getBoundingClientRect().top
    for (const row of content.querySelectorAll<HTMLElement>(':scope > [id^="message-"]')) {
      const rect = row.getBoundingClientRect()
      if (rect.bottom <= top) continue
      return { atEnd: false, messageId: row.id.slice('message-'.length), offsetTop: rect.top - top }
    }
    return null
  }, [unseenBelow])
  const positionRafRef = useRef(0)

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el) return
    const now = performance.now()
    const heightChanged = el.scrollHeight !== lastScrollHeightRef.current
    lastScrollHeightRef.current = el.scrollHeight
    const readerDriven = !heightChanged && now - lastReaderInputRef.current < READER_SCROLL_MS
    if (readerDriven) {
      lastReaderInputRef.current = now
      // 80px of slack: a small nudge short of the end still counts as there.
      // While a question is anchored, reaching the end does not start
      // following on its own: the anchored layout is what the reader chose
      // by sending, and only the jump button trades it for following.
      const atEnd = unseenBelow() <= 80
      followRef.current = atEnd && (!anchoredRef.current || jumpedRef.current)
    }
    updateScrollButton()
    // Once a frame at most, and for the thread this scroll happened in: a
    // capture that ran after a swap would file the new thread's rows under it.
    const conversationId = shownConversationIdRef.current
    if (!conversationId || positionRafRef.current) return
    positionRafRef.current = requestAnimationFrame(() => {
      positionRafRef.current = 0
      if (shownConversationIdRef.current !== conversationId) return
      const position = capturePosition()
      if (position) rememberThreadPosition(conversationId, position)
    })
  }, [unseenBelow, updateScrollButton, capturePosition])

  // The spacer holds exactly the room the anchored turn has not filled yet: a
  // viewport minus the height from the question's top to the end of the list.
  // As the answer grows the spacer shrinks by the same amount, so the list's
  // scroll height never changes and nothing is ever clamped. A fixed viewport
  // released at the end of the stream did change it: the browser clamped the
  // scroll position and a short answer dropped by the room it had not used,
  // hundreds of pixels, the moment it finished (ADR-0066). So the spacer is
  // never released when the answer lands: what is left below a short answer
  // is the space that keeps its question at the top, and the next question or
  // a thread swap takes it. Idempotent, so the resize it causes settles on the
  // next observation. Measured without the row's entrance rise, which is a
  // transform the layout does not have.
  const fitAnchorSpacer = useCallback(() => {
    const container = scrollContainerRef.current
    const spacer = anchorSpacerRef.current
    if (!anchoredRef.current || !container || !spacer) return
    const target = container.querySelector<HTMLElement>('[data-chat-anchor="true"]')
    if (!target) return
    // The list's bottom padding (the composer's height plus a gap) is scroll
    // room as well. Counted, the spacer absorbs a composer that changes height
    // (it shrinks after a send): the padding gives up what the spacer takes,
    // the scroll height holds, and nothing is clamped.
    const padding =
      Number.parseFloat(getComputedStyle(spacer.parentElement ?? spacer).paddingBottom) || 0
    const filled = spacer.getBoundingClientRect().top - layoutTop(target)
    const room = `${Math.max(0, Math.round(container.clientHeight - filled - padding))}px`
    if (spacer.style.minHeight !== room) spacer.style.minHeight = room
  }, [])

  // Follow height growth (streaming tokens AND newly appended messages) via a
  // ResizeObserver on the list, while the reader follows. rAF + behavior:'auto'
  // rides a live answer's growth frame by frame; growth after the turn ended
  // (a post-answer stage, the follow-ups rail) glides instead of jumping, since
  // the reader is reading by then. When the reader is not following we don't
  // move them — the jump button surfaces instead. The viewport is observed
  // too: its height is the other input of the anchor spacer.
  useEffect(() => {
    const content = contentRef.current
    const viewport = scrollContainerRef.current
    if (!content) return
    // Only GROWTH means "newer content below". The observer also fires when the
    // list shrinks — collapsing a Herleitung or a code block above the viewport.
    let lastHeight = content.getBoundingClientRect().height
    const observer = new ResizeObserver((entries) => {
      let height = lastHeight
      let viewportResized = false
      for (const entry of entries) {
        if (entry.target === content) height = entry.contentRect.height
        else if (entry.target === viewport) viewportResized = true
      }
      const grew = height > lastHeight
      lastHeight = height
      fitAnchorSpacer()
      // A deep link still waiting for its message owns the position.
      if (followRef.current && (grew || viewportResized) && !isTargetPending()) {
        cancelAnimationFrame(followRafRef.current)
        followRafRef.current = requestAnimationFrame(() => {
          // Re-read at run time: the reader may have left, or a send anchored,
          // since this was queued. And not under a hand: while a finger is
          // down or a wheel/fling is still moving the thread, the reader's
          // scroll wins; the next growth after it ends follows again.
          if (!followRef.current) return
          const handOnScroll =
            touchActiveRef.current ||
            performance.now() - lastReaderInputRef.current < GESTURE_SETTLE_MS
          if (handOnScroll) return
          scrollToContentEnd(turnLiveRef.current || reducedMotionRef.current ? 'auto' : 'smooth')
        })
      }
      updateScrollButton()
    })
    observer.observe(content)
    if (viewport) observer.observe(viewport)
    // The composer's height reaches the list as `--composer-h` on an ancestor's
    // style, which no ResizeObserver here sees change: watch the attribute, on
    // every ancestor. Found by the variable, the host was missed whenever the
    // composer had not measured itself yet (the first thread after a mount), and
    // a composer that shrank after the send left the spacer unfitted.
    const composerWatch = new MutationObserver(() => fitAnchorSpacer())
    for (let host = viewport?.parentElement; host; host = host.parentElement) {
      composerWatch.observe(host, { attributes: true, attributeFilter: ['style'] })
    }
    return () => {
      cancelAnimationFrame(followRafRef.current)
      observer.disconnect()
      composerWatch.disconnect()
    }
    // Re-attach when the list mounts/unmounts (skeleton ↔ list ↔ welcome), and
    // per thread: the list's height measured in the last thread is not this
    // one's, and its first growth read as a shrink.
  }, [
    scrollToContentEnd,
    fitAnchorSpacer,
    updateScrollButton,
    isTargetPending,
    isEmpty,
    listReady,
    currentConversation?.id,
  ])

  useEffect(() => () => glideRef.current?.stop(), [])

  // A colleague's turn, watched live, is anchored like the reader's own: its
  // question at the top, the answer filling downward. Without it the observer
  // who was following the end chased the bottom of an answer they had not
  // asked for, the question scrolling off above. Only for an observer who was
  // at the end: following, or watching the last anchored turn with its end in
  // view (anchoring stops following, so asking for following alone anchored
  // the first colleague's turn and none after it). One reading further up is
  // not moved. The reader's own send takes the anchor back.
  const spectatorLive = isForeignTurn && spectatingLive
  const [spectatorAnchor, setSpectatorAnchor] = useState<{
    id: string
    sentId: string | null | undefined
  } | null>(null)
  /**
   * Whether the reader was at the end when this question arrived: its top, the
   * end of the content before it, is in view above the composer. Measured at
   * the new row rather than at the content's end, which the row itself has
   * just moved down by its height.
   */
  const sawQuestionArrive = useCallback((questionId: string): boolean => {
    const container = scrollContainerRef.current
    const row = document.getElementById(`message-${questionId}`)
    if (!container || !row || !container.contains(row)) return false
    return layoutTop(row) - visibleBottom(container) <= UNSEEN_SLACK_PX
  }, [])
  useEffect(() => {
    const questionId = threadLayout.lastQuestionId
    if (!spectatorLive || !questionId) return
    if (!followRef.current && !(anchoredRef.current && sawQuestionArrive(questionId))) return
    setSpectatorAnchor((previous) =>
      previous?.id === questionId ? previous : { id: questionId, sentId: currentUserMessageId }
    )
  }, [spectatorLive, threadLayout.lastQuestionId, currentUserMessageId, sawQuestionArrive])
  const anchorId =
    spectatorAnchor && spectatorAnchor.sentId === currentUserMessageId
      ? spectatorAnchor.id
      : currentUserMessageId
  const prevAnchorIdRef = useRef<string | null | undefined>(anchorId)

  // Anchor a NEWLY-sent user question near the TOP of the viewport and DISENGAGE
  // following, so the streaming answer fills downward from the question instead
  // of the controller chasing the bottom (which scrolled the question
  // off-screen). Runs only when `currentUserMessageId` transitions to a
  // brand-new id — never on mount / restore (prevAnchorIdRef is seeded with
  // the mount value). A layout effect so following stops, and a follow scroll
  // queued before the send is cancelled, BEFORE the ResizeObserver's
  // post-layout callback can act on the send's own growth. The scroll itself
  // waits a frame, so the question is measured where it landed (an error card
  // a retry removed has given up its height by then).
  useLayoutEffect(() => {
    const id = anchorId
    if (!id || id === prevAnchorIdRef.current) return
    prevAnchorIdRef.current = id
    const container = scrollContainerRef.current
    if (!container?.querySelector('[data-chat-anchor="true"]')) return
    followRef.current = false
    jumpedRef.current = false
    cancelAnimationFrame(followRafRef.current)
    glideRef.current?.stop()
    setShowScrollButton(false)
    // Guarantee the question can actually reach the top: reserve the scroll
    // room below it (imperative — no extra render). The streaming answer
    // consumes that room as it grows (`fitAnchorSpacer`).
    anchoredRef.current = true
    fitAnchorSpacer()
    const retry = performance.now() - retryAtRef.current < RETRY_ANCHOR_WINDOW_MS
    const raf = requestAnimationFrame(() => {
      const target = container.querySelector<HTMLElement>('[data-chat-anchor="true"]')
      if (!target) return
      fitAnchorSpacer()
      // scroll-mt on the anchored turn keeps clearance for the floating
      // toolbar pills, so the question lands just below them.
      const margin = Number.parseFloat(getComputedStyle(target).scrollMarginTop) || 0
      const top =
        container.scrollTop + layoutTop(target) - container.getBoundingClientRect().top - margin
      // A retried question is usually already in view, one card above where
      // its error was: moving it the last few hundred pixels reads as a jolt.
      if (retry && Math.abs(top - container.scrollTop) < container.clientHeight) return
      // Already there: a write would still count as a scroll the reader saw.
      if (Math.abs(top - container.scrollTop) < 1) return
      glideRef.current = glideScrollTo(container, top, {
        reducedMotion: reducedMotionRef.current,
      })
    })
    return () => cancelAnimationFrame(raf)
  }, [anchorId, fitAnchorSpacer])

  // ── Opening a thread ───────────────────────────────────────────────────────
  // On a switch, the anchor and the follow state of the thread left go with it.
  // A layout effect, and the position set directly: a frame later (as this
  // was), the new thread painted once at the old one's scroll position and
  // then jumped.
  //
  // Not when the conversation is the one this send just created. The first
  // question of a new chat brings the conversation id in the same commit that
  // anchors the question (the anchor's layout effect, above, runs first), and
  // a reset here undid the anchor: the view chased the bottom of the growing
  // Herleitung, the question 2,900 px above it on a phone (Herleitung audit,
  // 2026-09).
  //
  // Where the thread opens, once its messages are here, in this order: the
  // message a deep link names (`useMessageAnchor` puts it there); in a shared
  // thread, where the reader left off (the unread divider); where the reader
  // was when they left it this session; else its end, or, when the last
  // turn is taller than the viewport, that turn's question, so a long answer
  // is read from its start rather than from its last line.
  const positionedConversationRef = useRef<string | null | undefined>(null)
  useLayoutEffect(() => {
    const id = currentConversation?.id
    if (shownConversationIdRef.current !== id) {
      const createdBySend = shownConversationIdRef.current === undefined && anchoredRef.current
      shownConversationIdRef.current = id
      cancelAnimationFrame(positionRafRef.current)
      positionRafRef.current = 0
      if (createdBySend) {
        positionedConversationRef.current = id
        return
      }
      glideRef.current?.stop()
      followRef.current = true
      jumpedRef.current = false
      setShowScrollButton(false)
      anchoredRef.current = false
      setSpectatorAnchor(null)
      if (anchorSpacerRef.current) anchorSpacerRef.current.style.minHeight = '0px'
      positionedConversationRef.current = null
      // The link's position held for its own visit. Coming back is a switch
      // like any other: kept, the thread was never placed again.
      deepLinkedConversationRef.current = undefined
    }
    const container = scrollContainerRef.current
    if (!id || !listReady || isEmpty || !container || positionedConversationRef.current === id)
      return
    positionedConversationRef.current = id

    if (isTargetPending() || deepLinkedConversationRef.current === id) {
      followRef.current = false
      return
    }
    const viewportTop = container.getBoundingClientRect().top
    // A row's scroll position, less its scroll margin (the floating toolbar's
    // clearance) when it is to land at the top.
    const rowTop = (rowId: string, { clearToolbar }: { clearToolbar: boolean }): number | null => {
      const row = document.getElementById(`message-${rowId}`)
      if (!row || !container.contains(row)) return null
      const margin = clearToolbar
        ? Number.parseFloat(getComputedStyle(row).scrollMarginTop) || 0
        : 0
      return container.scrollTop + layoutTop(row) - viewportTop - margin
    }
    // One write, and none where the thread already is: each is a scroll the
    // reader did not make.
    const openAt = (top: number, { follow }: { follow: boolean } = { follow: false }) => {
      followRef.current = follow
      if (Math.abs(container.scrollTop - top) >= 1) container.scrollTop = top
    }
    // A thread switched back to mid-turn is anchored again, as it was: its
    // question held at the top and the answer filling down from it. Opened
    // at its end and following, it scrolled with every flush of the answer
    // (25 scrolls in one switch-and-back, motion audit 2026-10).
    const liveQuestion =
      turnLiveRef.current && anchorId ? rowTop(anchorId, { clearToolbar: true }) : null
    if (liveQuestion !== null) {
      anchoredRef.current = true
      fitAnchorSpacer()
    }
    if (unreadDividerBeforeId) {
      const top = rowTop(unreadDividerBeforeId, { clearToolbar: true })
      if (top !== null) return openAt(top)
    }
    const saved = readThreadPosition(id)
    if (saved && !saved.atEnd) {
      const top = rowTop(saved.messageId, { clearToolbar: false })
      if (top !== null) return openAt(top - saved.offsetTop)
    }
    if (liveQuestion !== null) return openAt(liveQuestion)
    const end = container.scrollHeight - container.clientHeight
    const lastQuestion = saved ? null : threadLayout.lastQuestionId
    const questionTop = lastQuestion ? rowTop(lastQuestion, { clearToolbar: true }) : null
    if (questionTop !== null && questionTop < end) openAt(Math.max(0, questionTop))
    else openAt(end, { follow: true })
    // Each input is read when its thread opens, not tracked: a later change of
    // the divider or the saved position must not move a thread being read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentConversation?.id, listReady, isEmpty])

  const handleScrollToLatest = useCallback(() => {
    glideRef.current?.stop()
    followRef.current = true
    jumpedRef.current = true
    setShowScrollButton(false)
    scrollToContentEnd(reducedMotionRef.current ? 'auto' : 'smooth')
  }, [scrollToContentEnd])

  // Retry an errored answer: clear the stale error card, then resend the last
  // user message through the live send path (or prefill the composer as a
  // fallback). The card goes FIRST and without its exit: it sits above where
  // the re-sent question lands, and a card that faded for 180 ms and then gave
  // up its height moved the just-anchored question up after it had arrived.
  const handleErrorRetry = useCallback(
    (messageId: string) => {
      instantExitIdsRef.current.add(messageId)
      // The retry also takes the failed turn's cut-off answer: it leaves with
      // the card, at once, for the same reason.
      for (const message of messages ?? []) {
        if (message.failed) instantExitIdsRef.current.add(message.id)
      }
      retryAtRef.current = performance.now()
      dismissErrorCard(messageId)
      retryLastUserMessage()
    },
    [retryLastUserMessage, dismissErrorCard, messages]
  )

  // Latency-gap typing indicator, shown at the bottom of the thread while a
  // HITL prompt (clarification, a Folgewege choice, a plan decision) the user
  // just answered waits for the turn to resume.
  //
  // Not for a just-sent question any more: from the send, the question's own
  // Herleitung header is the working cue (one object from send to settle, in
  // the place the reasoning will grow), so a typing bubble that a Herleitung
  // later replaced was a box swap.
  //
  // The answered prompt: `respondToPrompt` flips it to "received"
  // optimistically and `isStreaming` goes true the moment the reply is
  // sent, but that only says the answer LANDED — it says nothing about
  // Piloti having resumed. The Herleitung spinner for the turn, if any,
  // sits back at the TOP of the exchange (attached to the ORIGINAL user
  // message, not to whichever prompt is currently last), so on a
  // multi-round exchange it can be scrolled well out of view by the time
  // the reader answers the second or third question. Without a bottom
  // cue, an answered prompt just sits there looking finished — nothing
  // on screen says the turn is still going — until the next thing
  // eventually appears.
  const showTypingPlaceholder = useMemo(() => {
    if (!isStreaming) return false
    const last = displayableMessages[displayableMessages.length - 1]
    if (!last) return false
    return last.messageType === 'prompt' && !!last.isPromptResponded
  }, [isStreaming, displayableMessages])

  return {
    isAuthenticated,
    onSignIn,
    currentConversation,
    isStreaming,
    currentUserMessageId,
    isRecoveryPending,
    revealingId,
    turnLive,
    turns,
    failedTurnIdsRef,
    activeProjectId,
    dismissErrorCard,
    t,
    tCollaboration,
    currentUserId,
    showReasoningSkills,
    shared,
    myRole,
    accessLost,
    turnInFlight,
    typists,
    lastArrival,
    participants,
    engagement,
    engagementSuggestion,
    setEngagement,
    authorOf,
    spectatedTurn,
    spectatingLive,
    turnInFlightLabel,
    scrollContainerRef,
    contentRef,
    showScrollButton,
    anchorSpacerRef,
    prefersReducedMotion,
    rowEnter,
    rowLeave,
    rowVariants,
    messages,
    commissionRun,
    commissionFromFinding,
    continueRun,
    displayableMessages,
    isEmpty,
    showSkeleton,
    listArrivesFromSkeleton,
    connectionNote,
    highlightedMessageId,
    authorship,
    unreadDividerBeforeId,
    awaiting,
    release,
    threadAwaitsHuman,
    setHandbackDismissedFor,
    handback,
    showHandback,
    handleHandback,
    handleAskAgent,
    handleAskBack,
    hydratedRailIdsRef,
    liveShownIdsRef,
    hydratedIds,
    threadLayout,
    getStepsForUserMessage,
    answerHasBegun,
    renderedIdsRef,
    heldAnswerId,
    turnNote,
    handleScroll,
    anchorId,
    handleScrollToLatest,
    handleErrorRetry,
    showTypingPlaceholder,
  }
}

export type ChatAreaController = ReturnType<typeof useChatAreaController>
