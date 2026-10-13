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
 * canvas reads „Übernommen · Anna" here too. While the card is on screen it
 * listens to the document's room and reads again on every change, sharing one
 * subscription with every other card on that document (`use-canvas-document`),
 * and a small dot beside Piloti's glyph says so. A move somebody beat the
 * reader to answers 409, and the row re-reads and shows what happened instead.
 *
 * Taking over is read-then-write. The API lets a discarded mark be opened
 * again (`dismissed → open` is the way back for a person who discarded one by
 * mistake), so a 409 cannot stop this card from reopening a mark a colleague
 * just discarded; the read right before the write is what does.
 *
 * ## What the person asked for
 *
 * When the person asks, Piloti does on a mark what they could do themselves,
 * in their name, and the card says so in their terms. A mark set on request
 * reads like a person's open mark. A change reads „#4 erledigt", „#4 Anna
 * zugewiesen", with the note Piloti left in the thread under it, and
 * „Rückgängig" goes to the server's change record (below). Taking a proposal
 * over and dismissing one have no way back, so they offer no undo.
 * A deleted mark is gone with its thread; the row says so, and offers the way
 * back only where the record does.
 *
 * ## The server's record wins (ADR-0109)
 *
 * Every change Piloti applied is a `piloti_changes` row with the turn that made
 * it. The card reads the rows of its own answer once it is seen, and again
 * whenever the document's live store says one of the card's marks moved. A row
 * with a change draws from it: who the turn acted for („für Miriam"), whether
 * somebody undid it („Rückgängig gemacht · Anna"), and whether the reader may
 * undo it now (`canUndo`). The undo is the server's compare-and-swap, run as
 * the reader: `moved-on` says calmly that somebody changed it since,
 * `already-undone` re-reads and shows who did.
 *
 * The card's own `items` stay the fallback for a row without a change: an
 * answer older than the record, or a request that failed. Only those rows
 * keep the browser-side replay of the card's copy (see `ChangedRow`).
 */

import { useCallback, useMemo, useState, type JSX } from 'react'
import Image from 'next/image'
import { usePathname, useRouter } from 'next/navigation'
import { Check, MapPin, Undo2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { COMMENT_PIN_ON_POINT, CommentPin } from '@/components/ui/comment-pin'
import { PilotiGlyph } from '@/components/ui/piloti-glyph'
import { useInView } from '@/hooks/use-in-view'
import { useSeenOnce } from '@/hooks/use-seen-once'
import { useLocale, useTranslations } from '@/i18n'
import { formatDayRange } from '@/lib/format'
import { isOptimizerEligible } from '@/lib/images/optimizable'
import { AnnotationRequestError, updateAnnotation } from '@/lib/annotations/client'
import { ChangeRequestError, undoChange } from '@/lib/changes/client'
import type { PilotiChangeView } from '@/lib/changes/types'
import { cn } from '@/lib/utils'
import { useChatStore } from '@/features/chat/store'
import { openReviewAt } from '@/features/documents/lib/open-review'
import { isCardDecision, itemDecisionKey } from '../card-decision'
import { selectCardConversationId, selectCardDecision, useCardDecision } from '../hooks/use-card-decision'
import { useFirstPageThumbnail, useLiveMarks, type LiveMarks } from '../hooks/use-canvas-document'
import { useTurnChanges, type TurnChanges } from '../hooks/use-turn-changes'
import {
  activityCounts,
  annotationIdOf,
  createdState,
  isProposed,
  isSet,
  markState,
  placeStyle,
  stillAsLeft,
  undoRequest,
  type CanvasActivityDocument,
  type CanvasActivityItem,
  type CanvasChangedItem,
  type CanvasDeletedItem,
  type CanvasFieldChange,
  type CanvasRepliedItem,
  type CanvasSetItem,
  type MarkState,
} from '../lib/canvas-activity'
import { matchChanges, standsAsChanged } from '../lib/canvas-changes'
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
  // Seen once: read the marks and the picture. On screen now: keep the marks
  // live, and let the document's channel go again when the card scrolls away.
  const [seenRef, seen] = useSeenOnce<HTMLDivElement>()
  const [viewRef, onScreen] = useInView<HTMLDivElement>()
  const cardRef = useCallback(
    (node: HTMLDivElement | null) => {
      seenRef(node)
      viewRef(node)
    },
    [seenRef, viewRef]
  )
  const counts = activityCounts(items)
  const setCount = counts.proposed + counts.created
  const hasMarks = setCount + counts.changed > 0
  const markIds = useMemo(() => items.map(annotationIdOf).filter((id): id is string => id !== null), [items])
  const live = useLiveMarks(document.id, { seen: seen && hasMarks, onScreen: onScreen && hasMarks, watch: markIds })
  // What the server records for this answer's turn, read once seen and again
  // when the live store says one of this card's marks moved.
  const conversationId = useChatStore((state) => selectCardConversationId(state, messageId))
  const changes = useTurnChanges(conversationId, messageId, { enabled: seen, token: live.touched })
  const changeOf = useMemo(() => matchChanges(items, changes.changes), [items, changes.changes])
  const thumbnail = useFirstPageThumbnail(document.id, seen && setCount > 0)
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
  // one is answered and something was kept (or Piloti did what it was asked),
  // quiet when the card holds only proposals and every one was discarded.
  const proposedStates = proposedItems.map((item, index) =>
    markState(isCardDecision(storedAnswers[index]) ? storedAnswers[index] : null, live.lookup(item.annotation_id))
  )
  const tone =
    proposedStates.some((state) => state === 'proposed')
      ? 'pending'
      : proposedStates.length === items.length && proposedStates.every((state) => state === 'dismissed' || state === 'gone')
        ? 'dismissed'
        : 'accepted'

  const firstId = items.map(annotationIdOf).find((id) => id !== null) ?? null

  return (
    <ProposalShell tone={tone}>
      <div ref={cardRef} className="flex flex-col gap-3" data-testid="canvas-activity-card">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <PilotiGlyph size="xs" />
          {live.connected && (
            // Live: changes on the canvas reach this card while it is on screen.
            <span
              aria-hidden
              data-testid="canvas-activity-live"
              className="bg-foreground/60 animate-caret-breathe size-1.5 shrink-0 rounded-full motion-reduce:animate-none"
            />
          )}
          <p className="card-title text-foreground min-w-0">
            {headline(t, counts)}
            <span className="text-muted-foreground font-normal">
              {' · '}
              <span className="break-all">{document.name}</span>
            </span>
          </p>
          {firstId && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={() => openAt(firstId)}
              data-testid="canvas-activity-show"
            >
              <MapPin aria-hidden className="size-3.5" />
              {t('cards.canvasActivity.show')}
            </Button>
          )}
        </div>

        <ul className="flex flex-col gap-3">
          {items.map((item, index) => {
            if (isSet(item)) {
              return (
                <SetRow
                  key={`${item.action}-${item.annotation_id}`}
                  documentId={document.id}
                  item={item}
                  live={live}
                  change={changeOf.get(index)}
                  changes={changes}
                  messageId={messageId}
                  cardKey={cardKey}
                  decisionsMustPersist={decisionsMustPersist}
                  thumbnail={item.page === 1 ? thumbnail : null}
                  aspect={aspect}
                  onAspect={setAspect}
                  onShow={openAt}
                />
              )
            }
            if (item.action === 'changed') {
              return (
                <ChangedRow
                  key={`c-${item.annotation_id}-${index}`}
                  documentId={document.id}
                  item={item}
                  index={index}
                  live={live}
                  change={changeOf.get(index)}
                  changes={changes}
                  messageId={messageId}
                  cardKey={cardKey}
                  decisionsMustPersist={decisionsMustPersist}
                  onShow={openAt}
                />
              )
            }
            if (item.action === 'deleted') {
              return (
                <DeletedRow
                  key={`d-${item.number}-${index}`}
                  item={item}
                  live={live}
                  change={changeOf.get(index)}
                  changes={changes}
                />
              )
            }
            return (
              <RepliedRow
                key={`r-${item.annotation_id}-${item.number}`}
                item={item}
                live={live}
                change={changeOf.get(index)}
                changes={changes}
                onShow={openAt}
              />
            )
          })}
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

/**
 * „2 Anmerkungen vorgeschlagen", „Im Thread von #4 geantwortet", or every act
 * the card holds in one line: „1 Anmerkung gesetzt, 2 Anmerkungen geändert".
 */
function headline(t: Translate, counts: ReturnType<typeof activityCounts>): string {
  const acts = (['created', 'proposed', 'changed', 'deleted'] as const)
    .filter((act) => counts[act] > 0)
    .map((act) => t(`cards.canvasActivity.headline.${act}`, { count: counts[act] }))
  if (acts.length > 0) {
    if (counts.replied > 0) acts.push(t('cards.canvasActivity.headline.repliedPart', { threads: counts.replied }))
    return acts.join(', ')
  }
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
 * Undo one change through the server's record, as the signed-in reader.
 *
 * The server compares the object with the `after` it recorded and refuses
 * what a colleague moved since: `moved-on` is a plain fact, said calmly and
 * never in error red; `already-undone` re-reads and the row shows who did it.
 */
function useServerUndo(change: PilotiChangeView | undefined, live: LiveMarks, changes: TurnChanges) {
  const t = useTranslations('chat')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const undo = async () => {
    if (!change || busy) return
    setBusy(true)
    setNotice(null)
    setError(null)
    try {
      const done = await undoChange(change.id)
      changes.adopt(done.change)
      // The mark moved back: the canvas's list is read again, not guessed.
      await live.refresh()
    } catch (failure) {
      if (failure instanceof ChangeRequestError && failure.status === 409 && failure.code === 'already-undone') {
        const fresh = await changes.refetch()
        if (!fresh?.some((row) => row.id === change.id && row.undoneAt !== null)) {
          setNotice(t('cards.canvasActivity.alreadyUndone'))
        }
      } else if (failure instanceof ChangeRequestError && failure.status === 409) {
        setNotice(t('cards.canvasActivity.movedOn'))
        await Promise.all([changes.refetch(), live.refresh()])
      } else if (failure instanceof ChangeRequestError && failure.status === 403) {
        setError(t('cards.canvasActivity.forbidden'))
      } else {
        setError(t('cards.canvasActivity.error'))
      }
    } finally {
      setBusy(false)
    }
  }

  return { undo, busy, notice, error }
}

/** „für Miriam": whom the turn acted for, in the meta line. */
function ForPerson({ change }: { change: PilotiChangeView | undefined }): JSX.Element | null {
  const t = useTranslations('chat')
  if (!change?.onBehalfOfName) return null
  return (
    <>
      <span aria-hidden>·</span>
      <span data-testid="canvas-activity-for">{t('cards.canvasActivity.forPerson', { name: change.onBehalfOfName })}</span>
    </>
  )
}

/** „Rückgängig gemacht · Anna": somebody took the change back. */
function UndoneLabel({ who }: { who: string | null }): JSX.Element {
  const t = useTranslations('chat')
  return (
    <span className="text-muted-foreground ml-auto inline-flex items-center gap-1" data-testid="canvas-activity-state">
      <Undo2 aria-hidden className="size-3" />
      {t('cards.canvasActivity.undone')}
      {who && <span>· {who}</span>}
    </span>
  )
}

function UndoButton({ number, busy, onClick }: { number: number; busy: boolean; onClick: () => void }): JSX.Element {
  const t = useTranslations('chat')
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={onClick}
      aria-label={t('cards.canvasActivity.undoLabel', { number })}
      aria-disabled={busy || undefined}
      aria-busy={busy || undefined}
      className="aria-disabled:cursor-default"
    >
      <StackedLabel busy={busy} idle={t('cards.canvasActivity.undo')} working={t('cards.canvasActivity.undoing')} />
    </Button>
  )
}

/** What an undo said: a calm fact (somebody moved it on) or an error, under the row. */
function UndoMessages({ notice, error }: { notice: string | null; error: string | null }): JSX.Element {
  return (
    <>
      {notice && (
        <p className="card-caption text-muted-foreground" role="status" data-testid="canvas-activity-notice">
          {notice}
        </p>
      )}
      {error && (
        <p className="card-caption text-destructive" role="alert">
          {error}
        </p>
      )}
    </>
  )
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
  item: CanvasSetItem
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

/**
 * One mark Piloti put on the page: where it is and what it says. A proposal
 * asks for the reader's answer; a mark set at the person's request is open
 * already, and reads like a person's mark.
 */
function SetRow({
  documentId,
  item,
  live,
  change,
  changes,
  messageId,
  cardKey,
  decisionsMustPersist,
  thumbnail,
  aspect,
  onAspect,
  onShow,
}: {
  documentId: string
  item: CanvasSetItem
  live: LiveMarks
  /** The server's record of this mark being set, when it has one. */
  change: PilotiChangeView | undefined
  changes: TurnChanges
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
  const serverUndo = useServerUndo(change, live, changes)
  const current = live.lookup(item.annotation_id)
  const proposal = isProposed(item)
  const undone = change?.undoneAt != null
  const state = undone ? 'gone' : proposal ? markState(decision, current) : createdState(current)
  const mayAnswer = state === 'proposed' && canDecide && (current === undefined || current === 'gone' || current.canEdit)
  // A proposal is answered with the two buttons; taking back a mark set on
  // request is the record's undo, offered while the record says it may be.
  const mayUndo = !proposal && change?.canUndo === true && !undone
  // A mark set at the person's request is open from birth: its label shows only once it moved on.
  const showState = proposal ? state !== 'proposed' : state !== 'open'

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
    <li className="flex gap-3" data-testid={`canvas-activity-${item.action}`} data-state={state}>
      <PageSilhouette item={item} state={state} thumbnail={thumbnail} aspect={aspect} onAspect={onAspect} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="card-meta text-muted-foreground flex flex-wrap items-center gap-x-1.5">
          <span className="text-foreground font-mono">#{item.number}</span>
          <span aria-hidden>·</span>
          <span>{kind}</span>
          <span aria-hidden>·</span>
          <span>{t('cards.canvasActivity.page', { page: item.page })}</span>
          <ForPerson change={change} />
          {undone ? (
            <UndoneLabel who={change?.undoneByName ?? null} />
          ) : (
            showState && <MarkStateLabel state={state} who={decision ? null : who} />
          )}
        </p>
        <p className="card-body text-foreground line-clamp-2" title={item.body}>
          {item.body}
        </p>
        {error && (
          <p className="card-caption text-destructive" role="alert">
            {error}
          </p>
        )}
        <UndoMessages notice={serverUndo.notice} error={serverUndo.error} />
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
          {mayUndo && <UndoButton number={item.number} busy={serverUndo.busy} onClick={() => void serverUndo.undo()} />}
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

/** „erledigt", „Anna zugewiesen", „Frist 20. Okt. 2026": one change, in the reader's words. */
function changePhrase(t: Translate, locale: string, change: CanvasFieldChange): string {
  const after = change.after ?? null
  switch (change.field) {
    case 'status':
      if (after === 'open') {
        return t(change.before === 'proposed' ? 'cards.canvasActivity.change.taken' : 'cards.canvasActivity.change.reopened')
      }
      return t(after === 'dismissed' ? 'cards.canvasActivity.change.dismissed' : 'cards.canvasActivity.change.resolved')
    case 'assignee':
      if (!after) return t('cards.canvasActivity.change.unassigned')
      return t('cards.canvasActivity.change.assigned', {
        name: change.after_label ?? t('cards.canvasActivity.change.someone'),
      })
    case 'due_on':
      return after
        ? t('cards.canvasActivity.change.due', { date: formatDayRange(after, after, locale) })
        : t('cards.canvasActivity.change.undue')
    case 'kind':
      return t('cards.canvasActivity.change.kind', {
        kind: after === 'hint' || after === 'question' || after === 'defect' ? t(`cards.canvasActivity.kinds.${after}`) : '',
      })
    default:
      return t('cards.canvasActivity.change.body')
  }
}

/**
 * One change Piloti made to a mark for the person, the note it left in the
 * thread, and the way back.
 *
 * With the server's record of the change (`change`) the row is a window onto
 * it: undone or not, by whom, and whether undo is offered all come from the
 * record, and the undo is the server's compare-and-swap (`useServerUndo`).
 *
 * Without one (an answer older than the record, or a request that failed) the
 * card's own copy still stands. Only then does the browser-side replay remain:
 * the inverse PATCH through the reader's own client, read-then-write and
 * guarded by the status Piloti left, with the decision stored per row. It goes
 * when the record covers every answer that can still be on screen.
 */
function ChangedRow({
  documentId,
  item,
  index,
  live,
  change,
  changes,
  messageId,
  cardKey,
  decisionsMustPersist,
  onShow,
}: {
  documentId: string
  item: CanvasChangedItem
  index: number
  live: LiveMarks
  change: PilotiChangeView | undefined
  changes: TurnChanges
  messageId?: string
  cardKey: string
  decisionsMustPersist?: boolean
  onShow: ShowInDocument
}): JSX.Element {
  const t = useTranslations('chat')
  const { locale } = useLocale()
  const { decision, decide, canDecide } = useCardDecision(
    messageId,
    itemDecisionKey(cardKey, `${item.annotation_id}@${index}`),
    { mustPersist: decisionsMustPersist }
  )
  const [replayBusy, setReplayBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const serverUndo = useServerUndo(change, live, changes)
  const current = live.lookup(item.annotation_id)
  const inverse = undoRequest(item)
  const undone = change ? change.undoneAt !== null : decision === 'rejected'
  // Moved on since Piloti's change (by a colleague, or by the reader on the
  // canvas): the row says where the mark stands and offers no undo.
  const moved =
    !undone &&
    current !== undefined &&
    current !== 'gone' &&
    (change ? !change.canUndo && !standsAsChanged(change, current) : !stillAsLeft(item, current))
  const mayUndo = change
    ? change.canUndo && !undone && current !== 'gone'
    : inverse !== null && canDecide && !undone && !moved && current !== 'gone' && (current === undefined || current.canEdit)
  const busy = change ? serverUndo.busy : replayBusy

  const replayUndo = async () => {
    if (replayBusy || inverse === null) return
    setReplayBusy(true)
    setError(null)
    try {
      // Read first: the status guard alone would let an undo overwrite a
      // colleague's later assignee, date or wording.
      const now = (await live.refresh())?.(item.annotation_id)
      if (now === 'gone' || (now && !stillAsLeft(item, now))) return
      const updated = await updateAnnotation(documentId, item.annotation_id, inverse)
      live.adopt(updated)
      decide('rejected')
    } catch (failure) {
      if (failure instanceof AnnotationRequestError && failure.status === 409) {
        await live.refresh()
      } else if (failure instanceof AnnotationRequestError && failure.status === 404) {
        live.forget(item.annotation_id)
      } else if (failure instanceof AnnotationRequestError && failure.status === 403) {
        setError(t('cards.canvasActivity.forbidden'))
      } else {
        setError(t('cards.canvasActivity.error'))
      }
    } finally {
      setReplayBusy(false)
    }
  }

  const phrases = item.changes.map((entry) => changePhrase(t, locale, entry)).join(' · ')
  const state: MarkState | null = current === 'gone' ? 'gone' : moved && current ? current.status : null

  return (
    <li className="flex gap-3" data-testid="canvas-activity-changed" data-undone={undone || undefined}>
      <span className="flex w-20 shrink-0 justify-center pt-1" aria-hidden>
        <CommentPin as="span" number={item.number} done={undone || current === 'gone'} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="card-meta text-muted-foreground flex flex-wrap items-center gap-x-1.5">
          <span className="text-foreground font-mono">#{item.number}</span>
          <span className="text-foreground">{phrases}</span>
          <ForPerson change={change} />
          {undone && <UndoneLabel who={change?.undoneByName ?? null} />}
          {!undone && state && (
            <span className="text-muted-foreground ml-auto" data-testid="canvas-activity-state">
              {state === 'gone'
                ? t('cards.canvasActivity.state.gone')
                : t('cards.canvasActivity.movedSince', { state: t(`cards.canvasActivity.status.${state}`) })}
            </span>
          )}
        </p>
        <p className="card-body text-foreground line-clamp-2" title={item.note}>
          „{item.note}“
        </p>
        {error && (
          <p className="card-caption text-destructive" role="alert">
            {error}
          </p>
        )}
        <UndoMessages notice={serverUndo.notice} error={serverUndo.error} />
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {mayUndo && (
            <UndoButton
              number={item.number}
              busy={busy}
              onClick={() => void (change ? serverUndo.undo() : replayUndo())}
            />
          )}
          {current !== 'gone' && (
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

/**
 * A mark Piloti deleted for the person who set it: gone with its thread, so
 * nothing to open. The record may still offer to bring it back.
 */
function DeletedRow({
  item,
  live,
  change,
  changes,
}: {
  item: CanvasDeletedItem
  live: LiveMarks
  change: PilotiChangeView | undefined
  changes: TurnChanges
}): JSX.Element {
  const t = useTranslations('chat')
  const serverUndo = useServerUndo(change, live, changes)
  const undone = change?.undoneAt != null
  return (
    <li className="flex gap-3" data-testid="canvas-activity-deleted" data-undone={undone || undefined}>
      <span className="flex w-20 shrink-0 justify-center pt-1" aria-hidden>
        <CommentPin as="span" number={item.number} done={!undone} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="card-meta text-muted-foreground flex flex-wrap items-center gap-x-1.5">
          <span>{t('cards.canvasActivity.deleted', { number: item.number })}</span>
          <ForPerson change={change} />
          {undone && <UndoneLabel who={change?.undoneByName ?? null} />}
        </p>
        <p className={cn('card-body line-clamp-2', undone ? 'text-foreground' : 'text-muted-foreground line-through')} title={item.body}>
          {item.body}
        </p>
        <UndoMessages notice={serverUndo.notice} error={serverUndo.error} />
        {change?.canUndo && !undone && (
          <div className="pt-1">
            <UndoButton number={item.number} busy={serverUndo.busy} onClick={() => void serverUndo.undo()} />
          </div>
        )}
      </div>
    </li>
  )
}

/** One answer Piloti posted into a mark's thread. */
function RepliedRow({
  item,
  live,
  change,
  changes,
  onShow,
}: {
  item: CanvasRepliedItem
  live: LiveMarks
  change: PilotiChangeView | undefined
  changes: TurnChanges
  onShow: ShowInDocument
}): JSX.Element {
  const t = useTranslations('chat')
  const serverUndo = useServerUndo(change, live, changes)
  const undone = change?.undoneAt != null
  return (
    <li className="flex gap-3" data-testid="canvas-activity-replied" data-undone={undone || undefined}>
      <span className="flex w-20 shrink-0 justify-center pt-1" aria-hidden>
        <CommentPin as="span" number={item.number} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="card-meta text-muted-foreground flex flex-wrap items-center gap-x-1.5">
          <span>{t('cards.canvasActivity.repliedIn', { number: item.number })}</span>
          <ForPerson change={change} />
          {undone && <UndoneLabel who={change?.undoneByName ?? null} />}
        </p>
        <p
          className={cn('card-body line-clamp-2', undone ? 'text-muted-foreground line-through' : 'text-foreground')}
          title={item.excerpt}
        >
          „{item.excerpt}“
        </p>
        <UndoMessages notice={serverUndo.notice} error={serverUndo.error} />
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {change?.canUndo && !undone && (
            <UndoButton number={item.number} busy={serverUndo.busy} onClick={() => void serverUndo.undo()} />
          )}
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
