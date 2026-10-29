'use client'

/**
 * The line under an inbox row's title: where (the project, the chat), then
 * what stands (by when, what is left to check, answered, gone). Facts as
 * words with an icon, coloured only where they are late or near: pills in
 * four tints on every row were the loudest thing on the page and said the
 * least.
 *
 * One line at any width, where only the project's name gives way. On a phone
 * the moment heads it, because there the title needs the width the moment
 * takes at the title line's end.
 */

import type { JSX, ReactNode } from 'react'
import { Fragment } from 'react'
import { CheckCircle2, Clock, EyeOff } from 'lucide-react'

import { useLocale, useTranslations } from '@/i18n'
import { collaborationCopy } from '@/i18n/namespaces/collaboration'
import { formatRelativeTime } from '@/lib/format'
import type { InboxItemView } from '@/lib/inbox/types'
import { cn } from '@/lib/utils'

/** By when, worded by the row: a passed date (`danger`), a near one (`warning`), or a plain date. */
export interface InboxDue {
  label: string
  variant: 'danger' | 'warning' | 'secondary'
}

export interface InboxItemCaptionProps {
  item: InboxItemView
  /** The chat it happened in, where nothing else on the row names it. */
  place: string | null
  /** What a new Fassung leaves to check, where its sentence gave way to the quote. */
  openMarks: number
  due: InboxDue | null
  /** A request that has been answered. */
  answered: boolean
}

export function InboxItemCaption({ item, place, openMarks, due, answered }: InboxItemCaptionProps): JSX.Element {
  const t = useTranslations(collaborationCopy)
  const { locale } = useLocale()
  const inert = item.state === 'inert'

  const parts: { key: string; node: ReactNode }[] = [
    {
      key: 'when',
      node: (
        <time className="shrink-0 tabular-nums sm:hidden" dateTime={item.updatedAt}>
          {formatRelativeTime(item.updatedAt, locale)}
        </time>
      ),
    },
    ...(item.projectName && !inert
      ? [{ key: 'project', node: <span className="min-w-0 truncate" data-testid="inbox-item-project">{item.projectName}</span> }]
      : []),
    ...(place ? [{ key: 'place', node: <span className="min-w-0 truncate" data-testid="inbox-item-place">{place}</span> }] : []),
    ...(due
      ? [{
          key: 'due',
          node: (
            <span
              data-testid="inbox-item-due"
              className={cn(
                'inline-flex shrink-0 items-center gap-1',
                due.variant === 'danger' && 'font-medium text-error',
                due.variant === 'warning' && 'font-medium text-warning',
              )}
            >
              <Clock className="size-3" aria-hidden />
              {due.label}
            </span>
          ),
        }]
      : []),
    ...(openMarks > 0
      ? [{ key: 'marks', node: <span className="shrink-0" data-testid="inbox-item-open-marks">{t('inbox.openMarks', { count: openMarks })}</span> }]
      : []),
    ...(answered
      ? [{
          key: 'answered',
          node: (
            <span className="inline-flex shrink-0 items-center gap-1 text-success">
              <CheckCircle2 className="size-3" aria-hidden />
              {t('inbox.resolved')}
            </span>
          ),
        }]
      : []),
    // The one place a redacted row says so; the body already says it in a sentence.
    ...(inert
      ? [{
          key: 'inert',
          node: (
            <span className="inline-flex shrink-0 items-center gap-1">
              <EyeOff className="size-3" aria-hidden />
              {t('inbox.inert')}
            </span>
          ),
        }]
      : []),
  ]

  // Nothing to place the row: the line holds the phone's moment alone.
  if (parts.length === 1) return <p className="mt-0.5 text-xs text-muted-foreground sm:hidden">{parts[0].node}</p>

  return (
    <p
      className="mt-0.5 flex min-w-0 items-center gap-x-1.5 overflow-hidden whitespace-nowrap text-xs text-muted-foreground"
      data-testid="inbox-item-meta"
    >
      {parts.map((part, index) => (
        <Fragment key={part.key}>
          {/* The first separator follows the phone's moment, and goes with it. */}
          {index > 0 && <span aria-hidden className={cn('shrink-0', index === 1 && 'sm:hidden')}>·</span>}
          {part.node}
        </Fragment>
      ))}
    </p>
  )
}
