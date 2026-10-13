'use client'

import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { MessageSquarePlus, MousePointer2, Sparkles, SquareDashed, X } from 'lucide-react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { PersonAvatar } from '@/components/ui/avatar-stack'
import { identityInk } from '@/components/ui/avatar-identity'
import { Kbd } from '@/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { PdfDocumentView } from '@/features/knowledge/components/pdf-document-view'
import { useTranslations } from '@/i18n'
import type { AnnotationView } from '@/lib/annotations/types'
import { documentFileUrl } from '@/lib/documents/urls'
import { cn } from '@/lib/utils'
import type { DocumentReview as ReviewState, ReviewTool } from '../../hooks/use-document-review'
import type { RoomPeerState } from '../../hooks/use-document-room'
import { ReviewPageLayer } from './review-page-layer'
import { ReviewPanel } from './review-panel'
import { DraftCard, ThreadCard } from './thread-card'

const TOOLS: Array<{ tool: ReviewTool; key: string; icon: typeof MousePointer2 }> = [
  { tool: 'select', key: 'V', icon: MousePointer2 },
  { tool: 'point', key: 'C', icon: MessageSquarePlus },
  { tool: 'region', key: 'R', icon: SquareDashed },
]

/** Whether a key press belongs to a field the reader is typing in. */
const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))

/** The people in the room, one face per person however many tabs they have open. */
function people(peers: readonly RoomPeerState[]): RoomPeerState[] {
  const byUser = new Map<string, RoomPeerState>()
  for (const state of peers) if (!byUser.has(state.peer.userId)) byUser.set(state.peer.userId, state)
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
  const others = people(review.room.peers)
  const pilotiHere = review.tour !== null
  if (others.length === 0 && !pilotiHere) return null
  return (
    <div className="flex items-center -space-x-1" data-testid="review-presence">
      {pilotiHere && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="bg-foreground text-background ring-background relative flex size-7 items-center justify-center rounded-full ring-2">
              <Sparkles className="size-3.5" aria-hidden />
            </span>
          </TooltipTrigger>
          <TooltipContent>{t('review.pilotiWorking')}</TooltipContent>
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
            <TooltipContent>{on ? t('review.unfollow', { name: state.peer.name }) : t('review.follow', { name: state.peer.name })}</TooltipContent>
          </Tooltip>
        )
      })}
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
 * in the room as a colleague whose findings arrive as proposals: its pointer
 * walks to each one as it lands, and nothing it sets counts until a person
 * takes it over.
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
  onAskPiloti,
  onReviewWithPiloti,
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
  onAskPiloti?: (annotation: AnnotationView) => void
  /** Ask Piloti to go through the document and propose what it finds. */
  onReviewWithPiloti?: () => void
}): JSX.Element {
  const t = useTranslations('files')
  const [focus, setFocus] = useState<{ page: number; y: number; key: string; instant?: boolean } | null>(null)
  const [following, setFollowing] = useState<string | null>(null)
  const { annotations, select, setTool, tool, selectedId, draft, setDraft, room } = review

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
      if (event.key === 'Escape') {
        if (typing(event.target) && !draft) return
        event.preventDefault()
        if (draft) setDraft(null)
        else if (following) setFollowing(null)
        else if (tool !== 'select') setTool('select')
        else if (selectedId) select(null)
        else close()
        return
      }
      if (typing(event.target)) return
      const key = event.key.toLowerCase()
      if (key === 'v') setTool('select')
      else if ((key === 'c' || key === 'r') && review.canAnnotate) setTool(key === 'c' ? 'point' : 'region')
      else if (key === 'j' || key === 'k') {
        const next = review.step(key === 'j' ? 1 : -1)
        if (next) bring(next)
      } else if (key === 'e' && selectedId) {
        const current = annotations.find((annotation) => annotation.id === selectedId)
        if (!current?.canEdit) return
        if (current.status === 'proposed' || current.status === 'open') {
          void review.update(current.id, { status: current.status === 'proposed' ? 'open' : 'resolved' }).catch(() => {})
        }
      } else return
      event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, draft, following, tool, selectedId, annotations, review, select, setDraft, setTool, close, bring])

  /** The tools as a cluster of their own, the one in hand filled in ink: what the pointer will do is never a guess. */
  const tools = review.canAnnotate ? (
    <div
      role="toolbar"
      aria-label={t('review.toolsLabel')}
      data-testid="review-tools"
      className="bg-popover/95 border-border/70 pointer-events-auto absolute bottom-4 left-4 z-30 flex items-center gap-0.5 rounded-xl border p-1 shadow-md backdrop-blur-md"
    >
      {TOOLS.map(({ tool: option, key, icon: Icon }) => (
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
                'flex size-8 items-center justify-center rounded-lg transition-colors duration-quick ease-out outline-none focus-visible:ring-2 focus-visible:ring-ring/60 [&_svg]:size-4',
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
    </div>
  ) : null

  const walkProposals = useCallback(() => {
    const next = review.step(1, 'proposed')
    if (next) bring(next)
  }, [review, bring])

  const followedState = following ? room.peers.find((state) => state.peer.peerId === following) : null

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
        <header className="flex h-13 shrink-0 items-center gap-3 border-b px-3">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label={t('review.close')}
            title={`${t('review.close')} (Esc)`}
            onClick={close}
          >
            <X className="size-4" aria-hidden />
          </Button>
          <div className="min-w-0">
            <DialogTitle className="text-foreground truncate text-sm font-semibold">{documentName}</DialogTitle>
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
          <div className="ml-auto flex items-center gap-3">
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
            {onReviewWithPiloti && review.canAnnotate && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 gap-1.5"
                data-testid="review-with-piloti"
                onClick={onReviewWithPiloti}
              >
                <Sparkles className="size-3.5" aria-hidden />
                {t('review.reviewWithPiloti')}
              </Button>
            )}
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          <div
            className="relative min-w-0 flex-1"
            onWheelCapture={() => following && setFollowing(null)}
            onPointerDownCapture={() => following && setFollowing(null)}
          >
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
              onViewport={room.sendViewport}
              pageOverlay={(page) => (
                <ReviewPageLayer
                  page={page}
                  review={review}
                  focused
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
                        onAskPiloti={onAskPiloti}
                        onCopyLink={(annotation) => {
                          const url = new URL(window.location.href)
                          url.searchParams.set('doc', annotation.documentId)
                          url.searchParams.set('review', '1')
                          url.searchParams.set('mark', annotation.id)
                          void navigator.clipboard
                            ?.writeText(url.toString())
                            .then(() => toast.success(t('review.linkCopied')))
                        }}
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
      </DialogContent>
    </Dialog>
  )
}
