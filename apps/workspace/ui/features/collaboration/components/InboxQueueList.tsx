'use client'

/**
 * The list half of the Postfach queue: „Wartet auf Sie“, gathered under each
 * document or chat (most urgent first), then „Neuigkeiten“, one quiet line
 * each.
 *
 * Flat on purpose. The groups were cards in a panel, boxes in a box, and the
 * borders said more than the entries; a group is its name over its entries
 * now, set apart by space alone. What a section holds is said once, in its
 * heading: how many wait, and how many of them are late.
 *
 * Every entry is a link to its real place (the chat at the message, the
 * review at the mark), so a phone, a new tab and a screen reader all get a
 * real link. The entry whose place the reader is at is drawn as current.
 *
 * Rows arrive and leave by their height (`HeightArrival`): an archived entry
 * folds away and the ones below close the gap, rather than jumping up a row in
 * one frame. What was there when the list mounted stands at once
 * (`initial={false}`).
 */

import type { JSX, MouseEvent, ReactNode } from 'react'
import Link from 'next/link'
import { Archive, Clock } from 'lucide-react'

import { namespaceRoot, useLocale, useTranslations } from '@/i18n'
import { collaborationCopy } from '@/i18n/namespaces/collaboration'
import { formatRelativeTime } from '@/lib/format'
import { inboxItemCopy } from '@/lib/inbox/item-copy'
import type { InboxItemView } from '@/lib/inbox/types'
import { AnimatePresence } from '@/components/motion'
import { HeightArrival } from '@/components/motion/height-arrival'
import { SectionLabel } from '@/components/ui/section-label'
import { cn } from '@/lib/utils'
import type { InboxQueueGroup } from '../lib/inbox-queue'
import { inboxDue } from '../lib/inbox-due'
import { inboxReason } from '../lib/inbox-reason'
import { InboxItemFace } from './InboxItemFace'

export interface InboxQueueListProps {
  groups: readonly InboxQueueGroup[]
  news: readonly InboxItemView[]
  /** How many entries wait, and how many of them are late: the section's heading says both. */
  waitingCount: number
  lateCount: number
  /** The entry whose place the reader is at. */
  currentId: string | null
  /** Where an entry's link goes (on the Postfach page, a mark's carries the way back). */
  hrefOf: (item: InboxItemView) => string | null
  /** The reader followed an entry's link. */
  onFollow: (event: MouseEvent<HTMLAnchorElement>, item: InboxItemView) => void
  /** Puts an entry away (with the list's undo). */
  onArchive?: (itemId: string) => void
  /** Marks the news read; absent when there is none unread. */
  onNewsRead?: () => void
  /** Each section's „Weitere laden“, when the server has more. */
  waitingMore?: ReactNode
  newsMore?: ReactNode
}

export function InboxQueueList({
  groups,
  news,
  waitingCount,
  lateCount,
  currentId,
  hrefOf,
  onFollow,
  onArchive,
  onNewsRead,
  waitingMore,
  newsMore,
}: InboxQueueListProps): JSX.Element {
  const t = useTranslations(collaborationCopy)
  return (
    <div className="space-y-7">
      <section aria-labelledby="inbox-queue-waiting" className="space-y-2" data-testid="inbox-queue-waiting">
        <div className="flex items-baseline gap-2 px-2" data-testid="inbox-queue-summary">
          <SectionLabel as="h3" id="inbox-queue-waiting">
            {t('inbox.queue.waiting')}
          </SectionLabel>
          {waitingCount > 0 && <span className="text-xs tabular-nums text-muted-foreground">{waitingCount}</span>}
          {lateCount > 0 && (
            <span className="text-xs font-medium tabular-nums text-error">{t('inbox.queue.late', { count: lateCount })}</span>
          )}
        </div>
        {groups.length === 0 ? (
          <p className="px-2 text-sm text-muted-foreground">{t('inbox.queue.nothingWaiting')}</p>
        ) : (
          <ul className="divide-y divide-border/60">
            <AnimatePresence initial={false}>
              {groups.map((group) => (
                <HeightArrival key={group.key} as="li" className="py-3 first:pt-0 last:pb-0" testId="inbox-queue-group">
                  {group.subject && (
                    <p className="flex min-w-0 items-baseline gap-1.5 px-2 pb-0.5 text-xs">
                      <span className="truncate font-medium text-foreground">{group.subject}</span>
                      <span className="shrink-0 text-muted-foreground">{group.chat ? t('inbox.queue.chat') : group.projectName}</span>
                    </p>
                  )}
                  <ul>
                    <AnimatePresence initial={false}>
                      {group.items.map((item) => (
                        <EntryItem key={item.id} item={item} onArchive={onArchive}>
                          <WaitingEntry item={item} href={hrefOf(item)} current={item.id === currentId} onFollow={onFollow} />
                        </EntryItem>
                      ))}
                    </AnimatePresence>
                  </ul>
                </HeightArrival>
              ))}
            </AnimatePresence>
          </ul>
        )}
        {waitingMore}
      </section>

      {news.length > 0 && (
        <section aria-labelledby="inbox-queue-news" className="space-y-2" data-testid="inbox-queue-news">
          <div className="flex items-baseline justify-between gap-2 px-2">
            <SectionLabel as="h3" id="inbox-queue-news">
              {t('inbox.queue.news')}
            </SectionLabel>
            {onNewsRead && (
              <button
                type="button"
                className="rounded-control text-xs text-muted-foreground transition-colors duration-snap hover:text-foreground motion-reduce:transition-none touch-target"
                onClick={onNewsRead}
                data-testid="inbox-queue-news-read"
              >
                {t('inbox.queue.newsRead')}
              </button>
            )}
          </div>
          <ul>
            <AnimatePresence initial={false}>
              {news.map((item) => (
                <EntryItem key={item.id} item={item} onArchive={onArchive}>
                  <NewsEntry item={item} href={hrefOf(item)} current={item.id === currentId} onFollow={onFollow} />
                </EntryItem>
              ))}
            </AnimatePresence>
          </ul>
          {newsMore}
        </section>
      )}
    </div>
  )
}

interface EntryProps {
  item: InboxItemView
  href: string | null
  current: boolean
  onFollow: (event: MouseEvent<HTMLAnchorElement>, item: InboxItemView) => void
}

/**
 * One entry's list item: the link, and beside it the control that puts the
 * entry away. A sibling of the link, never inside it (a button in an anchor is
 * an accessibility defect). It comes up on the entry the pointer or the focus
 * is on, and stays under a finger, which has no hover.
 */
function EntryItem({ item, onArchive, children }: { item: InboxItemView; onArchive?: (itemId: string) => void; children: ReactNode }): JSX.Element {
  const t = useTranslations(collaborationCopy)
  return (
    <HeightArrival as="li" className="group/entry relative">
      {children}
      {onArchive && (
        <button
          type="button"
          aria-label={t('inbox.archive')}
          title={t('inbox.archive')}
          onClick={() => onArchive(item.id)}
          className={cn(
            'absolute top-1.5 right-1.5 flex size-7 items-center justify-center rounded-control text-muted-foreground hover:bg-background hover:text-foreground',
            'opacity-0 transition-opacity duration-snap group-hover/entry:opacity-100 group-focus-within/entry:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100 motion-reduce:transition-none',
          )}
          data-testid="inbox-queue-archive"
        >
          <Archive className="size-3.5" aria-hidden />
        </button>
      )}
    </HeightArrival>
  )
}

/** The link an entry is, or plain text when its target is gone. */
function EntryFrame({ item, href, current, onFollow, className, children }: EntryProps & { className: string; children: ReactNode }): JSX.Element {
  const frame = cn(
    'flex w-full min-w-0 rounded-control text-left outline-none transition-colors duration-snap motion-reduce:transition-none',
    'hover:bg-muted',
    current && 'bg-accent hover:bg-accent',
    className,
    // Room at the end for the archive control that comes up over it. Last, so
    // an entry's own `px-*` cannot merge it away and put the text under it.
    'pr-9',
  )
  if (!href) {
    return <div className={frame} data-item-id={item.id}>{children}</div>
  }
  return (
    <Link
      href={href}
      className={frame}
      aria-current={current ? 'page' : undefined}
      data-item-id={item.id}
      data-testid="inbox-queue-entry"
      data-focus-inset=""
      onClick={(event) => onFollow(event, item)}
    >
      {children}
    </Link>
  )
}

/**
 * A request: what it is about in the words of the thing itself, then by when
 * and why it is the reader's. No unread dot: everything here waits on the
 * reader, so a dot on every row said nothing; one not opened yet is set in
 * the heavier weight. The line under it wraps rather than cutting a name off.
 */
function WaitingEntry(props: EntryProps): JSX.Element {
  const { item } = props
  const t = useTranslations(collaborationCopy)
  const { locale } = useLocale()
  const { title } = inboxItemCopy(item, t, namespaceRoot(collaborationCopy, locale), locale)
  const reason = inboxReason(item, t)
  const due = inboxDue(item, t, locale)
  return (
    <EntryFrame {...props} className="flex-col gap-0.5 px-2 py-2">
      <span className={cn('line-clamp-2 text-sm leading-snug text-foreground', !item.read && 'font-medium')}>
        {item.excerpt ?? title}
      </span>
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
        {due && (
          <span
            className={cn(
              'inline-flex shrink-0 items-center gap-1',
              due.variant === 'danger' && 'font-medium text-error',
              due.variant === 'warning' && 'font-medium text-warning',
            )}
            data-testid="inbox-queue-due"
          >
            <Clock className="size-3" aria-hidden />
            {due.label}
          </span>
        )}
        {/* Without an excerpt the title above already says who asked. No dot
            between the two: the date stands apart by its clock and colour, and
            a dot left at the end or start of a wrapped line was noise. */}
        <span>{item.excerpt ? (reason ?? title) : formatRelativeTime(item.updatedAt, locale)}</span>
      </span>
    </EntryFrame>
  )
}

/** News: who, what in up to two lines, and when. */
function NewsEntry(props: EntryProps): JSX.Element {
  const { item } = props
  const t = useTranslations(collaborationCopy)
  const { locale } = useLocale()
  const { title } = inboxItemCopy(item, t, namespaceRoot(collaborationCopy, locale), locale)
  return (
    <EntryFrame {...props} className="items-start gap-2.5 px-2 py-1.5">
      <span aria-hidden className="flex size-7 shrink-0 items-center justify-center">
        <InboxItemFace item={item} size="sm" />
      </span>
      <span className="min-w-0 flex-1 pt-1 text-sm leading-snug">
        <span className="line-clamp-2 text-foreground">{title}</span>
        <time className="text-xs tabular-nums text-muted-foreground" dateTime={item.updatedAt}>
          {formatRelativeTime(item.updatedAt, locale)}
        </time>
      </span>
    </EntryFrame>
  )
}
