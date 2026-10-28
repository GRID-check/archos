'use client'

import type { ComponentProps, JSX, ReactNode } from 'react'
import { MoreHorizontal, Sparkles } from 'lucide-react'
import { ActionMenu, type ActionMenuEntry } from '@/components/ui/action-menu'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { MiddleTruncate } from '@/components/ui/middle-truncate'
import { DEFAULT_TAIL_LENGTH } from '@/lib/text/middle-truncate'
import { cn } from '@/lib/utils'
import { Quote } from '@/components/ui/quote'
import { changeLines } from '@/lib/documents/revision-timeline'

export interface RevisionTimelineRowProps {
  /** „Fassung 3": what the row is called. Unambiguous on its own, never „Diese Fassung". */
  label: string
  /** „Index C" or „Stand 14.08.2026", beside the label, when the name or title block says one. */
  tag?: string | null
  /** „aktuell", on the one Fassung Piloti answers from, and nowhere else. */
  marker?: string | null
  /** A state worth saying on this row (In Prüfung, Abgelehnt …). Never „Ersetzt": every older row is older. */
  badge?: ReactNode
  /** The newest Fassung: its dot is ink, every other one quiet. */
  newest?: boolean
  /** The row's own file, when it is another document than the one open. Middle-truncated: the index and extension survive. */
  filename?: string | null
  /**
   * Characters of the file name kept whole at its end: from where it first
   * differs from the open document's name (`distinguishingTailLength`), so the
   * index survives the cut.
   */
  filenameTail?: number
  /** Who did what and when, one line each („Hochgeladen von Anna Berger · 14.08.2026"). Already worded; never a raw id. */
  acts?: readonly string[]
  /** The reviewer's words, quoted on the Fassung they are about. */
  comment?: string | null
  /** „Geändert gegenüber Fassung 2:" above the change lines. */
  changeCaption?: string | null
  /** What changed in it, as the model wrote it (bullet lines). */
  change?: string | null
  /** Under the change lines: that Piloti read them, and that a person checks the values. */
  changeHint?: string | null
  changeTestId?: string
  /** The ONE visible action (Öffnen). Everything else is in {@link menu}. */
  action?: ReactNode
  /** Herunterladen, Vergleichen, Verknüpfung lösen: behind the row's ⋯. */
  menu?: readonly ActionMenuEntry[]
  /** The ⋯ button's accessible name („Weitere Aktionen zu Fassung 3"). */
  menuLabel?: string
  /** Under the row's own content: a text comparison. */
  children?: ReactNode
  /** The last row draws no line below its dot. */
  last?: boolean
  /** `data-*` the specs and the preview read the row by. */
  dataset?: Readonly<Record<string, string | undefined>>
}

/**
 * One Fassung in the timeline: its number, its index, who did what and when,
 * what changed in it, one visible action and a ⋯ for the rest. The rail is
 * 248px of content, so every fact appears once: the date is on the act line,
 * the file name only where it is another document, the state only where it is
 * worth a word.
 *
 * Presentational. Which rows exist and in which order is `lib/documents/revision-timeline.ts`;
 * what the actions do belongs to `document-revisions.tsx`.
 */
export function RevisionTimelineRow({
  label,
  tag,
  marker,
  badge,
  newest = false,
  filename,
  filenameTail = DEFAULT_TAIL_LENGTH,
  acts = [],
  comment,
  changeCaption,
  change,
  changeHint,
  changeTestId = 'revision-row-change',
  action,
  menu = [],
  menuLabel,
  children,
  last = false,
  dataset = {},
}: RevisionTimelineRowProps): JSX.Element {
  const data = Object.fromEntries(Object.entries(dataset).map(([key, value]) => [`data-${key}`, value]))
  return (
    <li className="relative flex gap-2.5 pb-3 last:pb-0" data-testid="revision-timeline-row" {...data}>
      <span aria-hidden className="relative flex w-2 shrink-0 justify-center">
        <span className={cn('mt-1.5 size-2 rounded-full', newest ? 'bg-foreground' : 'bg-muted-foreground/50')} />
        {/* Dot to dot: from under this one, through the row's padding, to the top of the next. */}
        {!last && <span className="bg-border absolute top-3.5 -bottom-[18px] w-px" />}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-start gap-1">
          <p className="text-foreground flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[13px] leading-snug">
            <span className="font-medium whitespace-nowrap" data-testid="revision-row-label">
              {label}
            </span>
            {marker && (
              <Badge variant="outline" className="bg-background px-1.5 py-0 text-[11px]" data-testid="revision-row-current">
                {marker}
              </Badge>
            )}
            {badge}
            {/* Last, so a crowded line wraps the tag, not the marker. */}
            {tag && (
              <span className="text-muted-foreground text-xs whitespace-nowrap" data-testid="revision-row-tag">
                {tag}
              </span>
            )}
          </p>
          {/* The one visible action, on the title line: a row of its own per
              Fassung was a fifth of the timeline's height. */}
          {action && <span className="-my-0.5 flex shrink-0 items-center">{action}</span>}
          {menu.length > 0 && (
            <ActionMenu
              mode="dropdown"
              entries={menu}
              trigger={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground hover:text-foreground -my-1 size-6 shrink-0"
                  aria-label={menuLabel}
                  title={menuLabel}
                  data-testid="revision-row-menu"
                >
                  <MoreHorizontal className="size-4" aria-hidden />
                </Button>
              }
            />
          )}
        </div>
        {filename && <MiddleTruncate text={filename} tail={filenameTail} className="text-muted-foreground text-xs" />}
        {acts.length > 0 && (
          <div className="flex flex-col gap-0.5">
            {acts.map((act) => (
              <p key={act} className="text-muted-foreground text-xs leading-snug" data-testid="revision-row-act">
                {act}
              </p>
            ))}
          </div>
        )}
        {comment && (
          <Quote as="p" className="text-xs leading-[1.5]" data-testid="document-version-comment">
            {comment}
          </Quote>
        )}
        {change && (
          <div className="flex flex-col gap-1" data-testid={changeTestId}>
            {changeCaption && <p className="text-muted-foreground text-xs">{changeCaption}</p>}
            <ChangeList text={change} />
            {changeHint && (
              <p className="text-muted-foreground flex gap-1 text-[11px] leading-snug" data-testid="revision-change-hint">
                <Sparkles className="mt-px size-3 shrink-0" aria-hidden />
                <span>{changeHint}</span>
              </p>
            )}
          </div>
        )}
        {children}
      </div>
    </li>
  )
}

function ChangeList({ text }: { text: string }): JSX.Element {
  return (
    <ul className="text-foreground flex flex-col gap-0.5 text-xs leading-snug">
      {changeLines(text).map((line, index) => (
        <li key={index} className="before:text-muted-foreground flex gap-1.5 before:content-['–']">
          {line}
        </li>
      ))}
    </ul>
  )
}

/** The quiet link-button a row's one visible action is. 44px catchment under a finger. */
export function RowAction({
  children,
  asChild,
  ...props
}: Omit<ComponentProps<typeof Button>, 'variant' | 'size' | 'className'>): JSX.Element {
  return (
    <Button
      // A link (`asChild`) is not a form button: no `type` on an anchor.
      type={asChild ? undefined : 'button'}
      asChild={asChild}
      variant="link"
      size="sm"
      className="text-muted-foreground hover:text-foreground touch-target h-auto px-1 py-0.5 text-xs pointer-coarse:h-auto"
      {...props}
    >
      {children}
    </Button>
  )
}
