'use client'

/**
 * The list half of the Postfach queue: „Wartet auf Sie“, one card per document
 * or chat holding what waits on the reader there (most urgent first), then
 * „Neuigkeiten“, one quiet line each.
 *
 * Every entry is a link to its real place (the chat at the message, the
 * review at the mark), so a phone, a new tab and a screen reader all get a
 * real link. The entry whose place the reader is at is drawn as current.
 */

import type { JSX, MouseEvent, ReactNode } from 'react'
import Link from 'next/link'
import { Archive, Clock } from 'lucide-react'

import { namespaceRoot, useLocale, useTranslations } from '@/i18n'
import { collaborationCopy } from '@/i18n/namespaces/collaboration'
import { formatRelativeTime } from '@/lib/format'
import { inboxItemCopy } from '@/lib/inbox/item-copy'
import type { InboxItemView } from '@/lib/inbox/types'
import { SectionLabel } from '@/components/ui/section-label'
import { cn } from '@/lib/utils'
import type { InboxQueueGroup } from '../lib/inbox-queue'
import { inboxDue } from '../lib/inbox-due'
import { inboxReason } from '../lib/inbox-reason'
import { InboxItemFace } from './InboxItemFace'

export interface InboxQueueListProps {
  groups: readonly InboxQueueGroup[]
  news: readonly InboxItemView[]
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
    <div className="space-y-6">
      <section aria-labelledby="inbox-queue-waiting" className="space-y-2" data-testid="inbox-queue-waiting">
        <SectionLabel as="h3" id="inbox-queue-waiting" className="block px-1">
          {t('inbox.queue.waiting')}
        </SectionLabel>
        {groups.length === 0 ? (
          <p className="px-1 text-sm text-muted-foreground">{t('inbox.queue.nothingWaiting')}</p>
        ) : (
          <ul className="space-y-2">
            {groups.map((group) => (
              <li key={group.key} className="overflow-hidden rounded-surface border bg-card" data-testid="inbox-queue-group">
                {group.subject && (
                  <p className="flex min-w-0 items-baseline gap-2 px-3 pt-2.5 pb-0.5 text-xs">
                    <span className="truncate font-medium text-foreground">{group.subject}</span>
                    <span className="shrink-0 text-muted-foreground">{group.chat ? t('inbox.queue.chat') : group.projectName}</span>
                  </p>
                )}
                <ul className="p-1">
                  {group.items.map((item) => (
                    <EntryItem key={item.id} item={item} onArchive={onArchive}>
                      <WaitingEntry item={item} href={hrefOf(item)} current={item.id === currentId} onFollow={onFollow} />
                    </EntryItem>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
        {waitingMore}
      </section>

      {news.length > 0 && (
        <section aria-labelledby="inbox-queue-news" className="space-y-1" data-testid="inbox-queue-news">
          <div className="flex items-center justify-between gap-2 px-1">
            <SectionLabel as="h3" id="inbox-queue-news">
              {t('inbox.queue.news')}
            </SectionLabel>
            {onNewsRead && (
              <button
                type="button"
                className="rounded-control text-xs text-muted-foreground hover:text-foreground touch-target"
                onClick={onNewsRead}
                data-testid="inbox-queue-news-read"
              >
                {t('inbox.queue.newsRead')}
              </button>
            )}
          </div>
          <ul>
            {news.map((item) => (
              <EntryItem key={item.id} item={item} onArchive={onArchive}>
                <NewsEntry item={item} href={hrefOf(item)} current={item.id === currentId} onFollow={onFollow} />
              </EntryItem>
            ))}
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
    <li className="group/entry relative">
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
    </li>
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

/** A request: what it is about in the words of the thing itself, then why it is the reader's and by when. */
function WaitingEntry(props: EntryProps): JSX.Element {
  const { item } = props
  const t = useTranslations(collaborationCopy)
  const { locale } = useLocale()
  const { title } = inboxItemCopy(item, t, namespaceRoot(collaborationCopy, locale), locale)
  const reason = inboxReason(item, t)
  const due = inboxDue(item, t, locale)
  const unread = item.state === 'unread'
  return (
    <EntryFrame {...props} className="gap-2.5 px-2 py-2">
      <span
        aria-hidden
        className={cn('mt-[0.45rem] size-[7px] shrink-0 rounded-full', unread ? 'bg-foreground' : 'bg-transparent')}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={cn('line-clamp-2 text-sm leading-snug text-foreground', unread && 'font-medium')}>
          {item.excerpt ?? title}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-xs text-muted-foreground">
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
          {due && <span aria-hidden className="shrink-0">·</span>}
          {/* Without an excerpt the title above already says who asked. */}
          <span className="min-w-0 truncate">{item.excerpt ? (reason ?? title) : formatRelativeTime(item.updatedAt, locale)}</span>
        </span>
      </span>
    </EntryFrame>
  )
}

/** News: who, what in one line, and when. */
function NewsEntry(props: EntryProps): JSX.Element {
  const { item } = props
  const t = useTranslations(collaborationCopy)
  const { locale } = useLocale()
  const { title } = inboxItemCopy(item, t, namespaceRoot(collaborationCopy, locale), locale)
  return (
    <EntryFrame {...props} className="items-center gap-2.5 px-2 py-1.5">
      <span aria-hidden className="flex size-7 shrink-0 items-center justify-center">
        <InboxItemFace item={item} size="sm" />
      </span>
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">{title}</span>
      <time className="shrink-0 text-xs tabular-nums text-muted-foreground" dateTime={item.updatedAt}>
        {formatRelativeTime(item.updatedAt, locale)}
      </time>
    </EntryFrame>
  )
}
