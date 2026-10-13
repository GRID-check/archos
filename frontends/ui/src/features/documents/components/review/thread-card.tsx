'use client'

import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import {
  ArrowUp,
  CalendarClock,
  Check,
  CircleHelp,
  Link2,
  MessageSquareText,
  MoreHorizontal,
  RotateCcw,
  Scale,
  Sparkles,
  Trash2,
  TriangleAlert,
  UserRound,
  X,
} from 'lucide-react'
import { ActionMenu, type ActionMenuEntry } from '@/components/ui/action-menu'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { PilotiGlyph } from '@/components/ui/piloti-glyph'
import { ShimmerText } from '@/components/ui/shimmer-text'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { FieldError } from '@/components/ui/field'
import { Kbd } from '@/components/ui/kbd'
import { PersonAvatar } from '@/components/ui/avatar-stack'
import { TimeAgo } from '@/components/ui/time-ago'
import { useLocale, useTranslations } from '@/i18n'
import { formatDayRange, localCalendarDay } from '@/lib/format'
import {
  ANNOTATION_KINDS,
  isLive,
  MAX_ANNOTATION_BODY,
  type AnnotationKind,
  type AnnotationView,
} from '@/lib/annotations/types'
import { cn } from '@/lib/utils'
import { liveLine } from '@/features/chat/lib/turn-events'
import type { FileAssignee } from '../../file-types'
import { askRegionOf, stepsOf, type CanvasAsk } from '../../hooks/use-canvas-ask'
import type { DocumentReview, ReviewDraft } from '../../hooks/use-document-review'
import { AssignPopover } from '../assign-popover'

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
}: {
  authorKind: 'person' | 'piloti'
  name: string | null
  userId: string
  at: string
  body: string
}): JSX.Element {
  const t = useTranslations('files')
  const { locale } = useLocale()
  return (
    <div className="flex gap-2.5">
      {authorKind === 'piloti' ? (
        <PilotiGlyph />
      ) : (
        <PersonAvatar
          size="sm"
          className="size-6 text-[10px]"
          person={{ userId, name: name ?? t('review.someone'), profilePictureUrl: null }}
        />
      )}
      <div className="min-w-0 flex-1">
        <p className="flex items-baseline gap-1.5 text-xs">
          <span className="text-foreground font-semibold">
            {authorKind === 'piloti' ? 'Piloti' : (name ?? t('review.someone'))}
          </span>
          <TimeAgo date={at} locale={locale} className="text-muted-foreground" />
        </p>
        <p className="text-foreground mt-0.5 text-[13px] leading-5 break-words whitespace-pre-wrap">{body}</p>
      </div>
    </div>
  )
}

/** Whether the text before the caret ends in an „@" word that could still become „@Piloti". */
function mentionQuery(text: string, caret: number): { start: number } | null {
  const before = text.slice(0, caret)
  const at = before.lastIndexOf('@')
  if (at < 0 || (at > 0 && !/\s/.test(before[at - 1]))) return null
  const query = before.slice(at + 1)
  return /^\p{L}*$/u.test(query) && 'piloti'.startsWith(query.toLowerCase()) ? { start: at } : null
}

/**
 * The reply box and the draft box: Enter sends, Shift+Enter breaks the line,
 * Escape lets go.
 *
 * `onAskPiloti`: a second way out, the text handed to Piloti instead
 * (⌘/Ctrl+Enter, or the spark beside Send). `mentionPiloti`: Piloti can be
 * brought into the thread. Typing „@" offers it, and taking the offer (or the
 * spark) puts a chip in the box: the mention is that chip, a fact the box
 * holds, never a pattern read out of the text.
 */
export function Composer({
  placeholder,
  submitLabel,
  autoFocus,
  onSubmit,
  onEscape,
  onAskPiloti,
  mentionPiloti,
  maxLength = MAX_ANNOTATION_BODY,
  testId,
}: {
  placeholder: string
  submitLabel: string
  autoFocus?: boolean
  onSubmit: (body: string, options: { piloti: boolean }) => Promise<unknown>
  onEscape?: () => void
  onAskPiloti?: (body: string) => void
  mentionPiloti?: boolean
  maxLength?: number
  testId: string
}): JSX.Element {
  const t = useTranslations('files')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [mentioned, setMentioned] = useState(false)
  const [suggest, setSuggest] = useState<{ start: number } | null>(null)
  const ref = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    if (autoFocus) ref.current?.focus()
  }, [autoFocus])

  // Grow with the text, up to a handful of lines, then scroll.
  useEffect(() => {
    const node = ref.current
    if (!node) return
    node.style.height = '0px'
    node.style.height = `${Math.min(node.scrollHeight, 144)}px`
  }, [body])

  const submit = async () => {
    if (!body.trim() || busy) return
    setBusy(true)
    setFailed(false)
    try {
      await onSubmit(body, { piloti: mentioned })
      setBody('')
      setMentioned(false)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  /** Take the „@…" offer: the typed word goes, the chip comes. */
  const takeMention = () => {
    const node = ref.current
    if (suggest && node) {
      const caret = node.selectionStart ?? body.length
      setBody(body.slice(0, suggest.start) + body.slice(caret))
    }
    setSuggest(null)
    setMentioned(true)
    node?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return
    if (suggest && (event.key === 'Enter' || event.key === 'Tab')) {
      event.preventDefault()
      takeMention()
      return
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && onAskPiloti) {
      event.preventDefault()
      onAskPiloti(body.trim())
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void submit()
    }
    if (event.key === 'Escape') {
      if (suggest) {
        event.stopPropagation()
        setSuggest(null)
        return
      }
      if (onEscape) {
        event.stopPropagation()
        onEscape()
      }
    }
  }

  const pilotiButton = onAskPiloti ? (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-6 shrink-0 rounded-full [&_svg]:size-3.5"
      aria-label={t('review.piloti.ask')}
      title={`${t('review.piloti.ask')} (⌘↵)`}
      data-testid={`${testId}-piloti`}
      onClick={() => onAskPiloti(body.trim())}
    >
      <Sparkles aria-hidden />
    </Button>
  ) : mentionPiloti ? (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn('size-6 shrink-0 rounded-full [&_svg]:size-3.5', mentioned && 'bg-accent text-foreground')}
      aria-label={t('review.piloti.mention')}
      aria-pressed={mentioned}
      title={t('review.piloti.mentionHint')}
      data-testid={`${testId}-mention`}
      onClick={() => setMentioned((on) => !on)}
    >
      <Sparkles aria-hidden />
    </Button>
  ) : null

  return (
    <div className="relative">
      <div className="bg-input-background focus-within:border-foreground/40 rounded-lg border px-2.5 py-1.5 transition-colors duration-quick ease-out">
        {mentioned && (
          <Chip size="sm" variant="secondary" className="mb-1 gap-1 pr-1" data-testid={`${testId}-mention-chip`}>
            <Sparkles aria-hidden />
            @Piloti
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground rounded-sm"
              aria-label={t('review.piloti.mentionRemove')}
              onClick={() => setMentioned(false)}
            >
              <X className="size-3" aria-hidden />
            </button>
          </Chip>
        )}
        <div className="flex items-end gap-1.5">
          <textarea
            ref={ref}
            data-testid={testId}
            aria-label={placeholder}
            aria-autocomplete={mentionPiloti ? 'list' : undefined}
            rows={1}
            value={body}
            maxLength={maxLength}
            placeholder={placeholder}
            onChange={(event) => {
              setBody(event.target.value)
              if (mentionPiloti && !mentioned) {
                setSuggest(mentionQuery(event.target.value, event.target.selectionStart ?? event.target.value.length))
              }
            }}
            onBlur={() => setSuggest(null)}
            onKeyDown={onKeyDown}
            className="placeholder:text-muted-foreground min-h-6 flex-1 resize-none border-0 bg-transparent py-0.5 text-[13px] leading-5 shadow-none outline-none! ring-0 focus-visible:ring-0"
          />
          {pilotiButton}
          <Button
            type="button"
            size="icon"
            className="size-6 shrink-0 rounded-full [&_svg]:size-3.5"
            disabled={!body.trim() || busy}
            aria-label={submitLabel}
            title={`${submitLabel} (Enter)`}
            data-testid={`${testId}-send`}
            onClick={() => void submit()}
          >
            <ArrowUp aria-hidden />
          </Button>
        </div>
      </div>
      {suggest && (
        <div
          role="listbox"
          aria-label={t('review.piloti.mention')}
          className="bg-popover border-border/70 absolute top-full left-0 z-10 mt-1 w-56 rounded-lg border p-1 shadow-md"
        >
          <button
            type="button"
            role="option"
            aria-selected
            data-testid={`${testId}-mention-option`}
            // Before the textarea's blur closes the offer.
            onPointerDown={(event) => {
              event.preventDefault()
              takeMention()
            }}
            className="bg-accent flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left"
          >
            <PilotiGlyph size="xs" />
            <span className="min-w-0">
              <span className="text-foreground block text-xs font-semibold">Piloti</span>
              <span className="text-muted-foreground block text-[11px] leading-4">{t('review.piloti.mentionHint')}</span>
            </span>
          </button>
        </div>
      )}
      {failed && <FieldError className="mt-1">{t('review.sendFailed')}</FieldError>}
    </div>
  )
}

/** A chip for who is on it and by when: quiet until set, then the fact itself. */
function MetaChip({
  icon: Icon,
  children,
  tone,
  ...props
}: { icon: typeof UserRound; tone?: 'urgent'; children: React.ReactNode } & React.ComponentProps<'button'>) {
  return (
    <button
      type="button"
      className={cn(
        'border-border/80 text-muted-foreground hover:text-foreground hover:bg-accent/60 inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[11px] font-medium transition-colors duration-quick ease-out disabled:pointer-events-none',
        // Overdue is ink and weight, not gold: gold is the Büroablage's colour.
        tone === 'urgent' && 'text-foreground border-foreground/50 font-semibold'
      )}
      {...props}
    >
      <Icon className="size-3" aria-hidden />
      {children}
    </button>
  )
}

/** Who is on it and by when, editable while the reader may write. */
function ResponsibilityRow({
  documentId,
  assigneeName,
  dueOn,
  editable,
  canPickAssignee,
  onAssignee,
  onDueOn,
}: {
  documentId: string
  assigneeName: string | null
  dueOn: string | null
  editable: boolean
  canPickAssignee: boolean
  onAssignee: (person: FileAssignee | null) => void
  onDueOn: (day: string | null) => void
}): JSX.Element | null {
  const t = useTranslations('files')
  const { locale } = useLocale()
  const dateRef = useRef<HTMLInputElement | null>(null)
  const overdue = dueOn !== null && dueOn < localCalendarDay()
  if (!editable && !assigneeName && !dueOn) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {canPickAssignee && editable ? (
        <AssignPopover
          documentId={documentId}
          assignees={[]}
          pickOnly
          onPick={onAssignee}
          onChanged={() => undefined}
          trigger={
            <MetaChip icon={UserRound} data-testid="thread-assignee">
              {assigneeName ?? t('review.assign')}
            </MetaChip>
          }
        />
      ) : (
        assigneeName && (
          <MetaChip icon={UserRound} disabled>
            {assigneeName}
          </MetaChip>
        )
      )}
      {assigneeName && editable && (
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground -ml-1 rounded p-0.5"
          aria-label={t('review.unassign')}
          onClick={() => onAssignee(null)}
        >
          <X className="size-3" aria-hidden />
        </button>
      )}
      <span className="relative inline-flex">
        <MetaChip
          icon={CalendarClock}
          tone={overdue ? 'urgent' : undefined}
          disabled={!editable}
          onClick={() => dateRef.current?.showPicker?.()}
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

/** The three kinds as one quiet segmented row. */
function KindPicker({ value, onChange }: { value: AnnotationKind; onChange: (kind: AnnotationKind) => void }) {
  const t = useTranslations('files')
  return (
    <div role="radiogroup" aria-label={t('annotations.kind')} className="bg-muted inline-flex rounded-md p-0.5">
      {ANNOTATION_KINDS.map((kind) => {
        const Icon = KIND_ICONS[kind]
        const on = kind === value
        return (
          <button
            key={kind}
            type="button"
            role="radio"
            aria-checked={on}
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

/** The card's frame: a floating sheet beside its mark, on the side with room. */
export function ReviewCard({ flip, children, testId }: { flip: boolean; children: React.ReactNode; testId: string }) {
  return (
    <div
      data-testid={testId}
      role="dialog"
      className={cn(
        'bg-popover text-popover-foreground border-border/70 animate-in fade-in-0 zoom-in-95 duration-base ease-entrance motion-reduce:animate-none absolute top-0 w-[20rem] rounded-xl border shadow-xl',
        flip ? 'right-4 origin-top-right' : 'left-4 origin-top-left'
      )}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {/* The hairline from the mark's edge to its card: which mark this is
          about, without the card sitting on it. */}
      <span
        aria-hidden
        className={cn('bg-foreground/40 absolute top-3.5 h-px w-4', flip ? '-right-4' : '-left-4')}
      />
      {children}
    </div>
  )
}

/** Piloti, brought into a thread: answering, or not able to, with a way to ask again. */
function PilotiThreadRow({ ask, review }: { ask: CanvasAsk; review: DocumentReview }): JSX.Element {
  const t = useTranslations('files')
  const tChat = useTranslations('chat')
  const failed = ask.status === 'failed'
  const line = liveLine(stepsOf(ask.view), tChat) ?? t('review.piloti.replying')
  return (
    <div className="flex items-center gap-2.5" data-testid="thread-piloti-pending" role="status">
      <PilotiGlyph working={!failed} />
      {failed ? (
        <span className="flex min-w-0 flex-1 items-center gap-2 text-xs">
          <span className="text-muted-foreground">{t('review.piloti.replyFailed')}</span>
          <Button type="button" variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => review.piloti.retry(ask.id)}>
            {t('review.piloti.retry')}
          </Button>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground ml-auto rounded p-0.5"
            aria-label={t('review.piloti.close')}
            onClick={() => review.piloti.dismiss(ask.id)}
          >
            <X className="size-3" aria-hidden />
          </button>
        </span>
      ) : (
        <ShimmerText className="min-w-0 flex-1 text-xs">{line}</ShimmerText>
      )}
    </div>
  )
}

/** Setting a new mark: what kind, what is there, optionally who and by when. */
export function DraftCard({
  review,
  draft,
  flip,
  canPickAssignee,
}: {
  review: DocumentReview
  draft: ReviewDraft
  flip: boolean
  canPickAssignee: boolean
}): JSX.Element {
  const t = useTranslations('files')
  const [kind, setKind] = useState<AnnotationKind>('hint')
  const [assignee, setAssignee] = useState<FileAssignee | null>(null)
  const [dueOn, setDueOn] = useState<string | null>(null)
  const { piloti } = review
  /** The draft's place handed to Piloti: asked at once with what was typed, or a card waiting for the question. */
  const askPiloti = piloti.available
    ? (body: string) => {
        const region = askRegionOf(draft)
        if (body) piloti.ask({ text: body, region })
        else piloti.compose(region)
      }
    : undefined
  return (
    <ReviewCard flip={flip} testId="review-draft">
      <div className="space-y-3 p-3">
        <KindPicker value={kind} onChange={setKind} />
        <Composer
          autoFocus
          testId="review-draft-body"
          placeholder={t('review.draftPlaceholder')}
          submitLabel={t('review.set')}
          onEscape={() => review.setDraft(null)}
          onAskPiloti={askPiloti}
          onSubmit={(body) =>
            review.create({ kind, body, assigneeUserId: assignee?.userId ?? null, dueOn })
          }
        />
        <ResponsibilityRow
          documentId={review.documentId}
          assigneeName={assignee ? assignee.name || assignee.email || assignee.userId : null}
          dueOn={dueOn}
          editable
          canPickAssignee={canPickAssignee}
          onAssignee={setAssignee}
          onDueOn={setDueOn}
        />
      </div>
    </ReviewCard>
  )
}

/** One mark's thread: the finding, the conversation, the decision, and who is on it. */
export function ThreadCard({
  review,
  annotation,
  flip,
  canPickAssignee,
  onCopyLink,
}: {
  review: DocumentReview
  annotation: AnnotationView
  flip: boolean
  canPickAssignee: boolean
  onCopyLink?: (annotation: AnnotationView) => void
}): JSX.Element {
  const t = useTranslations('files')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const KindIcon = KIND_ICONS[annotation.kind]
  const proposed = annotation.status === 'proposed'
  const live = isLive(annotation)
  const { piloti } = review
  const pilotiReplies = annotation.replies.filter((reply) => reply.authorKind === 'piloti').length
  // Piloti was brought into this thread and has not answered in it yet.
  const threadAsk = piloti.asks.find(
    (ask) =>
      ask.replyInThread &&
      ask.annotationId === annotation.id &&
      (ask.status === 'failed' || (ask.status === 'thinking' && pilotiReplies <= ask.baseline))
  )

  /** The reply goes in as the person's own; with @Piloti, Piloti is then asked to answer in the thread. */
  const sendReply = async (body: string, { piloti: mentioned }: { piloti: boolean }) => {
    await review.reply(annotation.id, body)
    if (!mentioned || !piloti.available) return
    piloti.ask({
      text: body.trim(),
      region: askRegionOf(annotation),
      annotationId: annotation.id,
      replyInThread: true,
      baseline: pilotiReplies,
    })
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
  const move = (status: 'open' | 'resolved' | 'dismissed') => act(() => review.update(annotation.id, { status }))

  const menu: ActionMenuEntry[] = [
    ...ANNOTATION_KINDS.filter((kind) => kind !== annotation.kind && annotation.canEdit).map((kind) => ({
      type: 'item' as const,
      id: `kind-${kind}`,
      label: t('review.makeKind', { kind: t(`annotations.kinds.${kind}`) }),
      icon: KIND_ICONS[kind],
      onSelect: () => void act(() => review.update(annotation.id, { kind })),
    })),
    ...(piloti.available && annotation.onCurrentFassung
      ? [
          {
            type: 'item' as const,
            id: 'ask',
            label: t('review.askPiloti'),
            icon: Sparkles,
            onSelect: () => void piloti.compose(askRegionOf(annotation), { annotationId: annotation.id }),
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
  ]

  return (
    <ReviewCard flip={flip} testId="review-thread">
      <div className="flex items-center gap-1.5 border-b px-3 py-2">
        <KindIcon className="text-muted-foreground size-3.5" aria-hidden />
        <span className="text-foreground text-xs font-semibold">{t(`annotations.kinds.${annotation.kind}`)}</span>
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
        </span>
      </div>

      <div className="max-h-[min(22rem,50vh)] space-y-3 overflow-y-auto px-3 py-3">
        <Message
          authorKind={annotation.authorKind}
          name={annotation.createdByName}
          userId={annotation.createdBy}
          at={annotation.createdAt}
          body={annotation.body}
        />
        {annotation.basis && (
          <p className="border-l-source-law/40 text-muted-foreground ml-8.5 flex items-center gap-1.5 border-l-2 pl-2 text-[11px]">
            <Scale className="size-3 shrink-0" aria-hidden />
            <span className="font-mono">{annotation.basis}</span>
          </p>
        )}
        {annotation.replies.map((reply) => (
          <Message
            key={reply.id}
            authorKind={reply.authorKind}
            name={reply.createdByName}
            userId={reply.createdBy}
            at={reply.createdAt}
            body={reply.body}
          />
        ))}
        {threadAsk && <PilotiThreadRow ask={threadAsk} review={review} />}
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
              <Kbd className="ml-2">⌫</Kbd>
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
              <Kbd className="bg-background/15 text-background ml-2 border-transparent">E</Kbd>
            </Button>
          </div>
        </div>
      )}

      <div className="space-y-2 border-t px-3 py-2.5">
        <ResponsibilityRow
          documentId={review.documentId}
          assigneeName={annotation.assigneeUserId ? (annotation.assigneeName ?? t('review.someone')) : null}
          dueOn={annotation.dueOn}
          editable={annotation.canEdit && live}
          canPickAssignee={canPickAssignee}
          onAssignee={(person) => void act(() => review.update(annotation.id, { assigneeUserId: person?.userId ?? null }))}
          onDueOn={(dueOn) => void act(() => review.update(annotation.id, { dueOn }))}
        />
        {annotation.canEdit && (
          <Composer
            testId="thread-reply"
            placeholder={t('review.replyPlaceholder')}
            submitLabel={t('review.send')}
            mentionPiloti={piloti.available}
            onSubmit={sendReply}
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
