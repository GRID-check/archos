'use client'

import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import Link from 'next/link'
import {
  ArrowDown,
  ArrowUp,
  MessageCircle,
  MessageSquarePlus,
  MessagesSquare,
  MousePointer2,
  RotateCcw,
  Sparkles,
  SquareDashed,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useMediaQuery } from '@/hooks/use-media-query'
import { Button } from '@/components/ui/button'
import { PersonAvatar } from '@/components/ui/avatar-stack'
import { identityInk } from '@/components/ui/avatar-identity'
import { Kbd } from '@/components/ui/kbd'
import { MiddleTruncate } from '@/components/ui/middle-truncate'
import { PilotiGlyph } from '@/components/ui/piloti-glyph'
import { ShimmerText } from '@/components/ui/shimmer-text'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { PdfDocumentView } from '@/features/knowledge/components/pdf-document-view'
import { liveLine } from '@/features/chat/lib/turn-events'
import { useTranslations } from '@/i18n'
import type { AnnotationView } from '@/lib/annotations/types'
import { documentFileUrl } from '@/lib/documents/urls'
import { cn } from '@/lib/utils'
import { stepsOf, type CanvasAsk } from '../../hooks/use-canvas-ask'
import type { DocumentReview as ReviewState, ReviewTool } from '../../hooks/use-document-review'
import type { RoomPeerState } from '../../hooks/use-document-room'
import { CursorChat } from './cursor-chat'
import { PilotiAnswerCard } from './piloti-answer-card'
import { isPilotiPeer, ReviewPageLayer } from './review-page-layer'
import { ReviewPanel } from './review-panel'
import { ReviewExportMenu } from './review-export-menu'
import { DraftCard, ThreadCard } from './thread-card'

const TOOLS: Array<{ tool: ReviewTool; key: string; icon: typeof MousePointer2 }> = [
  { tool: 'select', key: 'V', icon: MousePointer2 },
  { tool: 'point', key: 'C', icon: MessageSquarePlus },
  { tool: 'region', key: 'R', icon: SquareDashed },
  { tool: 'ask', key: 'P', icon: Sparkles },
]

/** Which tools a reader has: marks need the right to set them; Piloti needs a project to ask in. */
const toolOffered = (tool: ReviewTool, review: ReviewState): boolean =>
  tool === 'select' || (tool === 'ask' ? review.piloti.available : review.canAnnotate)

/** Whether a key press belongs to a field the reader is typing in. */
const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))

/** The people in the room, one face per person however many tabs they have open. Piloti is not one of them. */
function people(peers: readonly RoomPeerState[]): RoomPeerState[] {
  const byUser = new Map<string, RoomPeerState>()
  for (const state of peers) {
    if (!isPilotiPeer(state) && !byUser.has(state.peer.userId)) byUser.set(state.peer.userId, state)
  }
  return [...byUser.values()]
}

/**
 * Who else is here, as faces in their colour. A face is also the way to follow
 * them: the view goes where theirs goes until the reader moves on their own.
 */
function Presence({
  review,
  following,
  onFollow,
}: {
  review: ReviewState
  following: string | null
  onFollow: (peerId: string | null) => void
}): JSX.Element | null {
  const t = useTranslations('files')
  const tPresence = useTranslations('presence')
  const others = people(review.room.peers)
  // Piloti in the room as itself: a peer the server publishes while it works on
  // the document, naming whose request it works on (ADR-0105). The full name
  // here, where there is room; the cursor tag carries the first name.
  const piloti = review.room.peers.find(isPilotiPeer) ?? null
  const forName = piloti?.peer.forName
  const onBehalf = forName ? tPresence('piloti.onBehalfOf', { name: forName }) : null
  if (others.length === 0 && !piloti) return null
  return (
    <div className="flex items-center -space-x-1" data-testid="review-presence">
      {piloti && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span data-testid="review-presence-piloti" className="ring-background rounded-full ring-2">
              <PilotiGlyph size="md" working={Boolean(piloti.activity)} label={onBehalf ?? 'Piloti'} />
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {onBehalf ? (
              <>
                <span className="block">{onBehalf}</span>
                {piloti.activity?.label && <span className="block opacity-80">{piloti.activity.label}</span>}
              </>
            ) : (
              piloti.activity?.label || t('review.pilotiWorking')
            )}
          </TooltipContent>
        </Tooltip>
      )}
      {others.map((state) => {
        const on = following === state.peer.peerId
        return (
          <Tooltip key={state.peer.userId}>
            <TooltipTrigger asChild>
              <button
                type="button"
                data-testid="review-peer"
                aria-pressed={on}
                aria-label={on ? t('review.unfollow', { name: state.peer.name }) : t('review.follow', { name: state.peer.name })}
                onClick={() => onFollow(on ? null : state.peer.peerId)}
                className="relative rounded-full outline-none focus-visible:ring-2"
              >
                <PersonAvatar
                  size="sm"
                  className="ring-background size-7 text-[10px] ring-2"
                  person={{ userId: state.peer.userId, name: state.peer.name, profilePictureUrl: null }}
                />
                <span
                  aria-hidden
                  className={cn('absolute -inset-[3px] rounded-full border-2', on ? 'opacity-100' : 'opacity-0')}
                  style={{ borderColor: identityInk(state.peer.userId) }}
                />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              <span className="block">
                {on ? t('review.unfollow', { name: state.peer.name }) : t('review.follow', { name: state.peer.name })}
              </span>
              {pageOf(state) && (
                <span className="block opacity-80">{t('review.onPage', { name: state.peer.name, page: pageOf(state) ?? 1 })}</span>
              )}
            </TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}

/** The page a person is on: where their pointer is, else where they are scrolled to. */
const pageOf = (state: RoomPeerState): number | null => state.cursor?.page ?? state.viewport?.page ?? null

/**
 * The people on another page than this reader, at the edge of the sheet that
 * leads to them, the way a design tool keeps a colleague's pointer at the
 * edge of the canvas when it is off-screen: above for an earlier page, below
 * for a later one. A chip jumps there; following stays the face's.
 */
function Elsewhere({
  review,
  page,
  onJump,
}: {
  review: ReviewState
  page: number | null
  onJump: (state: RoomPeerState) => void
}): JSX.Element | null {
  const t = useTranslations('files')
  if (page === null) return null
  const away = people(review.room.peers).flatMap((state) => {
    const at = pageOf(state)
    return at !== null && at !== page ? [{ state, at }] : []
  })
  if (away.length === 0) return null
  const edge = (above: boolean) => {
    const here = away.filter(({ at }) => (above ? at < page : at > page))
    if (here.length === 0) return null
    return (
      <div
        className={cn(
          'pointer-events-none absolute left-1/2 z-30 flex -translate-x-1/2 flex-wrap justify-center gap-1.5',
          above ? 'top-3' : 'bottom-16 pointer-coarse:bottom-32'
        )}
        data-testid={above ? 'review-elsewhere-above' : 'review-elsewhere-below'}
      >
        {here.map(({ state, at }) => {
          const Arrow = above ? ArrowUp : ArrowDown
          return (
            <button
              key={state.peer.userId}
              type="button"
              data-testid="review-elsewhere"
              aria-label={t('review.elsewhereJump', { name: state.peer.name, page: at })}
              title={t('review.elsewhereJump', { name: state.peer.name, page: at })}
              onClick={() => onJump(state)}
              className="pointer-events-auto inline-flex items-center gap-1 rounded-full py-0.5 pr-2 pl-1.5 text-[11px] leading-4 font-medium text-white shadow-md outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
              style={{ backgroundColor: identityInk(state.peer.userId) }}
            >
              <Arrow className="size-3" aria-hidden />
              {t('review.elsewhere', { name: state.peer.name.split(/\s+/)[0] ?? state.peer.name, page: at })}
            </button>
          )
        })}
      </div>
    )
  }
  return (
    <>
      {edge(true)}
      {edge(false)}
    </>
  )
}

/** The whole-document review asked of Piloti: the latest one, while it is in the header. */
const documentReviewOf = (asks: readonly CanvasAsk[]): CanvasAsk | null =>
  asks.findLast((ask) => ask.region === null && !ask.replyInThread) ?? null

/**
 * „Piloti prüfen lassen" in place: Piloti goes through the document while it
 * stays open, its findings landing as proposals through the room, its pointer
 * on the pages. The header says what it is doing, compactly, and where the
 * conversation is.
 */
function PilotiReview({ review }: { review: ReviewState }): JSX.Element {
  const t = useTranslations('files')
  const tChat = useTranslations('chat')
  const { piloti } = review
  const run = documentReviewOf(piloti.asks)
  if (!run) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8 gap-1.5"
        data-testid="review-with-piloti"
        disabled={piloti.busy}
        onClick={() => piloti.ask({ text: t('review.reviewSeed'), region: null, effort: 'medium' })}
      >
        <Sparkles className="size-3.5" aria-hidden />
        {/* On a phone the glyph carries it; the words stay for a screen reader. */}
        <span className="max-sm:sr-only">{t('review.reviewWithPiloti')}</span>
      </Button>
    )
  }
  const working = run.status === 'thinking'
  const line = working
    ? (liveLine(stepsOf(run.view), tChat) ?? t('review.piloti.reviewing'))
    : run.status === 'failed'
      ? t('review.piloti.reviewFailed')
      : t('review.piloti.reviewDone')
  return (
    <div
      role="status"
      data-testid="review-piloti-status"
      className="border-border/70 bg-muted/40 flex h-8 max-w-80 items-center gap-2 rounded-full border pr-1 pl-1"
    >
      <PilotiGlyph working={working} />
      {working ? (
        <ShimmerText className="min-w-0 flex-1 text-xs">{line}</ShimmerText>
      ) : (
        <span className="text-foreground min-w-0 flex-1 truncate text-xs font-medium">{line}</span>
      )}
      {piloti.conversationHref && (
        <Button asChild variant="ghost" size="sm" className="h-6 px-2 text-xs">
          <Link href={piloti.conversationHref} data-testid="review-piloti-conversation">
            {t('review.piloti.openConversation')}
          </Link>
        </Button>
      )}
      {run.status === 'failed' && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-6 rounded-full [&_svg]:size-3"
          aria-label={t('review.piloti.retry')}
          onClick={() => piloti.retry(run.id)}
        >
          <RotateCcw aria-hidden />
        </Button>
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-6 rounded-full [&_svg]:size-3"
        aria-label={working ? t('review.piloti.stop') : t('review.piloti.close')}
        title={working ? t('review.piloti.stop') : t('review.piloti.close')}
        data-testid="review-piloti-dismiss"
        onClick={() => piloti.dismiss(run.id)}
      >
        <X aria-hidden />
      </Button>
    </div>
  )
}

/**
 * The focused review of one document: the sheet, the marks on it, the threads
 * under them, and the people looking at it with you.
 *
 * Built for two moments an architect has with a drawing. Alone, with time: go
 * through a Fachplaner's sheet and leave what you find exactly where you found
 * it, without a form in the way (C, click, type, Enter). Together: a Jour fixe
 * or a call where everybody looks at the same sheet, sees each other's
 * pointers, follows whoever is talking, and watches the marks land. Piloti is
 * in the room as a colleague: asked about a box (P, or from a draft or a
 * thread), it answers beside it; asked to review the document, it works
 * through it with its own pointer, and its findings arrive as proposals that
 * count only once a person takes one over.
 *
 * Everything else of the workspace is gone while it is open (a full-screen
 * `Dialog`, the overlay the design language gives an artifact looked at with
 * full attention). Escape steps back one thing at a time: the draft, the tool,
 * the open thread, and only then the review itself.
 */
export function DocumentReviewMode({
  open,
  onOpenChange,
  review,
  documentName,
  fassungLabel,
  canPickAssignee,
  focusRequest,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  review: ReviewState
  documentName: string
  /** „Fassung 3", when the document has Fassungen to tell apart. */
  fassungLabel?: string | null
  canPickAssignee: boolean
  /** A mark to open at, when the review was entered from one. */
  focusRequest?: { annotationId: string; key: number } | null
}): JSX.Element {
  const t = useTranslations('files')
  const [focus, setFocus] = useState<{ page: number; y: number; key: string; instant?: boolean } | null>(null)
  const [following, setFollowing] = useState<string | null>(null)
  const { annotations, select, setTool, tool, selectedId, draft, setDraft, room, piloti } = review
  /**
   * The page this reader is on (the one crossing the middle of the view), for
   * who is elsewhere. Null until the viewer first reports: it opens on page 1.
   */
  const [viewPage, setViewPage] = useState<number | null>(null)
  const { sendViewport } = room
  const onViewport = useCallback(
    (viewport: { page: number; y: number }) => {
      setViewPage(viewport.page)
      sendViewport(viewport)
    },
    [sendViewport]
  )
  /** Cursor chat („/"): open, and where this reader's pointer last was, to open it there. */
  const [chat, setChat] = useState<{ from: { x: number; y: number } | null } | null>(null)
  const lastPointer = useRef<{ x: number; y: number } | null>(null)
  const openChat = useCallback(() => setChat({ from: lastPointer.current }), [])
  const jumpTo = useCallback((state: RoomPeerState) => {
    const page = pageOf(state)
    if (page === null) return
    setFollowing(null)
    const y = state.viewport?.page === page ? state.viewport.y : (state.cursor?.y ?? 0)
    setFocus({ page, y, key: `jump:${state.peer.peerId}:${Date.now()}` })
  }, [])
  const openAsk = piloti.asks.find((ask) => ask.id === piloti.openId) ?? null
  // From `lg` the list is a column beside the sheet; below it, a sheet from the
  // bottom edge behind a header button (a phone on its side is 852px, under `lg`).
  const listBeside = useMediaQuery('(min-width: 1024px)')
  const [listOpen, setListOpen] = useState(false)

  const bring = useCallback(
    (annotation: AnnotationView) => {
      setFollowing(null)
      setDraft(null)
      select(annotation.id)
      if (annotation.onCurrentFassung) {
        setFocus({ page: annotation.page, y: annotation.y + (annotation.h ?? 0) / 2, key: `${annotation.id}:${Date.now()}` })
      }
    },
    [select, setDraft]
  )

  // Entered from a mark: open at it, once per request, as soon as the list holds it.
  const handled = useRef<number | null>(null)
  useEffect(() => {
    if (!open || !focusRequest || handled.current === focusRequest.key) return
    const target = annotations.find((annotation) => annotation.id === focusRequest.annotationId)
    if (!target) return
    handled.current = focusRequest.key
    bring(target)
  }, [open, focusRequest, annotations, bring])

  // Following: the view goes where theirs goes.
  const followed = following ? room.peers.find((state) => state.peer.peerId === following) : null
  useEffect(() => {
    if (!following) return
    if (!followed) {
      setFollowing(null)
      return
    }
    if (!followed.viewport) return
    setFocus({
      page: followed.viewport.page,
      y: followed.viewport.y,
      key: `follow:${followed.viewport.page}:${followed.viewport.y.toFixed(3)}`,
      instant: true,
    })
  }, [following, followed])

  useEffect(() => {
    if (review.notice !== 'conflict') return
    toast.info(t('review.conflict'))
    review.dismissNotice()
  }, [review, t])

  const close = useCallback(() => {
    setFollowing(null)
    setDraft(null)
    setTool('select')
    onOpenChange(false)
  }, [onOpenChange, setDraft, setTool])

  // Escape steps back one thing at a time; letters pick tools and walk the marks.
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
      // The list's sheet is a layer of its own: its keys are its own.
      if (listOpen) return
      if (event.key === 'Escape') {
        if (typing(event.target) && !draft && !openAsk) return
        event.preventDefault()
        if (openAsk) piloti.open(null)
        else if (draft) setDraft(null)
        else if (following) setFollowing(null)
        else if (tool !== 'select') setTool('select')
        else if (selectedId) select(null)
        else close()
        return
      }
      if (typing(event.target)) return
      const key = event.key.toLowerCase()
      if (key === '/') openChat()
      else if (key === 'v') setTool('select')
      else if ((key === 'c' || key === 'r') && review.canAnnotate) setTool(key === 'c' ? 'point' : 'region')
      else if (key === 'p' && piloti.available) setTool('ask')
      else if (key === 'j' || key === 'k') {
        const next = review.step(key === 'j' ? 1 : -1)
        if (next) bring(next)
      } else if (key === 'e' && selectedId) {
        const current = annotations.find((annotation) => annotation.id === selectedId)
        if (!current?.canEdit) return
        if (current.status === 'proposed' || current.status === 'open') {
          void review
            .update(current.id, {
              status: current.status === 'proposed' ? 'open' : 'resolved',
              expectedStatus: current.status,
            })
            .catch(() => toast.error(t('review.actionFailed')))
        }
      } else if ((key === 'backspace' || key === 'delete') && selectedId) {
        // ⌫ on „Verwerfen" says it: a proposal in hand is dismissed, nothing else is.
        const current = annotations.find((annotation) => annotation.id === selectedId)
        if (!current?.canEdit || current.status !== 'proposed') return
        void review
          .update(current.id, { status: 'dismissed', expectedStatus: 'proposed' })
          .catch(() => toast.error(t('review.actionFailed')))
      } else return
      event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, listOpen, draft, openAsk, piloti, following, tool, selectedId, annotations, review, select, setDraft, setTool, close, bring, openChat, t])

  /** The tools as a cluster of their own, the one in hand filled in ink: what the pointer will do is never a guess. */
  const offered = TOOLS.filter(({ tool: option }) => toolOffered(option, review))
  const tools = (
    <div
      role="toolbar"
      aria-label={t('review.toolsLabel')}
      data-testid="review-tools"
      // On a touch screen the tools sit centred ABOVE the viewer's own pill,
      // at the thumb: left-aligned at the foot they lay over its page and zoom
      // controls on a phone. Navigate (the pointer) is the first of them, so
      // the mode the reader is in is always the filled one.
      className="bg-popover/95 border-border/70 pointer-events-auto absolute bottom-4 left-4 z-30 flex items-center gap-0.5 rounded-xl border p-1 shadow-md backdrop-blur-md pointer-coarse:bottom-[4.75rem] pointer-coarse:left-1/2 pointer-coarse:-translate-x-1/2"
    >
      {offered.map(({ tool: option, key, icon: Icon }) => (
        <Tooltip key={option}>
          <TooltipTrigger asChild>
            <button
              type="button"
              data-testid={`review-tool-${option}`}
              aria-pressed={tool === option}
              aria-keyshortcuts={key}
              aria-label={t(`review.tools.${option}`)}
              onClick={() => setTool(option)}
              className={cn(
                'flex size-8 items-center justify-center rounded-lg transition-colors duration-quick ease-out outline-none focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:size-11 [&_svg]:size-4',
                tool === option ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              )}
            >
              <Icon aria-hidden />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">
            {t(`review.tools.${option}`)} <Kbd className="ml-1">{key}</Kbd>
          </TooltipContent>
        </Tooltip>
      ))}
      {/* Cursor chat: a word beside the pointer for everyone in the room, never stored. */}
      <span aria-hidden className="bg-border mx-0.5 h-5 w-px pointer-coarse:hidden" />
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-testid="review-tool-chat"
            aria-pressed={chat !== null}
            aria-keyshortcuts="/"
            aria-label={t('review.chatOpen')}
            onClick={openChat}
            className={cn(
              'flex size-8 items-center justify-center rounded-lg transition-colors duration-quick ease-out outline-none focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:hidden [&_svg]:size-4',
              chat ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
          >
            <MessageCircle aria-hidden />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">
          {t('review.chatOpen')} <Kbd className="ml-1">/</Kbd>
        </TooltipContent>
      </Tooltip>
    </div>
  )

  const walkProposals = useCallback(() => {
    const next = review.step(1, 'proposed')
    if (next) bring(next)
  }, [review, bring])

  /** A link that opens the review at this mark, on the clipboard; a refusal says so. */
  const copyLink = useCallback(
    (annotation: AnnotationView) => {
      const url = new URL(window.location.href)
      url.searchParams.set('doc', annotation.documentId)
      url.searchParams.set('review', '1')
      url.searchParams.set('mark', annotation.id)
      if (!navigator.clipboard) {
        toast.error(t('review.linkCopyFailed'))
        return
      }
      void navigator.clipboard
        .writeText(url.toString())
        .then(() => toast.success(t('review.linkCopied')))
        .catch(() => toast.error(t('review.linkCopyFailed')))
    },
    [t]
  )

  const followedState = following ? room.peers.find((state) => state.peer.peerId === following) : null
  // A mark of an earlier Fassung is listed, never drawn: selected, its thread
  // opens over the sheet instead of beside a pin that is not there.
  const earlier = annotations.find((annotation) => annotation.id === selectedId && !annotation.onCurrentFassung) ?? null

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        // The sheet is what has focus to begin with, not the close button: a
        // ring on the X is the first thing an opened review would say.
        onOpenAutoFocus={(event) => event.preventDefault()}
        className="bg-background inset-0 top-0 left-0 flex h-dvh max-h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 p-0 sm:max-w-none"
        data-testid="document-review"
      >
        <header className="flex min-h-13 shrink-0 items-center gap-3 border-b px-3 pt-[env(safe-area-inset-top)] pr-[max(0.75rem,env(safe-area-inset-right))] pl-[max(0.75rem,env(safe-area-inset-left))] max-sm:gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 shrink-0 pointer-coarse:size-11"
            aria-label={t('review.close')}
            title={`${t('review.close')} (Esc)`}
            onClick={close}
          >
            <X className="size-4" aria-hidden />
          </Button>
          <div className="min-w-0 flex-1">
            {/* Cut in the middle: a phone's header leaves the name ~140px, and
                the index at its end is what says which Fassung is under review. */}
            <DialogTitle className="text-foreground flex text-sm font-semibold">
              <MiddleTruncate text={documentName} tail={12} />
            </DialogTitle>
            <DialogDescription className="text-muted-foreground truncate text-xs">
              {[
                fassungLabel,
                review.counts.open + review.counts.proposed > 0
                  ? t('annotations.openCount', { count: review.counts.open + review.counts.proposed })
                  : t('review.nothingOpen'),
              ]
                .filter(Boolean)
                .join(' · ')}
            </DialogDescription>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-3 max-sm:gap-2">
            {room.status === 'offline' && (
              <span
                className="text-muted-foreground text-[11px] font-medium"
                data-testid="review-offline"
                title={t('review.offlineHint')}
                role="status"
              >
                {t('review.offline')}
              </span>
            )}
            <Presence review={review} following={following} onFollow={setFollowing} />
            {!listBeside && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 pointer-coarse:h-11"
                aria-haspopup="dialog"
                aria-expanded={listOpen}
                aria-label={t('annotations.section')}
                data-testid="review-list-open"
                onClick={() => setListOpen(true)}
              >
                <MessagesSquare className="size-3.5" aria-hidden />
                <span className="font-mono tabular-nums">{review.counts.open + review.counts.proposed}</span>
              </Button>
            )}
            {annotations.length > 0 && listBeside && (
              <ReviewExportMenu
                documentId={review.documentId}
                hasFassungen={annotations.some((annotation) => !annotation.onCurrentFassung)}
                hasProposals={annotations.some((annotation) => annotation.authorKind === 'piloti' && !annotation.acceptedBy)}
              />
            )}
            {piloti.available && review.canAnnotate && <PilotiReview review={review} />}
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          <div
            className="relative min-w-0 flex-1"
            onWheelCapture={() => following && setFollowing(null)}
            onPointerDownCapture={() => following && setFollowing(null)}
            onPointerMove={(event) => {
              lastPointer.current = { x: event.clientX, y: event.clientY }
            }}
          >
            <Elsewhere review={review} page={viewPage ?? 1} onJump={jumpTo} />
            {earlier && !openAsk && !draft && (
              <div
                className="absolute top-4 left-1/2 z-40 flex -translate-x-1/2 flex-col items-center gap-2"
                data-testid="review-earlier-thread"
              >
                <p className="bg-popover/95 text-muted-foreground max-w-[20rem] rounded-lg border px-3 py-1.5 text-center text-[11px] leading-4 shadow-sm">
                  {t('review.earlierFassung', { number: earlier.fassungNumber ?? '?' })}
                </p>
                <ThreadCard
                  key={earlier.id}
                  review={review}
                  annotation={earlier}
                  flip={false}
                  detached
                  canPickAssignee={canPickAssignee}
                  onCopyLink={copyLink}
                />
              </div>
            )}
            {chat && (
              <CursorChat
                userId={room.self?.userId ?? null}
                from={chat.from}
                onChat={room.sendChat}
                onClose={() => setChat(null)}
              />
            )}
            {followedState && (
              <>
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-0 z-30 border-[3px]"
                  style={{ borderColor: identityInk(followedState.peer.userId) }}
                />
                <span
                  className="absolute top-3 left-1/2 z-30 -translate-x-1/2 rounded-full px-3 py-1 text-xs font-medium text-white shadow-md"
                  style={{ backgroundColor: identityInk(followedState.peer.userId) }}
                  role="status"
                >
                  {t('review.following', { name: followedState.peer.name })}
                </span>
              </>
            )}
            {tools}
            <PdfDocumentView
              src={documentFileUrl(review.documentId)}
              title={documentName}
              focus={focus}
              onViewport={onViewport}
              pageOverlay={(page) => (
                <ReviewPageLayer
                  page={page}
                  review={review}
                  focused
                  renderAsk={(ask, { flip }) => <PilotiAnswerCard key={ask.id} review={review} ask={ask} flip={flip} />}
                  renderThread={({ flip }) => {
                    if (draft && draft.page === page) {
                      return <DraftCard review={review} draft={draft} flip={flip} canPickAssignee={canPickAssignee} />
                    }
                    const selected = annotations.find((annotation) => annotation.id === selectedId)
                    return selected ? (
                      <ThreadCard
                        key={selected.id}
                        review={review}
                        annotation={selected}
                        flip={flip}
                        canPickAssignee={canPickAssignee}
                        onCopyLink={copyLink}
                      />
                    ) : null
                  }}
                />
              )}
              className="size-full"
            />
          </div>
          <ReviewPanel review={review} onOpen={bring} onWalkProposals={walkProposals} />
        </div>
        {!listBeside && (
          <Sheet open={listOpen} onOpenChange={setListOpen}>
            <SheetContent
              side="bottom"
              closeLabel={t('review.close')}
              data-testid="review-list-sheet"
              className="flex h-[70dvh] flex-col gap-0 rounded-t-2xl p-0 pb-[env(safe-area-inset-bottom)] sm:mx-auto sm:max-w-xl"
            >
              <SheetHeader className="flex-row items-center gap-2 px-4 pt-4 pr-14 pb-0">
                <SheetTitle className="text-base">{t('annotations.section')}</SheetTitle>
                <SheetDescription className="sr-only">{documentName}</SheetDescription>
                {annotations.length > 0 && (
                  <div className="ml-auto">
                    <ReviewExportMenu
                      documentId={review.documentId}
                      hasFassungen={annotations.some((annotation) => !annotation.onCurrentFassung)}
                      hasProposals={annotations.some(
                        (annotation) => annotation.authorKind === 'piloti' && !annotation.acceptedBy,
                      )}
                    />
                  </div>
                )}
              </SheetHeader>
              <ReviewPanel
                review={review}
                presentation="sheet"
                // Choosing a mark shows it: the sheet steps aside for the page.
                onOpen={(annotation) => {
                  setListOpen(false)
                  bring(annotation)
                }}
                onWalkProposals={() => {
                  setListOpen(false)
                  walkProposals()
                }}
              />
            </SheetContent>
          </Sheet>
        )}
      </DialogContent>
    </Dialog>
  )
}
