'use client'

import { forwardRef, useId, useRef, useState, type JSX } from 'react'
import NextLink from 'next/link'
import {
  CalendarClock,
  Check,
  CircleHelp,
  History,
  Link2,
  MessageSquareText,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  Scale,
  Sparkles,
  Trash2,
  TriangleAlert,
  Undo2,
  UserRound,
  X,
} from 'lucide-react'
import { ActionMenu, type ActionMenuEntry } from '@/components/ui/action-menu'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { AgentGlyph } from '@/components/ui/agent-glyph'
import { ShimmerText } from '@/components/ui/shimmer-text'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { FieldError } from '@/components/ui/field'
import { Kbd } from '@/components/ui/kbd'
import { PersonAvatar } from '@/components/ui/avatar-stack'
import { TimeAgo } from '@/components/ui/time-ago'
import { useLocale, useTranslations } from '@/i18n'
import { chatCopy } from '@/i18n/namespaces/chat'
import { filesCopy } from '@/i18n/namespaces/files'
import { formatDayRange, localCalendarDay } from '@/lib/format'
import { AnnotationRequestError } from '@/lib/annotations/client'
import {
  ANNOTATION_KINDS,
  hasBox,
  isGhostMark,
  isLive,
  agentRepliedSince,
  REPLY_TAKEN_UP_REASON,
  replyIsForAgent,
  type AnnotationKind,
  type AnnotationReplyView,
  type AnnotationView,
  type MarkMention,
  type AgentWakeTrigger,
} from '@/lib/annotations/types'
import { wakeTurnId } from '@/lib/annotations/wake-ids'
import { cn } from '@/lib/utils'
import { liveLine } from '@/features/chat/lib/turn-events'
import type { FileAssignee } from '../../file-types'
import { askRegionOf, stepsOf, type CanvasAsk } from '../../hooks/use-canvas-ask'
import { answerAsBody } from '../../lib/agent-answer-text'
import type { DocumentReview, ReviewDraft } from '../../hooks/use-document-review'
import { useFollowEnd } from '../../hooks/use-follow-end'
import { AssignPopover } from '../assign-popover'
import { Composer, type ComposerSend } from './composer'
import { otherReviewHref } from '../../lib/revision-links'
import { MarkBody } from './mark-body'
import { ReplyProvenance } from './reply-provenance'
import { useAgentByline } from './agent-attribution'
import type { CardSide } from './review-page-layer'
import { useFocusBackOnClose } from './focus-return'
import { useCardFit } from './review-stage'

export const KIND_ICONS: Record<AnnotationKind, typeof TriangleAlert> = {
  hint: MessageSquareText,
  question: CircleHelp,
  defect: TriangleAlert,
}

const day = (value: string, locale: string) => formatDayRange(value, value, locale)

/** One message in a thread: who, when, what. Piloti speaks with its glyph, never a person's face. */
function Message({
  authorKind,
  name,
  userId,
  at,
  body,
  mentions,
  viewerId,
  proposal,
  woken,
  editedAt,
  actions,
}: {
  authorKind: 'person' | 'piloti'
  name: string | null
  userId: string
  at: string
  body: string
  /** Whom it mentions, drawn as the chat's chips. */
  mentions?: readonly MarkMention[]
  /** The reader, so a mention of them stands out. */
  viewerId: string | null
  /** Piloti's finding nobody has taken over: it says so in its byline. */
  proposal?: boolean
  /** The reply was written by a turn an event woke, and where (`number` of the Anmerkung). */
  woken?: { trigger: AgentWakeTrigger; number: number } | null
  /** Its author reworded it then: the byline says „bearbeitet“. */
  editedAt?: string | null
  /** What its author may do with it (`ReplyActions`), at the end of the byline. */
  actions?: React.ReactNode
}): JSX.Element {
  const t = useTranslations(filesCopy)
  const { locale } = useLocale()
  const byline = useAgentByline()
  const wokenTitle = woken
    ? name
      ? t('review.attribution.wokenTitle', { name, number: woken.number })
      : t('review.attribution.wokenTitleNameless', { number: woken.number })
    : undefined
  return (
    <div className="flex gap-2.5">
      {authorKind === 'piloti' ? (
        <AgentGlyph />
      ) : (
        <PersonAvatar
          size="sm"
          className="size-6 text-[10px]"
          person={{ userId, name: name ?? t('review.someone'), profilePictureUrl: null }}
        />
      )}
      <div className="min-w-0 flex-1">
        {/* The name gives way, the time never wraps: „2 hours ago" on two lines reads as two facts. */}
        <p className="flex min-w-0 items-baseline gap-1.5 text-xs">
          <span
            className="text-foreground min-w-0 truncate font-semibold"
            data-testid={authorKind === 'piloti' ? 'thread-byline' : undefined}
            title={authorKind === 'piloti' ? byline(name, { proposal }) : (name ?? undefined)}
          >
            {authorKind === 'piloti' ? byline(name, { proposal }) : (name ?? t('review.someone'))}
          </span>
          <TimeAgo date={at} locale={locale} className="text-muted-foreground shrink-0 whitespace-nowrap" />
          {editedAt && (
            <span
              className="text-muted-foreground shrink-0 whitespace-nowrap"
              title={new Date(editedAt).toLocaleString(locale)}
              data-testid="thread-edited"
            >
              · {t('review.edited')}
            </span>
          )}
          {actions && <span className="-my-1 ml-auto shrink-0">{actions}</span>}
        </p>
        {woken && (
          <p className="text-muted-foreground text-[11px] leading-4" title={wokenTitle} data-testid="thread-woken">
            {t(`review.attribution.woken.${woken.trigger}`)}
          </p>
        )}
        <p className="text-foreground mt-0.5 text-[13px] leading-5 break-words whitespace-pre-wrap">
          <MarkBody text={body} mentions={mentions} viewerId={viewerId} />
        </p>
      </div>
    </div>
  )
}

/**
 * A chip for who is on it and by when: quiet (dashed, muted) until set, then
 * the fact itself in ink on a solid edge. `onClear` puts the way to unset it
 * INSIDE the chip, so the × reads as part of the fact it removes.
 */
const MetaChip = forwardRef<
  HTMLButtonElement,
  {
    icon: typeof UserRound
    tone?: 'urgent'
    set?: boolean
    onClear?: () => void
    clearLabel?: string
    children: React.ReactNode
  } & React.ComponentProps<'button'>
>(function MetaChip({ icon: Icon, children, tone, set, onClear, clearLabel, ...props }, ref) {
  return (
    <span
      data-set={set || undefined}
      className={cn(
        'border-border/80 text-muted-foreground inline-flex h-6 max-w-full items-center rounded-full border text-[11px] font-medium transition-colors duration-quick ease-out',
        !set && 'border-dashed',
        set && 'bg-secondary text-foreground border-transparent',
        // Overdue is ink and weight, not gold: gold is the Büroablage's colour.
        tone === 'urgent' && 'text-foreground border-foreground/50 border-solid font-semibold'
      )}
    >
      <button
        ref={ref}
        type="button"
        className={cn(
          'hover:text-foreground inline-flex h-full min-w-0 items-center gap-1 rounded-full pl-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none',
          onClear ? 'pr-1' : 'pr-2'
        )}
        {...props}
      >
        <Icon className="size-3 shrink-0" aria-hidden />
        <span className="truncate">{children}</span>
      </button>
      {onClear && (
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground mr-1 inline-flex size-4 shrink-0 items-center justify-center rounded-full outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60"
          aria-label={clearLabel}
          onClick={onClear}
        >
          <X className="size-3" aria-hidden />
        </button>
      )}
    </span>
  )
})

/** The reader as the Zuständige picker offers them („Mir zuweisen"), or null while nobody knows who reads. */
function useSelfAssignee(review: DocumentReview): FileAssignee | null {
  const t = useTranslations(filesCopy)
  if (!review.me) return null
  const name = review.room.self?.userId === review.me ? review.room.self.name : null
  return { userId: review.me, name: name || t('review.assigneeYou'), email: null, profilePictureUrl: null }
}

/**
 * Who is on it and by when, editable while the reader may write. The
 * Zuständige is picked among who may write the document (`access="write"`),
 * since they must answer and close the mark; the reader may pick themselves.
 */
function ResponsibilityRow({
  documentId,
  assigneeUserId,
  assigneeName,
  dueOn,
  editable,
  canPickAssignee,
  self,
  onAssignee,
  onDueOn,
}: {
  documentId: string
  assigneeUserId: string | null
  assigneeName: string | null
  dueOn: string | null
  editable: boolean
  canPickAssignee: boolean
  self: FileAssignee | null
  onAssignee: (person: FileAssignee | null) => void
  onDueOn: (day: string | null) => void
}): JSX.Element | null {
  const t = useTranslations(filesCopy)
  const { locale } = useLocale()
  const dateRef = useRef<HTMLInputElement | null>(null)
  const overdue = dueOn !== null && dueOn < localCalendarDay()
  if (!editable && !assigneeName && !dueOn) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {canPickAssignee && editable ? (
        <AssignPopover
          documentId={documentId}
          assignees={assigneeUserId ? [{ userId: assigneeUserId, name: assigneeName, email: null, profilePictureUrl: null }] : []}
          pickOnly
          access="write"
          self={self}
          onPick={onAssignee}
          onChanged={() => undefined}
          trigger={
            <MetaChip
              icon={UserRound}
              data-testid="thread-assignee"
              set={Boolean(assigneeName)}
              onClear={assigneeName ? () => onAssignee(null) : undefined}
              clearLabel={t('review.unassign')}
            >
              {assigneeName ?? t('review.assign')}
            </MetaChip>
          }
        />
      ) : (
        assigneeName && (
          <MetaChip
            icon={UserRound}
            disabled={!editable}
            set
            onClear={editable ? () => onAssignee(null) : undefined}
            clearLabel={t('review.unassign')}
          >
            {assigneeName}
          </MetaChip>
        )
      )}
      <span className="relative inline-flex">
        <MetaChip
          icon={CalendarClock}
          data-testid="thread-due"
          set={dueOn !== null}
          tone={overdue ? 'urgent' : undefined}
          disabled={!editable}
          onClick={() => dateRef.current?.showPicker?.()}
          onClear={editable && dueOn ? () => onDueOn(null) : undefined}
          clearLabel={t('review.clearDue')}
        >
          {dueOn ? `${t('review.due')} ${day(dueOn, locale)}${overdue ? ` · ${t('review.overdue')}` : ''}` : t('review.setDue')}
        </MetaChip>
        {editable && (
          <input
            ref={dateRef}
            type="date"
            aria-label={t('review.due')}
            value={dueOn ?? ''}
            onChange={(event) => onDueOn(event.target.value || null)}
            className="pointer-events-none absolute inset-0 opacity-0"
            tabIndex={-1}
          />
        )}
      </span>
    </div>
  )
}

/**
 * The three kinds as one quiet segmented row: three buttons, the one in force
 * pressed, each reached by Tab (a radio group would owe arrow keys).
 */
function KindPicker({ value, onChange }: { value: AnnotationKind; onChange: (kind: AnnotationKind) => void }) {
  const t = useTranslations(filesCopy)
  return (
    <div role="group" aria-label={t('annotations.kind')} className="bg-muted inline-flex rounded-control p-0.5">
      {ANNOTATION_KINDS.map((kind) => {
        const Icon = KIND_ICONS[kind]
        const on = kind === value
        return (
          <button
            key={kind}
            type="button"
            aria-pressed={on}
            data-testid={`thread-kind-${kind}`}
            onClick={() => onChange(kind)}
            className={cn(
              'inline-flex h-6 items-center gap-1 rounded-[5px] px-2 text-[11px] font-medium transition-colors duration-quick ease-out',
              on ? 'bg-card text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <Icon className="size-3" aria-hidden />
            {t(`annotations.kinds.${kind}`)}
          </button>
        )
      })}
    </div>
  )
}

/**
 * Where a card is shown: beside or under its mark on the sheet
 * ({@link CardSide}, decided by `placeCard`), `detached` from the sheet (a
 * mark of an earlier Fassung, which is not drawn), or `docked` in the phone's
 * bottom sheet, which is its frame.
 */
export type CardPlacement = CardSide | 'detached' | 'docked'

// Beside its mark a card moves up by `--card-shift` to keep out of the stage's foot (`useCardFit`).
const PLACEMENT_CLASSES: Record<Exclude<CardPlacement, 'docked'>, string> = {
  right: 'absolute top-[calc(var(--card-shift,0px)*-1)] left-4 origin-top-left',
  left: 'absolute top-[calc(var(--card-shift,0px)*-1)] right-4 origin-top-right',
  below: 'absolute top-3 left-0 origin-top-left',
  detached: 'relative origin-top',
}

/** The hairline from the mark's edge to its card: which mark this is about, without the card sitting on it. */
const HAIRLINE_CLASSES: Partial<Record<CardPlacement, string>> = {
  right: 'top-[calc(0.875rem+var(--card-shift,0px))] -left-4 h-px w-4',
  left: 'top-[calc(0.875rem+var(--card-shift,0px))] -right-4 h-px w-4',
  below: '-top-3 left-3.5 h-3 w-px',
}

/**
 * The card's frame: a floating sheet beside its mark, on the side with room; or
 * the content of the phone's sheet. A dialog named by its own header
 * (`labelledBy`, the id of the line that says what it is about) or, where it
 * has none, by `label`. `data-review-card` is how the review finds it, and it
 * takes the focus itself (`tabIndex={-1}`) when the keyboard opened it.
 *
 * On the sheet it keeps inside the review's free stage (`useCardFit`): never
 * under the toolbars or the chips at the canvas's foot. A column, so what has
 * to give is the part that scrolls (the thread), never the reply field.
 */
export function ReviewCard({
  placement,
  children,
  testId,
  labelledBy,
  label,
}: {
  placement: CardPlacement
  children: React.ReactNode
  testId: string
  labelledBy?: string
  label?: string
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  useCardFit(ref, placement === 'docked' ? null : placement)
  if (placement === 'docked') {
    return (
      <div
        data-testid={testId}
        data-placement="docked"
        data-review-card
        tabIndex={-1}
        className="text-popover-foreground w-full outline-none"
      >
        {children}
      </div>
    )
  }
  const hairline = HAIRLINE_CLASSES[placement]
  return (
    <div
      ref={ref}
      data-testid={testId}
      data-placement={placement}
      data-review-card
      role="dialog"
      tabIndex={-1}
      aria-labelledby={labelledBy}
      aria-label={labelledBy ? undefined : label}
      className={cn(
        'focus-visible:ring-ring/60 outline-none focus-visible:ring-2',
        'bg-popover text-popover-foreground border-border/70 animate-in fade-in-0 zoom-in-95 duration-base ease-entrance motion-reduce:animate-none w-[20rem] rounded-overlay border shadow-xl',
        'flex max-h-(--card-max-height) flex-col',
        PLACEMENT_CLASSES[placement]
      )}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {hairline && <span aria-hidden className={cn('bg-foreground/40 absolute', hairline)} />}
      {children}
    </div>
  )
}

/**
 * Piloti, brought into a thread by a question this tab asked it itself (the
 * organization lets no events wake it): answering, or not able to, with a way
 * to ask again. An answer whose thread target never reached the server stays
 * here, to be added to the thread by hand.
 */
function AgentThreadRow({ ask, review }: { ask: CanvasAsk; review: DocumentReview }): JSX.Element {
  const t = useTranslations(filesCopy)
  const tChat = useTranslations(chatCopy)
  const [adopting, setAdopting] = useState(false)
  const [adoptFailed, setAdoptFailed] = useState(false)
  const line = liveLine(stepsOf(ask.view), tChat) ?? t('review.piloti.replying')
  const close = (
    <button
      type="button"
      className="text-muted-foreground hover:text-foreground ml-auto shrink-0 self-start rounded p-0.5"
      aria-label={t('review.piloti.close')}
      onClick={() => review.piloti.dismiss(ask.id)}
    >
      <X className="size-3" aria-hidden />
    </button>
  )
  if (ask.status === 'answered' && ask.annotationId && ask.view?.text) {
    const annotationId = ask.annotationId
    const body = answerAsBody(ask.view.text)
    return (
      <div className="flex gap-2.5" data-testid="thread-agent-unposted" role="status">
        <AgentGlyph />
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="text-muted-foreground text-[11px] leading-4">{t('review.piloti.degradedThread')}</p>
          <p className="text-foreground text-sm leading-5 break-words whitespace-pre-line">{body}</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            disabled={adopting}
            onClick={async () => {
              setAdopting(true)
              setAdoptFailed(false)
              try {
                await review.reply(annotationId, body)
                review.piloti.dismiss(ask.id)
              } catch {
                // A full thread, a conflict or the network: the answer stays here to add again.
                setAdoptFailed(true)
              } finally {
                setAdopting(false)
              }
            }}
          >
            {t('review.piloti.adoptReply')}
          </Button>
          {adoptFailed && <FieldError>{t('review.actionFailed')}</FieldError>}
        </div>
        {close}
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2.5" data-testid="thread-agent-pending" role="status">
      <AgentGlyph working={ask.status === 'thinking'} />
      {ask.status === 'thinking' ? (
        <ShimmerText className="min-w-0 flex-1 text-xs">{line}</ShimmerText>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-2 text-xs">
          <span className="text-muted-foreground">{t('review.piloti.replyFailed')}</span>
          <Button type="button" variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => review.piloti.retry(ask.id)}>
            {t('review.piloti.retry')}
          </Button>
          {close}
        </span>
      )}
    </div>
  )
}

/**
 * Piloti at work in this thread as the SERVER knows it (`pilotiWork`, read off
 * the mark's wake): the same line for everyone in the room, after a reload too.
 * A delegation already says „Piloti arbeitet daran" in its chip, so only how it
 * ended is said here.
 */
function AgentWorkRow({ annotation }: { annotation: AnnotationView }): JSX.Element | null {
  const t = useTranslations(filesCopy)
  const work = annotation.pilotiWork
  if (!work) return null
  const delegated = work.trigger === 'assigned'
  if (delegated && (work.state === 'queued' || work.state === 'working')) return null
  const name = work.forName ?? t('review.someone')
  if (work.state === 'failed') {
    return (
      <div className="flex items-start gap-2.5" data-testid="thread-agent-work" data-state={work.state} role="status">
        <AgentGlyph />
        <span className="text-muted-foreground min-w-0 flex-1 text-xs leading-5">
          {t(`review.piloti.workFailed.${work.reasonKind ?? 'error'}`, { name })}
        </span>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2.5" data-testid="thread-agent-work" data-state={work.state} role="status">
      <AgentGlyph working={work.state !== 'held'} />
      {work.state === 'held' ? (
        <span className="text-muted-foreground min-w-0 flex-1 text-xs">{t('review.piloti.wakeHeld')}</span>
      ) : (
        <ShimmerText className="min-w-0 flex-1 text-xs">
          {t(work.state === 'queued' ? 'review.piloti.workQueued' : 'review.piloti.replyingFor', { name })}
        </ShimmerText>
      )}
    </div>
  )
}

/** Setting a new mark: what kind, what is there, optionally who and by when. */
export function DraftCard({
  review,
  draft,
  placement,
  canPickAssignee,
}: {
  review: DocumentReview
  draft: ReviewDraft
  placement: CardPlacement
  canPickAssignee: boolean
}): JSX.Element {
  const t = useTranslations(filesCopy)
  const [kind, setKind] = useState<AnnotationKind>('hint')
  const [assignee, setAssignee] = useState<FileAssignee | null>(null)
  const [dueOn, setDueOn] = useState<string | null>(null)
  const self = useSelfAssignee(review)
  const { piloti } = review
  /** The draft's place handed to Piloti: asked at once with what was typed, or a card waiting for the question. Not on a model: its box is a placeholder. */
  const askAgent = piloti.available && !draft.viewpoint
    ? (body: string) => {
        const region = askRegionOf(draft)
        if (body) piloti.ask({ text: body, region })
        else piloti.compose(region)
      }
    : undefined
  return (
    <ReviewCard placement={placement} testId="review-draft" label={t('review.draftCard')}>
      <div className="space-y-3 p-3">
        <KindPicker value={kind} onChange={setKind} />
        <Composer
          autoFocus
          testId="review-draft-body"
          placeholder={t('review.draftPlaceholder')}
          submitLabel={t('review.set')}
          onEscape={() => review.setDraft(null)}
          onAskAgent={askAgent}
          documentId={review.documentId}
          onSubmit={async (body, { mentions }) => {
            const created = await review.create({ kind, body, mentions, assigneeUserId: assignee?.userId ?? null, dueOn })
            return created?.mentions
          }}
        />
        <ResponsibilityRow
          documentId={review.documentId}
          assigneeUserId={assignee?.userId ?? null}
          assigneeName={assignee ? assignee.name || assignee.email || assignee.userId : null}
          dueOn={dueOn}
          editable
          canPickAssignee={canPickAssignee}
          self={self}
          onAssignee={setAssignee}
          onDueOn={setDueOn}
        />
      </div>
    </ReviewCard>
  )
}

/**
 * Where the mark stands among the document's Fassungen, as the card's first
 * lines (the card is all the reader looks at): set on an earlier Fassung (listed,
 * not drawn), or on a document another one replaced, each with „Auf aktuelle
 * Fassung übernehmen" where the server says this reader's carry goes through
 * (`carryTarget`), named by the document it lands on: the end of the chain of
 * replacements, not the direct successor the notice names (on a model: `ModelMarkCarry`);
 * and where a carried mark came from or went on to, linked where the page can open that document.
 */
function RevisionLines({
  review,
  annotation,
  busy,
  onCarry,
}: {
  review: DocumentReview
  annotation: AnnotationView
  busy: boolean
  onCarry: () => void
}): JSX.Element | null {
  const t = useTranslations(filesCopy)
  const replacedBy = review.revision?.replacedBy ?? null
  const target = annotation.carryTarget ?? null
  const earlier = !annotation.onCurrentRevision
  const where = typeof window === 'undefined' ? null : window.location
  const linkTo = (link: { documentId: string; annotationId: string }) =>
    where ? otherReviewHref(where, review.documentId, link) : null
  const lines: JSX.Element[] = []
  if (annotation.anchor !== 'viewpoint' && (earlier || (replacedBy && target))) {
    lines.push(
      <div key="revision" className="flex flex-col gap-1.5" data-testid="thread-earlier">
        <p className="flex items-start gap-1.5">
          <History className="mt-px size-3 shrink-0" aria-hidden />
          {earlier
            ? annotation.revisionNumber
              ? // An open one is drawn as a ghost where it stood; a closed one is not drawn.
                t(isGhostMark(annotation, review.documentId) ? 'review.earlierRevisionGhost' : 'review.earlierRevision', {
                  number: annotation.revisionNumber,
                })
              : t('annotations.earlierRevisionUnnumbered')
            : t('review.replacedNotice', { name: replacedBy?.filename ?? '' })}
        </p>
        {target && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 self-start text-xs"
            disabled={busy}
            data-testid="thread-carry"
            onClick={onCarry}
          >
            {target.documentId === annotation.documentId
              ? t('review.carry')
              : t('review.carryTo', { name: target.documentName })}
          </Button>
        )}
      </div>
    )
  }
  for (const [key, link, words] of [
    ['from', annotation.carriedFrom, 'review.carriedFrom'],
    ['to', annotation.carriedTo, 'review.carriedTo'],
  ] as const) {
    if (!link) continue
    const text = t(words, { name: link.documentName, number: link.number })
    const href = linkTo(link)
    lines.push(
      <p key={key} className="flex items-start gap-1.5" data-testid={`thread-carried-${key}`}>
        <Link2 className="mt-px size-3 shrink-0" aria-hidden />
        {href ? (
          // Replaces, as walking the marks does: closing the review it opens then steps back out in one go.
          <NextLink href={href} replace className="hover:text-foreground underline underline-offset-2">
            {text}
          </NextLink>
        ) : (
          text
        )}
      </p>
    )
  }
  if (lines.length === 0) return null
  return (
    <div className="text-muted-foreground bg-muted/40 space-y-1 border-b px-3 py-1.5 text-[11px] leading-4">{lines}</div>
  )
}

/**
 * Whether Piloti took this reply up, as far as the card can tell: it was for
 * Piloti, and Piloti answered after it, works for its author now, or this tab
 * is asking it in the thread (`asking`: wakes off, so the browser asked, and
 * only Piloti's answer would tell the server). The server decides with the
 * reply's own wake (`editReply`) and lets a change through in the moment
 * before a browser ask's answer lands; the card keeps the author from
 * changing what Piloti is reading.
 */
function takenUpByAgent(annotation: AnnotationView, reply: AnnotationReplyView, asking: boolean): boolean {
  if (!replyIsForAgent(annotation, reply)) return false
  if (asking || agentRepliedSince(annotation.replies, reply)) return true
  const work = annotation.pilotiWork
  return Boolean(
    work && (work.state === 'queued' || work.state === 'working') && work.trigger !== 'assigned' && work.forUserId === reply.createdBy
  )
}

/** Whether this tab's own ask of Piloti, answering in this mark's thread, is still thinking. */
const agentAskingIn = (review: DocumentReview, annotationId: string): boolean =>
  review.piloti.asks.some((ask) => ask.replyInThread && ask.annotationId === annotationId && ask.status === 'thinking')

/**
 * One reply in the thread. Its author may reword it („Bearbeiten“: the
 * composer in its place, with its words and whom it mentions, as a mark is
 * reworded) or delete it (confirmed, as a mark is), while the mark is live
 * and Piloti has not taken it up. An edit never wakes Piloti, so the composer
 * offers no @Piloti and says so where Piloti could be asked.
 */
function ReplyEntry({
  review,
  annotation,
  reply,
}: {
  review: DocumentReview
  annotation: AnnotationView
  reply: AnnotationReplyView
}): JSX.Element {
  const t = useTranslations(filesCopy)
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const mayChange =
    annotation.canEdit &&
    isLive(annotation) &&
    reply.authorKind === 'person' &&
    reply.createdBy === review.me &&
    !takenUpByAgent(annotation, reply, agentAskingIn(review, annotation.id))
  // Saved or let go, the box goes and the reply's ⋯ comes back: the focus goes with it.
  const moreRef = useFocusBackOnClose<HTMLButtonElement>(editing && mayChange)
  const failureOf = (error: unknown) =>
    error instanceof AnnotationRequestError && error.reason === REPLY_TAKEN_UP_REASON ? t('review.replyTakenUp') : null

  const save = async (body: string, { mentions }: ComposerSend) => {
    const after = await review.editReply(annotation.id, reply.id, body, mentions)
    setEditing(false)
    return after.replies.find((candidate) => candidate.id === reply.id)?.mentions
  }

  const remove = async () => {
    setFailed(null)
    try {
      await review.removeReply(annotation.id, reply.id)
    } catch (error) {
      setFailed(failureOf(error) ?? t('review.actionFailed'))
    }
  }

  if (editing && mayChange) {
    return (
      <div className="space-y-1.5" data-testid="thread-reply-edit">
        <Composer
          autoFocus
          testId="thread-reply-edit-body"
          placeholder={t('review.replyEditLabel')}
          submitLabel={t('review.save')}
          documentId={review.documentId}
          initialBody={reply.body}
          initialMentions={reply.mentions}
          // A rewording is saved, not sent: its failure says so.
          describeFailure={(error) => failureOf(error) ?? t('review.saveFailed')}
          onSubmit={save}
          onEscape={() => setEditing(false)}
        />
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setEditing(false)}>
            {t('review.editCancel')}
          </Button>
          {(review.piloti.available || review.pilotiWakes) && (
            <p className="text-muted-foreground text-[11px] leading-4">{t('review.replyEditNoWake')}</p>
          )}
        </div>
      </div>
    )
  }

  const actions: ActionMenuEntry[] = [
    { type: 'item', id: 'edit', label: t('review.edit'), icon: Pencil, onSelect: () => setEditing(true) },
    {
      type: 'item',
      id: 'delete',
      label: t('review.delete'),
      icon: Trash2,
      variant: 'destructive',
      onSelect: () => setConfirmDelete(true),
    },
  ]
  return (
    <div data-testid="thread-reply-entry">
      <Message
        authorKind={reply.authorKind}
        name={reply.createdByName}
        userId={reply.createdBy}
        at={reply.createdAt}
        body={reply.body}
        mentions={reply.mentions}
        viewerId={review.me}
        woken={reply.wokenBy ? { trigger: reply.wokenBy, number: annotation.number } : null}
        editedAt={reply.editedAt}
        actions={
          mayChange ? (
            <ActionMenu
              mode="dropdown"
              entries={actions}
              trigger={
                <Button
                  ref={moreRef}
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-6 [&_svg]:size-3.5"
                  aria-label={t('review.replyMore')}
                  data-testid="thread-reply-more"
                >
                  <MoreHorizontal aria-hidden />
                </Button>
              }
            />
          ) : null
        }
      />
      <ReplyProvenance imported={reply.imported} />
      {failed && <FieldError className="mt-1 ml-8.5">{failed}</FieldError>}
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t('review.replyDeleteConfirm')}
        description={t('review.replyDeleteHint')}
        confirmLabel={t('review.delete')}
        cancelLabel={t('annotations.cancel')}
        onConfirm={remove}
      />
    </div>
  )
}

/** One mark's thread: the finding, the conversation, the decision, and who is on it. */
export function ThreadCard({
  review,
  annotation,
  placement,
  canPickAssignee,
  onCopyLink,
  walk,
}: {
  review: DocumentReview
  annotation: AnnotationView
  placement: CardPlacement
  canPickAssignee: boolean
  onCopyLink?: (annotation: AnnotationView) => void
  /** Going through Piloti's proposals: where this one stands among them, and the way to the next. */
  walk?: { index: number; total: number; onNext: () => void } | null
}): JSX.Element {
  const t = useTranslations(filesCopy)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  /** The author rewording their own mark: the composer in the mark's place, with its text and whom it mentions. */
  const [editing, setEditing] = useState(false)
  const self = useSelfAssignee(review)
  const headerId = useId()
  const KindIcon = KIND_ICONS[annotation.kind]
  const proposed = annotation.status === 'proposed'
  const live = isLive(annotation)
  const { piloti } = review
  const agentReplies = annotation.replies.filter((reply) => reply.authorKind === 'piloti').length
  // Piloti was brought into this thread by this tab and has not answered in it yet,
  // or answered without the thread target reaching it (its answer is only here).
  const threadAsk = piloti.asks.find(
    (ask) =>
      ask.replyInThread &&
      ask.annotationId === annotation.id &&
      (ask.status === 'failed' ||
        ask.status === 'declined' ||
        (ask.status === 'answered' && ask.degraded.includes('thread')) ||
        (ask.status === 'thinking' && agentReplies <= ask.baseline))
  )
  // What lands at the end of the thread: a reply, Piloti's work line, its answer. Kept in view for a reader at the end.
  const thread = useFollowEnd<HTMLDivElement>(
    `${annotation.replies.length}:${annotation.pilotiWork?.state ?? ''}:${threadAsk?.id ?? ''}:${threadAsk?.status ?? ''}`
  )

  /**
   * The reply goes in as the person's own, with whom it mentions as picked
   * (never read out of the text): colleagues are told by the server, and
   * @Piloti says the reply addresses Piloti. The server answers whether it
   * wakes Piloti itself (`queued`, or `suppressed` when a cap held it): then
   * the mark's own view says how Piloti's work stands (`pilotiWork`), for
   * everyone. When a rule met the reply but the organization's switch is off
   * (`wake: 'off'`: an @Piloti, or an answer to Piloti's own Rückfrage), this
   * tab asks Piloti as before, under the turn id a server wake of the same
   * reply would use, so the two never both run. Answers with the mentions the
   * server kept.
   */
  const sendReply = async (body: string, { piloti: mentioned, mentions }: ComposerSend) => {
    // Sent into the thread: what follows it (the reply, Piloti at work, its answer) comes into view.
    thread.follow()
    const { annotation: after, wake, replyId } = await review.reply(annotation.id, body, {
      addressesPiloti: mentioned,
      mentions,
    })
    const kept = after.replies.find((reply) => reply.id === replyId)?.mentions
    // `off` is the server saying a wake rule met this reply (an @Piloti, or an
    // answer to Piloti's own open Rückfrage) and the switch is off: this tab
    // asks. Anything else, the server already did what there was to do.
    if (wake !== 'off' || !piloti.available || !hasBox(annotation)) return kept
    piloti.ask({
      text: body.trim(),
      region: askRegionOf(annotation),
      annotationId: annotation.id,
      replyInThread: true,
      baseline: agentReplies,
      ...(replyId ? { turnId: wakeTurnId(replyId) } : {}),
    })
    return kept
  }

  const act = async (run: () => Promise<unknown>) => {
    setBusy(true)
    setFailed(false)
    try {
      await run()
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }
  // The status this card shows goes with the move: a tab that missed a colleague's
  // move gets a 409 and the fresh list, never an act on a state it did not see.
  const move = (status: 'open' | 'resolved' | 'dismissed') =>
    act(() => review.update(annotation.id, { status, expectedStatus: annotation.status }))
  // Only the person who wrote it rewords a mark: Piloti's text stays Piloti's, a colleague's theirs.
  const mayReword = annotation.canEdit && annotation.authorKind === 'person' && annotation.createdBy === review.me
  // The mark's own rewording, saved or let go: the focus back to the card's ⋯ it was opened from.
  const menuRef = useFocusBackOnClose<HTMLButtonElement>(editing && mayReword)

  /**
   * The reworded text goes in with whom it mentions as the composer kept them:
   * the ones already there stay while their name stands in the text, and the
   * server tells only whom the new text adds (`newlyMentioned`).
   */
  const saveEdit = async (body: string, { mentions }: ComposerSend) => {
    const after = await review.update(annotation.id, { body, mentions })
    setEditing(false)
    return after.mentions
  }

  const menu: ActionMenuEntry[] = [
    ...(mayReword
      ? [
          {
            type: 'item' as const,
            id: 'edit',
            label: t('review.edit'),
            icon: Pencil,
            onSelect: () => setEditing(true),
          },
        ]
      : []),
    ...ANNOTATION_KINDS.filter((kind) => kind !== annotation.kind && annotation.canEdit).map((kind) => ({
      type: 'item' as const,
      id: `kind-${kind}`,
      label: t('review.makeKind', { kind: t(`annotations.kinds.${kind}`) }),
      icon: KIND_ICONS[kind],
      onSelect: () => void act(() => review.update(annotation.id, { kind })),
    })),
    ...(piloti.available && annotation.onCurrentRevision && hasBox(annotation)
      ? [
          {
            type: 'item' as const,
            id: 'ask',
            label: t('review.askAgent'),
            icon: Sparkles,
            onSelect: () => void piloti.compose(askRegionOf(annotation), { annotationId: annotation.id }),
          },
        ]
      : []),
    // Piloti as the delegate (ADR-0105): the mark keeps its assignee, Piloti
    // works it for this person, woken by the server. Only an open mark.
    ...(review.pilotiWakes && annotation.canEdit && annotation.status === 'open'
      ? [
          {
            type: 'item' as const,
            id: 'delegate',
            label: annotation.delegatedBy ? t('review.takeBackFromAgent') : t('review.delegateToPiloti'),
            icon: annotation.delegatedBy ? Undo2 : Sparkles,
            onSelect: () =>
              void act(() => review.update(annotation.id, { delegateToPiloti: !annotation.delegatedBy })),
          },
        ]
      : []),
    ...(onCopyLink
      ? [{ type: 'item' as const, id: 'link', label: t('review.copyLink'), icon: Link2, onSelect: () => onCopyLink(annotation) }]
      : []),
    ...(annotation.canDelete
      ? [
          { type: 'separator' as const },
          {
            type: 'item' as const,
            id: 'delete',
            label: t('review.delete'),
            icon: Trash2,
            variant: 'destructive' as const,
            onSelect: () => setConfirmDelete(true),
          },
        ]
      : []),
    // The author's own mark that a colleague's answer or a carry keeps: the
    // delete stays in view, withheld, with why, and resolving is offered in
    // its place while the mark is open (the server's rule, `deleteRefusalOf`).
    ...(!annotation.canDelete && annotation.deleteRefused
      ? [
          { type: 'separator' as const },
          ...(annotation.canEdit && annotation.status === 'open'
            ? [
                {
                  type: 'item' as const,
                  id: 'resolve-instead',
                  label: t('review.resolveInstead'),
                  icon: Check,
                  testId: 'thread-resolve-instead',
                  onSelect: () => void move('resolved'),
                },
              ]
            : []),
          {
            type: 'item' as const,
            id: 'delete',
            label: t('review.delete'),
            hint: t(`review.deleteRefused.${annotation.deleteRefused}`),
            icon: Trash2,
            disabled: true,
            testId: 'thread-delete-refused',
          },
        ]
      : []),
  ]

  return (
    <ReviewCard placement={placement} testId="review-thread" labelledBy={headerId}>
      <RevisionLines review={review} annotation={annotation} busy={busy} onCarry={() => void act(() => review.carry(annotation))} />
      {walk && proposed && (
        <div className="bg-muted/40 flex items-center gap-2 border-b py-1 pr-1.5 pl-3" data-testid="thread-walk">
          <span className="text-muted-foreground text-[11px] font-medium tabular-nums">
            {t('review.walkPosition', { index: walk.index, total: walk.total })}
          </span>
          {walk.total > 1 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="ml-auto h-6 gap-1.5 px-2 text-xs"
              aria-keyshortcuts="J"
              data-testid="thread-walk-next"
              onClick={walk.onNext}
            >
              {t('review.walkNext')}
              <Kbd className="h-4 min-w-4 px-1 text-[10px]">J</Kbd>
            </Button>
          )}
        </div>
      )}
      <div className={cn('flex items-center gap-1.5 border-b px-3 py-2', placement === 'docked' && 'pr-12')}>
        <KindIcon className="text-muted-foreground size-3.5" aria-hidden />
        {/* What the card is about, which names it as a dialog: the kind, the number, its state. */}
        <span id={headerId} className="flex min-w-0 items-center gap-1.5">
          <span className="text-foreground text-xs font-semibold">{t(`annotations.kinds.${annotation.kind}`)}</span>{' '}
          <span className="text-muted-foreground font-mono text-[11px]">#{annotation.number}</span>
          {proposed && (
            <span className="text-muted-foreground border-foreground/50 ml-1 rounded-full border border-dashed px-1.5 text-[10px] font-medium">
              {t('review.proposal')}
            </span>
          )}
          {!live && (
            <span className="text-muted-foreground bg-muted ml-1 rounded-full px-1.5 text-[10px] font-medium">
              {annotation.status === 'resolved' ? t('review.resolved') : t('review.dismissed')}
            </span>
          )}
        </span>
        <span className="ml-auto flex items-center">
          {annotation.canEdit && annotation.status === 'open' && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 [&_svg]:size-3.5"
              disabled={busy}
              aria-label={t('review.resolve')}
              title={`${t('review.resolve')} (E)`}
              data-testid="thread-resolve"
              onClick={() => void move('resolved')}
            >
              <Check aria-hidden />
            </Button>
          )}
          {annotation.canEdit && !live && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 [&_svg]:size-3.5"
              disabled={busy}
              aria-label={t('review.reopen')}
              title={t('review.reopen')}
              onClick={() => void move('open')}
            >
              <RotateCcw aria-hidden />
            </Button>
          )}
          {menu.length > 0 && (
            <ActionMenu
              mode="dropdown"
              entries={menu}
              trigger={
                <Button
                  ref={menuRef}
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7 [&_svg]:size-3.5"
                  aria-label={t('review.more')}
                >
                  <MoreHorizontal aria-hidden />
                </Button>
              }
            />
          )}
          {/* Docked in the phone's sheet, the sheet's own × closes it. */}
          {placement !== 'docked' && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 [&_svg]:size-3.5"
              aria-label={t('review.closeThread')}
              onClick={() => review.select(null)}
            >
              <X aria-hidden />
            </Button>
          )}
        </span>
      </div>

      {annotation.delegatedBy && (
        <div className="border-b px-3 py-1.5" data-testid="thread-delegate">
          <Chip size="sm" variant="secondary" className="gap-1">
            <AgentGlyph size="xs" />
            {t('review.piloti.delegateChip', { name: annotation.delegatedByName ?? t('review.someone') })}
          </Chip>
        </div>
      )}

      <div
        ref={thread.ref}
        onScroll={thread.onScroll}
        data-testid="thread-messages"
        className="max-h-[min(22rem,50svh)] space-y-3 overflow-y-auto px-3 py-3"
      >
        {editing && mayReword ? (
          <div className="space-y-1.5" data-testid="thread-edit">
            <Composer
              autoFocus
              testId="thread-edit-body"
              placeholder={t('review.editLabel', { number: annotation.number })}
              submitLabel={t('review.save')}
              documentId={review.documentId}
              initialBody={annotation.body}
              initialMentions={annotation.mentions}
              describeFailure={() => t('review.saveFailed')}
              onSubmit={saveEdit}
              onEscape={() => setEditing(false)}
            />
            <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setEditing(false)}>
              {t('review.editCancel')}
            </Button>
          </div>
        ) : (
          <Message
            authorKind={annotation.authorKind}
            name={annotation.createdByName}
            userId={annotation.createdBy}
            at={annotation.createdAt}
            body={annotation.body}
            mentions={annotation.mentions}
            viewerId={review.me}
            proposal={proposed}
          />
        )}
        {annotation.basis && (
          <p className="text-muted-foreground ml-8.5 flex items-center gap-1.5 text-[11px]">
            <Scale className="size-3 shrink-0" aria-hidden />
            <span className="font-mono">{annotation.basis}</span>
          </p>
        )}
        {annotation.replies.map((reply) => (
          <ReplyEntry key={reply.id} review={review} annotation={annotation} reply={reply} />
        ))}
        <AgentWorkRow annotation={annotation} />
        {threadAsk && <AgentThreadRow ask={threadAsk} review={review} />}
      </div>

      {proposed && annotation.canEdit && (
        <div className="bg-muted/40 space-y-2 border-t px-3 py-2.5">
          <p className="text-muted-foreground text-[11px] leading-4">{t('review.proposalHint')}</p>
          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 justify-between text-xs"
              disabled={busy}
              data-testid="thread-dismiss"
              onClick={() => void move('dismissed')}
            >
              {t('review.dismiss')}
              <Kbd className="ml-2 pointer-coarse:hidden">{t('review.dismissKey')}</Kbd>
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-8 justify-between text-xs"
              disabled={busy}
              data-testid="thread-accept"
              onClick={() => void move('open')}
            >
              {t('review.accept')}
              <Kbd className="bg-background/15 text-background ml-2 border-transparent pointer-coarse:hidden">E</Kbd>
            </Button>
          </div>
        </div>
      )}

      <div className="space-y-2 border-t px-3 py-2.5">
        <ResponsibilityRow
          documentId={review.documentId}
          assigneeUserId={annotation.assigneeUserId}
          assigneeName={annotation.assigneeUserId ? (annotation.assigneeName ?? t('review.someone')) : null}
          dueOn={annotation.dueOn}
          editable={annotation.canEdit && live}
          canPickAssignee={canPickAssignee}
          self={self}
          onAssignee={(person) => void act(() => review.update(annotation.id, { assigneeUserId: person?.userId ?? null }))}
          onDueOn={(dueOn) => void act(() => review.update(annotation.id, { dueOn }))}
        />
        {annotation.canEdit && (
          <Composer
            testId="thread-reply"
            placeholder={t('review.replyPlaceholder')}
            submitLabel={t('review.send')}
            mentionAgent={piloti.available}
            documentId={review.documentId}
            pickerSide="above"
            onSubmit={sendReply}
            // Esc steps out of the field, keeping what is typed; the next Esc closes the thread.
            onEscape={() => {
              if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
            }}
          />
        )}
        {failed && <FieldError>{t('review.actionFailed')}</FieldError>}
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t('review.deleteConfirm', { number: annotation.number })}
        confirmLabel={t('review.delete')}
        cancelLabel={t('annotations.cancel')}
        onConfirm={() => act(() => review.remove(annotation.id))}
      />
    </ReviewCard>
  )
}
