'use client'

/**
 * The ⌘K palette's own parts for the workspace search: the hit row's frame
 * classes, the glyph, label and aside of a palette row, the placeholder, the
 * empty and failed states, the project caption and the group heading. Split
 * from `search-atoms.tsx`, which keeps the parts the page and the palette share.
 */

import type { JSX, ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { useTranslations } from '@/i18n'
import { searchCopy } from '@/i18n/namespaces/search'
import type { TextSegment } from '@/lib/text/term-segments'
import { cn } from '@/lib/utils'
import { leadUpToMatch } from '../lib/passage-window'
import { MatchedSegments } from './match-mark'

/**
 * A hit's row inside the palette's option box. The palette sizes every glyph
 * to 16px; the shelf mark keeps its own 12px, as on the page. Under a finger
 * the row is 44px like the palette's other rows.
 */
export const PALETTE_HIT_CLASS = 'py-2 [&_svg.size-3]:size-3! pointer-coarse:min-h-11'

/**
 * Hits of an earlier question while a late answer is still on its way:
 * quieter, as the page's `ResultsBody` dims them, except the row the arrows are
 * on, which stays at full strength: it is still what Enter opens, and a dimmed
 * selection read as the whole list switched off. No ease, either way: the
 * dim waits out the late-answer threshold, so it never flickers, and an eased
 * row opacity trailed the arrows through a dimmed list by a beat on each key.
 */
export const PALETTE_STALE_CLASS = '[&_[cmdk-group-heading]]:opacity-70 [&_[cmdk-item]:not([data-selected=true])]:opacity-70'

/**
 * What the palette says when the answer is empty or failed, in the space the
 * hits would take: what was asked, and under it what the search reads, so
 * the reader can tell a word that is nowhere from a place it does not look.
 * Not an option: the way on is the row under it.
 */
export function PaletteEmpty({ title, hint, testId }: { title: ReactNode; hint?: ReactNode; testId?: string }): JSX.Element {
  return (
    <div className="flex flex-col gap-1 px-3 pt-4 pb-3" aria-live="polite">
      <p className="text-sm font-medium text-foreground" data-testid={testId}>
        {title}
      </p>
      {hint ? <p className="text-pretty text-xs leading-5 text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

/**
 * „In Wohnhaus Seestadt“: where every hit below lives, said once above them,
 * so the rows leave the project out instead of repeating it five times. A
 * caption, no glyph: with one it read as a row to open.
 */
export function PaletteScopeLine({ project, dimmed = false }: { project: string; dimmed?: boolean }): JSX.Element {
  const t = useTranslations(searchCopy)
  return (
    <p
      className={cn(
        'flex min-w-0 items-center gap-1.5 px-3 pt-2.5 pb-1.5 text-xs text-muted-foreground',
        dimmed && 'opacity-70'
      )}
      data-testid="palette-scope-line"
    >
      <span className="truncate">{t('palette.allIn', { project })}</span>
    </p>
  )
}

/** A hit group's heading: the kind, and at the end how many there are in all, the hits shown being the first few. */
export function PaletteGroupHeading({ children, count }: { children: ReactNode; count: string | null }): JSX.Element {
  return (
    <span className="flex items-baseline justify-between gap-3">
      <span>{children}</span>
      {count ? <span className="tabular-nums text-muted-foreground/80">{count}</span> : null}
    </span>
  )
}

/**
 * The palette's hits before the first answer for what is typed: three rows in
 * the hit's own geometry (glyph, name, meta line), so the panel takes the
 * results' shape at the keystroke instead of collapsing to one row and
 * springing open when the answer lands. It stands at once, as the hits that
 * replace it do: faded in, it washed the card out for the quarter second after
 * each first keystroke. While the list holds its height it fills it, its last
 * rows clipped, so „Alle Treffer“ stays at the foot rather than mid-card.
 */
export function PaletteHitsSkeleton(): JSX.Element {
  // Three kinds, three hits and one and one: about the answer a search in an
  // office usually gets, so the height the answer glides to is a short way
  // off. Its last group stretches into a held height, never past it.
  const groups = [3, 1, 1]
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-testid="palette-skeleton" aria-hidden>
      {groups.map((rows, group) => (
        <div key={group} className={cn('flex flex-col p-1', group === groups.length - 1 && 'flex-1')}>
          <Skeleton className="mx-2 mt-1.5 mb-2.5 h-3 w-20" />
          {Array.from({ length: rows }, (_, index) => (
            <div key={index} className="flex items-start gap-3 px-2 py-2">
              <Skeleton className="mt-0.5 size-4" />
              <div className="flex flex-1 flex-col gap-2 pt-0.5">
                <Skeleton className={cn('h-3.5', ['w-1/2', 'w-2/5', 'w-1/3'][(index + group) % 3])} />
                <Skeleton className={cn('h-3', ['w-3/4', 'w-3/5', 'w-2/3'][(index + group) % 3])} />
                {/* A document found by what it says has a third line, its passage. */}
                {group === 0 && index < 2 ? <Skeleton className={cn('h-3', ['w-2/3', 'w-1/2'][index])} /> : null}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

/** A palette row's glyph, in the muted ink the palette's commands use; `top` holds it on the first line of a two-line row. */
export function PaletteGlyph({ icon: Icon, top = false }: { icon: LucideIcon; top?: boolean }): JSX.Element {
  return <Icon className={cn('text-muted-foreground', top && 'mt-0.5 self-start')} aria-hidden />
}

/** A palette row's words: the label on one line, and under it, when given, one muted line saying more. */
export function PaletteLabel({ children, hint, hintTestId }: { children: ReactNode; hint?: ReactNode; hintTestId?: string }): JSX.Element {
  if (!hint) return <span className="min-w-0 flex-1 truncate">{children}</span>
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="truncate">{children}</span>
      <span className="text-pretty text-xs text-muted-foreground" data-testid={hintTestId}>
        {hint}
      </span>
    </span>
  )
}

/** At a palette row's end: a quiet state (searching, nothing found, from a colleague), announced as it changes. */
export function PaletteAside({ children, busy = false, testId }: { children: ReactNode; busy?: boolean; testId?: string }): JSX.Element {
  return (
    // At most under half the row: the row's own name keeps the room, the aside gives way first.
    <span className="ml-auto flex min-w-0 max-w-[45%] items-center gap-1.5 text-xs text-muted-foreground" aria-live="polite" data-testid={testId}>
      {busy ? <Spinner className="size-3 shrink-0" /> : null}
      <span className="truncate">{children}</span>
    </span>
  )
}

/** Where the results have no row to carry it (the composer's `#`): what the search is doing, as a line under the hits. */
export function PaletteStatusLine({ children, busy = false, testId }: { children: ReactNode; busy?: boolean; testId?: string }): JSX.Element {
  return (
    <p className="flex items-center gap-1.5 px-3 py-2 text-xs text-muted-foreground" aria-live="polite" data-testid={testId}>
      {busy ? <Spinner className="size-3" /> : null}
      {children}
    </p>
  )
}

/**
 * A passage in the palette's row: one quiet line under the meta line, the
 * page first in tabular figures, no rule and no chip (three stacked boxes per
 * hit were most of what made the list read as busy), and from a word or two
 * before the match, so the match is on the line rather than past its cut.
 */
export function CompactPassage({ segments, page }: { segments: readonly TextSegment[]; page?: string }): JSX.Element {
  const shown = leadUpToMatch(segments)
  return (
    <span className="flex min-w-0 items-baseline gap-1.5 text-xs leading-5 text-muted-foreground" data-testid="search-passage">
      {page ? <span className="shrink-0 font-medium tabular-nums text-foreground/70">{page}</span> : null}
      <span className="min-w-0 truncate">
        {shown === segments ? '„' : '„…'}
        <MatchedSegments segments={shown} testId="search-passage-match" />“
      </span>
    </span>
  )
}

/** What the words were found in, in the passage's form: the label where the page number stands, so a third line reads the same on every row. */
export function CompactMatchHint({ label, parts, testId }: { label: string; parts: readonly string[]; testId: string }): JSX.Element {
  return (
    <span className="flex min-w-0 items-baseline gap-1 text-xs leading-5 text-muted-foreground" data-testid={testId}>
      <span className="shrink-0">{label}</span>
      <span className="min-w-0 truncate font-medium text-foreground/70">{parts.join(' · ')}</span>
    </span>
  )
}
