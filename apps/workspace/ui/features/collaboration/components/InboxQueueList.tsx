'use client'

/**
 * The list half of the Postfach queue: „Wartet auf Sie“, one card per document
 * or chat holding what waits on the reader there (most urgent first), then
 * „Neuigkeiten“, one quiet line each.
 *
 * Every entry is a link to its target, so a phone, a new tab and a screen
 * reader all get a real link; where the detail sits beside the list, the
 * queue (`InboxQueue`) turns a plain click into a selection instead.
 */

import type { JSX, MouseEvent, ReactNode } from 'react'
import Link from 'next/link'
import { Clock } from 'lucide-react'

import { namespaceRoot, useLocale, useTranslations } from '@/i18n'
import { collaborationCopy } from '@/i18n/namespaces/collaboration'
import { formatRelativeTime } from '@/lib/format'
import { inboxItemCopy } from '@/lib/inbox/item-copy'
import { INBOX_TYPE_PRESENTATION, UNKNOWN_TYPE_PRESENTATION, type InboxItemView } from '@/lib/inbox/types'
import { AgentGlyph } from '@/components/ui/agent-glyph'
import { PersonAvatar } from '@/components/ui/avatar-stack'
import { SectionLabel } from '@/components/ui/section-label'
import { cn } from '@/lib/utils'
import type { InboxQueueGroup } from '../lib/inbox-queue'
import { inboxDue } from '../lib/inbox-due'
import { inboxReason } from '../lib/inbox-reason'

export interface InboxQueueListProps {
  groups: readonly InboxQueueGroup[]
  news: readonly InboxItemView[]
  /** The entry shown beside the list, drawn as selected. */
  shownId: string | null
  /** Where an entry's link goes (a mark's carries the way back here). */
  hrefOf: (item: InboxItemView) => string | null
  onEntryClick: (event: MouseEvent<HTMLAnchorElement>, item: InboxItemView) => void
  /** Marks the news read; absent when there is none unread. */
  onNewsRead?: () => void
  /** Each section's „Weitere laden“, when the server has more. */
  waitingMore?: ReactNode
  newsMore?: ReactNode
}

export function InboxQueueList({
  groups,
  news,
  shownId,
  hrefOf,
  onEntryClick,
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
                    <span className="truncate font-semibold text-foreground">{group.subject}</span>
                    <span className="shrink-0 text-muted-foreground">{group.chat ? t('inbox.queue.chat') : group.projectName}</span>
                  </p>
                )}
                <ul className="p-1">
                  {group.items.map((item) => (
                    <li key={item.id}>
                      <WaitingEntry item={item} href={hrefOf(item)} shown={item.id === shownId} onClick={onEntryClick} />
                    </li>
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
              <li key={item.id}>
                <NewsEntry item={item} href={hrefOf(item)} shown={item.id === shownId} onClick={onEntryClick} />
              </li>
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
  shown: boolean
  onClick: (event: MouseEvent<HTMLAnchorElement>, item: InboxItemView) => void
}

/** The link an entry is, or plain text when its target is gone. */
function EntryFrame({ item, href, shown, onClick, className, children }: EntryProps & { className: string; children: ReactNode }): JSX.Element {
  const frame = cn(
    'flex w-full min-w-0 rounded-control text-left outline-none transition-colors duration-snap motion-reduce:transition-none',
    'hover:bg-muted',
    shown && 'bg-accent hover:bg-accent',
    className,
  )
  if (!href) {
    return <div className={frame} data-item-id={item.id}>{children}</div>
  }
  return (
    <Link
      href={href}
      className={frame}
      aria-current={shown ? 'true' : undefined}
      data-item-id={item.id}
      data-testid="inbox-queue-entry"
      data-focus-inset=""
      onClick={(event) => onClick(event, item)}
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
  const presentation = INBOX_TYPE_PRESENTATION[item.type] ?? UNKNOWN_TYPE_PRESENTATION
  const person = presentation.icon !== 'piloti' && item.actorUserId && item.actorName ? { userId: item.actorUserId, name: item.actorName } : null
  return (
    <EntryFrame {...props} className="items-center gap-2.5 px-2 py-1.5">
      <span aria-hidden className="flex size-7 shrink-0 items-center justify-center">
        {person ? (
          <PersonAvatar person={person} size="sm" />
        ) : presentation.icon === 'piloti' ? (
          <AgentGlyph size="md" tone="outline" />
        ) : (
          // A notice from the system (the storage, the content check): nobody's face.
          <span className="size-7 rounded-full bg-muted" />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">{title}</span>
      <time className="shrink-0 text-xs tabular-nums text-muted-foreground" dateTime={item.updatedAt}>
        {formatRelativeTime(item.updatedAt, locale)}
      </time>
    </EntryFrame>
  )
}
