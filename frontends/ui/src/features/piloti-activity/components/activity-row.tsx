'use client'

/**
 * One row of „Was Piloti tut": the shape every kind of row shares, so the
 * eight kinds differ in what they say and never in how a row looks.
 *
 * Left to right: the kind's mark, what it is and where, the state as a chip,
 * when, and the actions. On a phone the state, time and actions drop under the
 * text rather than squeezing it (a row's title is what a reader scans).
 */

import type { JSX, ReactNode } from 'react'
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item'
import { TimeAgo } from '@/components/ui/time-ago'
import { useLocale } from '@/i18n'

export interface ActivityRowProps {
  /** The kind's mark: Piloti's glyph for its own work, an icon for a run. */
  media: ReactNode
  title: string
  /** One muted line: where, how it began, for whom. */
  description: string
  /** Further muted lines under the description (a mark's text, a run's error). */
  details?: readonly string[]
  /** The row's state; a chip. */
  state?: ReactNode
  /** When it happened or began (ISO). */
  at: string
  /** Buttons and links. */
  actions?: ReactNode
  'data-testid'?: string
}

export function ActivityRow({
  media,
  title,
  description,
  details = [],
  state,
  at,
  actions,
  'data-testid': testId,
}: ActivityRowProps): JSX.Element {
  const { locale } = useLocale()
  return (
    <Item as="li" className="flex-wrap items-start sm:flex-nowrap" data-testid={testId}>
      <ItemMedia>{media}</ItemMedia>
      <ItemContent className="basis-[calc(100%-2.75rem)] sm:basis-0">
        <ItemTitle title={title}>{title}</ItemTitle>
        <ItemDescription title={description}>{description}</ItemDescription>
        {details.map((line) => (
          <ItemDescription key={line} title={line}>
            {line}
          </ItemDescription>
        ))}
      </ItemContent>
      <ItemActions className="max-sm:w-full max-sm:flex-wrap max-sm:justify-start max-sm:pl-11 sm:flex-wrap sm:justify-end">
        {state}
        <TimeAgo date={at} locale={locale} className="text-muted-foreground text-xs tabular-nums" />
        {actions}
      </ItemActions>
    </Item>
  )
}
