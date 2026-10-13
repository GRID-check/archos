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
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { FieldError } from '@/components/ui/field'
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
import type { FileAssignee } from '../../file-types'
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
        <span className="bg-foreground text-background flex size-6 shrink-0 items-center justify-center rounded-full">
          <Sparkles className="size-3" aria-hidden />
        </span>
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

/** The reply box and the draft box: Enter sends, Shift+Enter breaks the line, Escape lets go. */
function Composer({
  placeholder,
  submitLabel,
  autoFocus,
  onSubmit,
  onEscape,
  testId,
}: {
  placeholder: string
  submitLabel: string
  autoFocus?: boolean
  onSubmit: (body: string) => Promise<unknown>
  onEscape?: () => void
  testId: string
}): JSX.Element {
  const t = useTranslations('files')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
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
      await onSubmit(body)
      setBody('')
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void submit()
    }
    if (event.key === 'Escape' && onEscape) {
      event.stopPropagation()
      onEscape()
    }
  }

  return (
    <div>
      <div className="bg-input-background focus-within:border-foreground/40 flex items-end gap-1.5 rounded-lg border px-2.5 py-1.5 transition-colors duration-quick ease-out">
        <textarea
          ref={ref}
          data-testid={testId}
          aria-label={placeholder}
          rows={1}
          value={body}
          maxLength={MAX_ANNOTATION_BODY}
          placeholder={placeholder}
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={onKeyDown}
          className="placeholder:text-muted-foreground min-h-6 flex-1 resize-none border-0 bg-transparent py-0.5 text-[13px] leading-5 shadow-none ring-0 outline-none focus:ring-0 focus:outline-none focus-visible:ring-0 focus-visible:outline-none"
        />
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
}: { icon: typeof UserRound; tone?: 'warning'; children: React.ReactNode } & React.ComponentProps<'button'>) {
  return (
    <button
      type="button"
      className={cn(
        'border-border/80 text-muted-foreground hover:text-foreground hover:bg-accent/60 inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[11px] font-medium transition-colors duration-quick ease-out disabled:pointer-events-none',
        tone === 'warning' && 'text-warning border-warning/40'
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
          tone={overdue ? 'warning' : undefined}
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
function Card({ flip, children, testId }: { flip: boolean; children: React.ReactNode; testId: string }) {
  return (
    <div
      data-testid={testId}
      role="dialog"
      className={cn(
        'bg-popover text-popover-foreground border-border/70 animate-in fade-in-0 zoom-in-95 duration-base ease-entrance motion-reduce:animate-none absolute -top-7 w-[19rem] rounded-xl border shadow-xl',
        flip ? 'right-3 origin-top-right' : 'left-9 origin-top-left'
      )}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {children}
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
  return (
    <Card flip={flip} testId="review-draft">
      <div className="space-y-3 p-3">
        <div className="flex items-center justify-between gap-2">
          <KindPicker value={kind} onChange={setKind} />
          <span className="text-muted-foreground text-[11px]">
            {draft.shape === 'region' ? t('review.region') : t('review.point')}
          </span>
        </div>
        <Composer
          autoFocus
          testId="review-draft-body"
          placeholder={t('review.draftPlaceholder')}
          submitLabel={t('review.set')}
          onEscape={() => review.setDraft(null)}
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
    </Card>
  )
}

/** One mark's thread: the finding, the conversation, the decision, and who is on it. */
export function ThreadCard({
  review,
  annotation,
  flip,
  canPickAssignee,
  onAskPiloti,
  onCopyLink,
}: {
  review: DocumentReview
  annotation: AnnotationView
  flip: boolean
  canPickAssignee: boolean
  onAskPiloti?: (annotation: AnnotationView) => void
  onCopyLink?: (annotation: AnnotationView) => void
}): JSX.Element {
  const t = useTranslations('files')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const KindIcon = KIND_ICONS[annotation.kind]
  const proposed = annotation.status === 'proposed'
  const live = isLive(annotation)

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
    ...(onAskPiloti
      ? [{ type: 'item' as const, id: 'ask', label: t('review.askPiloti'), icon: Sparkles, onSelect: () => onAskPiloti(annotation) }]
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
    <Card flip={flip} testId="review-thread">
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
      </div>

      {proposed && annotation.canEdit && (
        <div className="bg-muted/50 flex items-center gap-2 border-t px-3 py-2">
          <p className="text-muted-foreground flex-1 text-[11px] leading-4">{t('review.proposalHint')}</p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2.5 text-xs"
            disabled={busy}
            data-testid="thread-dismiss"
            onClick={() => void move('dismissed')}
          >
            {t('review.dismiss')}
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-7 px-2.5 text-xs"
            disabled={busy}
            data-testid="thread-accept"
            title={`${t('review.accept')} (E)`}
            onClick={() => void move('open')}
          >
            {t('review.accept')}
          </Button>
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
            onSubmit={(body) => review.reply(annotation.id, body)}
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
    </Card>
  )
}
