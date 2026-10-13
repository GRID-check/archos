'use client'

/**
 * CanvasActivityCard — what Piloti did on a document, told in the chat.
 *
 * Piloti acts on a document as a participant: it sets marks (Anmerkungen) and
 * answers in a mark's thread, from any conversation („Mach eine Anmerkung im
 * Grundriss EG beim Treppenhaus"). Piloti's canvas tools push this
 * card after it did, so the reader sees in the conversation what changed on the
 * sheet, and can step from here into the Prüfansicht at that mark and back.
 *
 * System-emitted (`src/aiq_agent/tools/canvas/cards.py`): every id on it is one
 * the annotations service returned, and the model cannot author one.
 *
 * ## One decision per mark
 *
 * A proposed mark is Piloti's until a person takes it over (a CHECK on
 * the canvas tools hold that). Each row asks on its own, „Übernehmen"
 * or „Verwerfen", through the same typed client the canvas uses, and stores
 * the reader's answer on the message under `itemDecisionKey` (ADR-0030), so a
 * reload shows it answered and offers nothing again.
 *
 * The canvas is live and the message is not. So the card reads the marks once
 * it is seen and lets that list win: a mark a colleague took over on the
 * canvas reads „Übernommen · Anna" here too. A move somebody beat the reader
 * to answers 409, and the row re-reads and shows what happened instead.
 *
 * Taking over is read-then-write. The API lets a discarded mark be opened
 * again (`dismissed → open` is the way back for a person who discarded one by
 * mistake), so a 409 cannot stop this card from reopening a mark a colleague
 * just discarded; the read right before the write is what does.
 */

import { useState, type JSX } from 'react'
import Image from 'next/image'
import { usePathname, useRouter } from 'next/navigation'
import { Check, MapPin, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { COMMENT_PIN_ON_POINT, CommentPin } from '@/components/ui/comment-pin'
import { PilotiGlyph } from '@/components/ui/piloti-glyph'
import { useSeenOnce } from '@/hooks/use-seen-once'
import { useTranslations } from '@/i18n'
import { isOptimizerEligible } from '@/lib/images/optimizable'
import { AnnotationRequestError, updateAnnotation } from '@/lib/annotations/client'
import { cn } from '@/lib/utils'
import { useChatStore } from '@/features/chat/store'
import { openReviewAt } from '@/features/documents/lib/open-review'
import { isCardDecision, itemDecisionKey } from '../card-decision'
import { selectCardDecision, useCardDecision } from '../hooks/use-card-decision'
import { useFirstPageThumbnail, useLiveMarks, type LiveMarks } from '../hooks/use-canvas-document'
import {
  activityCounts,
  isProposed,
  markState,
  placeStyle,
  type CanvasActivityDocument,
  type CanvasActivityItem,
  type CanvasProposedItem,
  type CanvasRepliedItem,
  type MarkState,
} from '../lib/canvas-activity'
import { ProposalShell } from './ProposalShell'
import { StackedLabel } from './StackedLabel'

/**
 * A sheet's proportions when the picture has not told us: A-series landscape,
 * the shape most drawings are set on. Once page 1's picture loads, its own
 * proportions are used for every row of the card.
 */
const DEFAULT_PAGE_ASPECT = Math.SQRT2

export interface CanvasActivityCardProps {
  document: CanvasActivityDocument
  items: readonly CanvasActivityItem[]
  /** Message this card belongs to — keys each mark's persisted decision. */
  messageId?: string
  /** Stable identity of this card within that message (`cardKey`). */
  cardKey: string
  /** Whether this surface requires the answers to be persisted. */
  decisionsMustPersist?: boolean
}

/** How the reader steps into the Prüfansicht: one function, so every button goes the same way. */
type ShowInDocument = (annotationId: string) => void

export function CanvasActivityCard({
  document,
  items,
  messageId,
  cardKey,
  decisionsMustPersist,
}: CanvasActivityCardProps): JSX.Element {
  const t = useTranslations('chat')
  const [seenRef, seen] = useSeenOnce<HTMLDivElement>()
  const counts = activityCounts(items)
  const live = useLiveMarks(document.id, seen && counts.proposed > 0)
  const thumbnail = useFirstPageThumbnail(document.id, seen && counts.proposed > 0)
  const [aspect, setAspect] = useState(DEFAULT_PAGE_ASPECT)
  const show = useShowInDocument(document.id)
  const [showError, setShowError] = useState(false)
  const proposedItems = items.filter(isProposed)
  // Every mark's stored answer, read in the same render as the rows read theirs,
  // so the accent is right on the first frame rather than one effect later. A
  // joined string, so the selector returns a primitive and cannot loop.
  const storedAnswers = useChatStore((state) =>
    proposedItems
      .map((item) => selectCardDecision(state, messageId, itemDecisionKey(cardKey, item.annotation_id)) ?? '')
      .join('|')
  ).split('|')

  const openAt: ShowInDocument = (annotationId) => {
    setShowError(false)
    void show(annotationId).then((ok) => setShowError(!ok))
  }

  // The accent: ink while any mark still waits for an answer, green once every
  // one is answered and something was kept (or Piloti only answered in a
  // thread), quiet when everything it proposed was discarded.
  const proposedStates = proposedItems.map((item, index) =>
    markState(isCardDecision(storedAnswers[index]) ? storedAnswers[index] : null, live.lookup(item.annotation_id))
  )
  const tone =
    proposedStates.some((state) => state === 'proposed')
      ? 'pending'
      : proposedStates.length > 0 && counts.replied === 0 && proposedStates.every((state) => state === 'dismissed' || state === 'gone')
        ? 'dismissed'
        : 'accepted'

  const first = items[0]

  return (
    <ProposalShell tone={tone}>
      <div ref={seenRef} className="flex flex-col gap-3" data-testid="canvas-activity-card">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <PilotiGlyph size="xs" />
          <p className="card-title text-foreground min-w-0">
            {headline(t, counts)}
            <span className="text-muted-foreground font-normal">
              {' · '}
              <span className="break-all">{document.name}</span>
            </span>
          </p>
          {first && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={() => openAt(first.annotation_id)}
              data-testid="canvas-activity-show"
            >
              <MapPin aria-hidden className="size-3.5" />
              {t('cards.canvasActivity.show')}
            </Button>
          )}
        </div>

        <ul className="flex flex-col gap-3">
          {items.map((item) =>
            isProposed(item) ? (
              <ProposedRow
                key={`p-${item.annotation_id}`}
                documentId={document.id}
                item={item}
                live={live}
                messageId={messageId}
                cardKey={cardKey}
                decisionsMustPersist={decisionsMustPersist}
                thumbnail={item.page === 1 ? thumbnail : null}
                aspect={aspect}
                onAspect={setAspect}
                onShow={openAt}
              />
            ) : (
              <RepliedRow key={`r-${item.annotation_id}-${item.number}`} item={item} onShow={openAt} />
            )
          )}
        </ul>

        {showError && (
          <p className="card-caption text-destructive" role="alert">
            {t('cards.canvasActivity.showError')}
          </p>
        )}
      </div>
    </ProposalShell>
  )
}

type Translate = ReturnType<typeof useTranslations>

/** „2 Anmerkungen vorgeschlagen", „Im Thread von #4 geantwortet", or both in one line. */
function headline(t: Translate, counts: ReturnType<typeof activityCounts>): string {
  if (counts.proposed > 0 && counts.replied > 0) {
    return t('cards.canvasActivity.headline.both', { count: counts.proposed, threads: counts.replied })
  }
  if (counts.proposed > 0) return t('cards.canvasActivity.headline.proposed', { count: counts.proposed })
  if (counts.repliedNumber !== null) {
    return t('cards.canvasActivity.headline.repliedOne', { number: counts.repliedNumber })
  }
  return t('cards.canvasActivity.headline.repliedMany', { count: counts.replied })
}

/**
 * The Prüfansicht at a mark, over the chat (`openReviewAt`). Resolves false
 * when the document could not be opened, so the card can say so.
 */
function useShowInDocument(documentId: string): (annotationId: string) => Promise<boolean> {
  const router = useRouter()
  const pathname = usePathname()
  const projectId = useChatStore((s) => s.projectId)
  return async (annotationId) => {
    if (!projectId) return false
    const result = await openReviewAt(
      { documentId, annotationId },
      {
        projectId,
        location: pathname ? { pathname, search: window.location.search, hash: window.location.hash } : undefined,
        navigate: (href, how) => (how === 'push' ? router.push(href) : router.replace(href, { scroll: false })),
      }
    )
    return result !== 'unavailable'
  }
}

/**
 * The page, small, with the mark where it sits: Piloti's ink, dashed while it
 * is a proposal (the canvas's own convention, `review-page-layer.tsx`). On
 * page 1 the page is the document's own first-page picture.
 */
function PageSilhouette({
  item,
  state,
  thumbnail,
  aspect,
  onAspect,
}: {
  item: CanvasProposedItem
  state: MarkState
  thumbnail: string | null
  aspect: number
  onAspect: (aspect: number) => void
}): JSX.Element {
  const proposed = state === 'proposed'
  const done = state === 'resolved' || state === 'dismissed' || state === 'gone'
  const place = placeStyle(item)
  return (
    <span aria-hidden className="relative block w-20 shrink-0 self-start" style={{ aspectRatio: String(aspect) }}>
      <span className="border-border bg-background absolute inset-0 overflow-hidden rounded-[2px] border">
        {thumbnail && (
          <Image
            src={thumbnail}
            alt=""
            fill
            sizes="80px"
            unoptimized={!isOptimizerEligible(thumbnail)}
            className="object-fill opacity-80"
            onLoad={(event) => {
              const { naturalWidth, naturalHeight } = event.currentTarget
              if (naturalWidth > 0 && naturalHeight > 0) onAspect(naturalWidth / naturalHeight)
            }}
          />
        )}
        {place.width && (
          <span
            data-testid="canvas-activity-region"
            className={cn(
              'border-foreground absolute rounded-[1px] border-[1.5px]',
              proposed && 'border-dashed',
              done && 'opacity-40'
            )}
            style={place}
          />
        )}
      </span>
      <span className={cn('absolute z-10', COMMENT_PIN_ON_POINT)} style={{ left: place.left, top: place.top }}>
        <CommentPin
          as="span"
          number={item.number}
          proposed={proposed}
          done={done}
          className="origin-bottom-left scale-75"
        />
      </span>
    </span>
  )
}

/** One mark Piloti proposed: where it is, what it says, and the reader's answer. */
function ProposedRow({
  documentId,
  item,
  live,
  messageId,
  cardKey,
  decisionsMustPersist,
  thumbnail,
  aspect,
  onAspect,
  onShow,
}: {
  documentId: string
  item: CanvasProposedItem
  live: LiveMarks
  messageId?: string
  cardKey: string
  decisionsMustPersist?: boolean
  thumbnail: string | null
  aspect: number
  onAspect: (aspect: number) => void
  onShow: ShowInDocument
}): JSX.Element {
  const t = useTranslations('chat')
  const { decision, decide, canDecide } = useCardDecision(messageId, itemDecisionKey(cardKey, item.annotation_id), {
    mustPersist: decisionsMustPersist,
  })
  const [busy, setBusy] = useState<'open' | 'dismissed' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const current = live.lookup(item.annotation_id)
  const state = markState(decision, current)
  const mayAnswer = state === 'proposed' && canDecide && (current === undefined || current === 'gone' || current.canEdit)

  const answer = async (status: 'open' | 'dismissed') => {
    if (busy) return
    setBusy(status)
    setError(null)
    try {
      // The card is a copy: it answers only the proposal it shows. If a
      // colleague answered it on the canvas meanwhile, the server says 409.
      const updated = await updateAnnotation(documentId, item.annotation_id, { status, expectedStatus: 'proposed' })
      live.adopt(updated)
      decide(status === 'open' ? 'accepted' : 'rejected')
    } catch (failure) {
      if (failure instanceof AnnotationRequestError && failure.status === 409) {
        // A colleague moved it first. Not the reader's decision, so nothing is
        // recorded: the row shows the state the canvas has now.
        await live.refresh()
      } else if (failure instanceof AnnotationRequestError && failure.status === 404) {
        live.forget(item.annotation_id)
      } else if (failure instanceof AnnotationRequestError && failure.status === 403) {
        setError(t('cards.canvasActivity.forbidden'))
      } else {
        setError(t('cards.canvasActivity.error'))
      }
    } finally {
      setBusy(null)
    }
  }

  const kind = t(`cards.canvasActivity.kinds.${item.kind}`)
  const who = current && current !== 'gone' ? (state === 'open' ? current.acceptedByName : current.closedByName) : null

  return (
    <li className="flex gap-3" data-testid="canvas-activity-proposed" data-state={state}>
      <PageSilhouette item={item} state={state} thumbnail={thumbnail} aspect={aspect} onAspect={onAspect} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="card-meta text-muted-foreground flex flex-wrap items-center gap-x-1.5">
          <span className="text-foreground font-mono">#{item.number}</span>
          <span aria-hidden>·</span>
          <span>{kind}</span>
          <span aria-hidden>·</span>
          <span>{t('cards.canvasActivity.page', { page: item.page })}</span>
          {state !== 'proposed' && <MarkStateLabel state={state} who={decision ? null : who} />}
        </p>
        <p className="card-body text-foreground line-clamp-2" title={item.body}>
          {item.body}
        </p>
        {error && (
          <p className="card-caption text-destructive" role="alert">
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {mayAnswer && (
            <>
              <Button
                type="button"
                size="sm"
                onClick={() => void answer('open')}
                aria-label={t('cards.canvasActivity.acceptLabel', { number: item.number })}
                aria-disabled={busy !== null || undefined}
                aria-busy={busy === 'open' || undefined}
                className="aria-disabled:cursor-default"
              >
                <StackedLabel
                  busy={busy === 'open'}
                  idle={t('cards.canvasActivity.accept')}
                  working={t('cards.canvasActivity.accepting')}
                />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void answer('dismissed')}
                aria-label={t('cards.canvasActivity.rejectLabel', { number: item.number })}
                aria-disabled={busy !== null || undefined}
                aria-busy={busy === 'dismissed' || undefined}
                className="aria-disabled:cursor-default aria-disabled:opacity-50"
              >
                {t('cards.canvasActivity.reject')}
              </Button>
            </>
          )}
          {state !== 'gone' && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onShow(item.annotation_id)}
              aria-label={t('cards.canvasActivity.showMarkLabel', { number: item.number })}
            >
              {t('cards.canvasActivity.show')}
            </Button>
          )}
        </div>
      </div>
    </li>
  )
}

/** Where a mark stands once it is no longer a proposal, and who put it there when somebody else did. */
function MarkStateLabel({ state, who }: { state: MarkState; who: string | null }): JSX.Element {
  const t = useTranslations('chat')
  const kept = state === 'open' || state === 'resolved'
  const Icon = kept ? Check : X
  return (
    <span
      className={cn('ml-auto inline-flex items-center gap-1', kept ? 'text-success' : 'text-muted-foreground')}
      data-testid="canvas-activity-state"
    >
      <Icon aria-hidden className="size-3" />
      {t(`cards.canvasActivity.state.${state}`)}
      {who && <span className="text-muted-foreground">· {who}</span>}
    </span>
  )
}

/** One answer Piloti posted into a mark's thread. */
function RepliedRow({ item, onShow }: { item: CanvasRepliedItem; onShow: ShowInDocument }): JSX.Element {
  const t = useTranslations('chat')
  return (
    <li className="flex gap-3" data-testid="canvas-activity-replied">
      <span className="flex w-20 shrink-0 justify-center pt-1" aria-hidden>
        <CommentPin as="span" number={item.number} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="card-meta text-muted-foreground">
          {t('cards.canvasActivity.repliedIn', { number: item.number })}
        </p>
        <p className="card-body text-foreground line-clamp-2" title={item.excerpt}>
          „{item.excerpt}“
        </p>
        <div className="pt-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onShow(item.annotation_id)}
            aria-label={t('cards.canvasActivity.showThreadLabel', { number: item.number })}
          >
            {t('cards.canvasActivity.show')}
          </Button>
        </div>
      </div>
    </li>
  )
}
