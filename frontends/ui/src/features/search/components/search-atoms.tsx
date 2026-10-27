'use client'

/**
 * The search's own atoms: the parts the search organisms are built from, and
 * the only file under `features/search` that writes Tailwind.
 *
 * Each owns one decision. The frame decides where the rail sits (beside the
 * results from `md`, in a bottom sheet behind „Filter“ under it) and that a hairline,
 * not a box, separates the two; a facet option is one dense row that toggles
 * and counts in tabular figures; a result row is the product's list row
 * (`Item`) as a link, the name in the strong weight and everything else on one
 * muted meta line; the register is a table whose header stays put while its
 * rows scroll. The organisms arrange them and never style them.
 */

import type { JSX, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import type { LucideIcon } from 'lucide-react'
import { Archive, ChevronRight, FolderKanban, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Chip, ChipLabel } from '@/components/ui/chip'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { FOCUS_RING_INSET } from '@/components/ui/focus-ring'
import { HorizontalScroll } from '@/components/ui/horizontal-scroll'
import { Item, ItemContent, ItemMedia } from '@/components/ui/item'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { SectionLabel } from '@/components/ui/section-label'
import { Skeleton } from '@/components/ui/skeleton'
import { SortableHead } from '@/components/ui/sortable-head'
import { Spinner } from '@/components/ui/spinner'
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { TextSegment } from '@/lib/text/term-segments'
import { sourceTint } from '@/lib/ui/source-tint'
import { cn } from '@/lib/utils'

// ─── Frame ──────────────────────────────────────────────────────────────────

/**
 * The page: the toolbar and the chips on top, the rail beside the results with
 * a hairline between. Under `md` there is no rail beside anything: it opens
 * in the filter sheet (`FilterSheet`), so the first result stays under the
 * field instead of a screen of counts further down. `rail` is null there.
 */
export function SearchFrame({ toolbar, rail, children }: { toolbar: ReactNode; rail: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="search-frame">
      <div className="flex min-w-0 flex-col gap-3">{toolbar}</div>
      <div className="flex min-w-0 flex-col gap-6 md:grid md:grid-cols-[14rem_minmax(0,1fr)] md:items-start md:gap-0">
        {rail ? (
          <aside
            className="hidden min-w-0 flex-col gap-1 md:sticky md:top-4 md:flex md:max-h-[calc(100dvh-2rem)] md:overflow-y-auto md:border-r md:pr-3"
            data-testid="search-rail"
          >
            {rail}
          </aside>
        ) : null}
        <div className="flex min-w-0 flex-col gap-3 md:pl-6">{children}</div>
      </div>
    </div>
  )
}

/**
 * The rail on a phone: the kit's bottom sheet (a `Dialog`, which below `sm`
 * anchors to the bottom edge with a grabber and a pinned footer), the facets
 * and filters scrolling under a fixed title, and two actions where the thumb
 * is: take every filter off, and go back to the answer with its size on the
 * button. Filters apply as they are set, so closing it discards nothing.
 */
export function FilterSheet({
  open,
  onOpenChange,
  title,
  description,
  closeLabel,
  clearLabel,
  onClear,
  canClear,
  showLabel,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  closeLabel: string
  clearLabel: string
  onClear: () => void
  canClear: boolean
  /** „14 Treffer zeigen“. */
  showLabel: string
  children: ReactNode
}): JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={closeLabel} data-testid="search-filter-sheet">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="sr-only">{description}</DialogDescription>
        </DialogHeader>
        <div className="-mx-1 flex min-w-0 flex-col gap-1" data-testid="search-rail">
          {children}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClear} disabled={!canClear} data-testid="search-sheet-clear">
            {clearLabel}
          </Button>
          <Button type="button" onClick={() => onOpenChange(false)} data-testid="search-sheet-show">
            {showLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The row with the field: the field takes the room, the controls group at the right and wrap under it on a phone. */
export function SearchToolbar({ field, controls }: { field: ReactNode; controls: ReactNode }): JSX.Element {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2" data-testid="search-toolbar">
      <div className="min-w-0 flex-[1_1_20rem]">{field}</div>
      <div className="flex flex-wrap items-center gap-2">{controls}</div>
    </div>
  )
}

/** A toolbar button's words: hidden on a phone, where the icon and the accessible name carry it. */
export function ToolbarLabel({ children }: { children: ReactNode }): JSX.Element {
  return <span className="max-sm:sr-only">{children}</span>
}

/** The shortcut that focuses the field, inside it: ⌘ K or Strg K. (`SearchField` hides it on a phone and under a finger.) */
export function FieldShortcut({ modifier }: { modifier: string }): JSX.Element {
  return (
    <KbdGroup>
      <Kbd>{modifier}</Kbd>
      <Kbd>K</Kbd>
    </KbdGroup>
  )
}

/** A hint about keys, in a status line: gone under a finger. */
export function KeysHint({ children }: { children: ReactNode }): JSX.Element {
  return <span className="pointer-coarse:hidden">{children}</span>
}

/**
 * A row of choices that may be wider than the column (the kinds with their
 * counts, on a phone): it scrolls sideways, and the edge that hides one says
 * so with a fade.
 */
export function ChoiceStrip({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <HorizontalScroll aria-label={label} className="-mx-1 px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {children}
    </HorizontalScroll>
  )
}

// ─── Rail ───────────────────────────────────────────────────────────────────

/** A group of the rail: its name folds it, so a long rail is read one group at a time. */
export function RailSection({
  title,
  children,
  testId,
  defaultOpen = true,
  fixed = false,
}: {
  title: string
  children: ReactNode
  testId?: string
  defaultOpen?: boolean
  /** Always open, its name a plain heading: the group the rail starts with. */
  fixed?: boolean
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  if (fixed) {
    return (
      <section className="flex min-w-0 flex-col border-b border-border/60 py-2 last:border-b-0" data-testid={testId}>
        <div className="flex h-7 items-center px-1">
          <SectionLabel as="h3">{title}</SectionLabel>
        </div>
        <div className="flex min-w-0 flex-col pt-0.5">{children}</div>
      </section>
    )
  }
  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <section className="flex min-w-0 flex-col border-b border-border/60 py-2 last:border-b-0" data-testid={testId}>
        <CollapsibleTrigger
          className={cn('group flex h-7 w-full items-center gap-1 rounded-sm px-1 text-left', FOCUS_RING_INSET)}
          data-testid={testId ? `${testId}-toggle` : undefined}
        >
          <ChevronRight
            className="size-3 shrink-0 text-muted-foreground transition-transform duration-quick ease-out group-data-[state=open]:rotate-90 motion-reduce:transition-none"
            aria-hidden
          />
          <SectionLabel as="h3">{title}</SectionLabel>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="flex min-w-0 flex-col pt-0.5">{children}</div>
        </CollapsibleContent>
      </section>
    </Collapsible>
  )
}

/** One filter value with its count: a click switches it on or off. */
export function FacetOption({
  label,
  count,
  active,
  onToggle,
  testId,
}: {
  label: string
  count: number
  active: boolean
  onToggle: () => void
  testId?: string
}): JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onToggle}
      data-testid={testId}
      className={cn(
        // A long name (a project's address) wraps to a second line rather than
        // ending in an ellipsis whose rest only a tooltip knew.
        'flex min-h-7 w-full min-w-0 items-start gap-2 rounded-sm px-1 py-1 text-left text-sm leading-5 transition-colors duration-snap ease-out motion-reduce:transition-none pointer-coarse:min-h-11 pointer-coarse:items-center',
        FOCUS_RING_INSET,
        active ? 'bg-secondary font-medium text-foreground' : 'text-foreground/80 hover:bg-secondary/60 hover:text-foreground'
      )}
    >
      <span
        className={cn(
          'mt-[3px] flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border transition-colors duration-snap pointer-coarse:mt-0',
          active ? 'border-foreground bg-foreground text-background' : 'border-strong bg-background'
        )}
        aria-hidden
      >
        {active ? (
          <svg viewBox="0 0 12 12" className="size-2.5" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M2.5 6.5 5 9l4.5-5.5" />
          </svg>
        ) : null}
      </span>
      <span className="line-clamp-2 min-w-0 flex-1 break-words" title={label.length > 48 ? label : undefined}>
        {label}
      </span>
      <span className="shrink-0 text-xs leading-5 tabular-nums text-muted-foreground">{count}</span>
    </button>
  )
}

/** A control under a rail group or a form, at its own width: „Alle zeigen“, „Hinzufügen“. */
export function RailAction({ children }: { children: ReactNode }): JSX.Element {
  return <div className="flex min-w-0 flex-wrap items-center gap-2 px-1">{children}</div>
}

/** The typed filters' column. */
export function RailBody({ children }: { children: ReactNode }): JSX.Element {
  return <div className="flex min-w-0 flex-col gap-3 px-1 pb-2 pt-1">{children}</div>
}

/** Two fields one above the other: a date's from and to, which do not fit side by side in the rail. */
export function FieldStack({ children }: { children: ReactNode }): JSX.Element {
  return <div className="flex min-w-0 flex-col gap-2">{children}</div>
}

/** Two short fields side by side: min and max, role and name. */
export function FieldPair({ children }: { children: ReactNode }): JSX.Element {
  return <div className="grid min-w-0 grid-cols-2 gap-2">{children}</div>
}

// ─── Above the results ──────────────────────────────────────────────────────

/** The filters that are set, each a chip that takes itself off. */
export function ActiveFilters({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5" data-testid="search-active-filters">
      {children}
    </div>
  )
}

export function RemovableChip({ label, removeLabel, onRemove }: { label: string; removeLabel: string; onRemove: () => void }): JSX.Element {
  return (
    <Chip asChild variant="secondary" interactive size="md">
      <button type="button" onClick={onRemove} aria-label={removeLabel} title={label}>
        <ChipLabel>{label}</ChipLabel>
        <X aria-hidden />
      </button>
    </Chip>
  )
}

/** The answer's size and state, read out when it changes: „18 Treffer“, „Sucht…“. */
export function ResultsStatus({ children, busy }: { children: ReactNode; busy: boolean }): JSX.Element {
  return (
    <p className="flex min-h-5 items-center gap-2 text-xs tabular-nums text-muted-foreground" role="status" aria-live="polite" data-testid="search-status">
      {busy ? <Spinner size="xs" aria-hidden /> : null}
      {children}
    </p>
  )
}

/** A note about the answer, not an error: facts still being read, content searched in part. A quiet line, not a box. */
export function SearchNote({ children, icon: Icon, testId }: { children: ReactNode; icon: LucideIcon; testId?: string }): JSX.Element {
  return (
    <p className="flex items-start gap-1.5 text-pretty text-xs text-muted-foreground" data-testid={testId}>
      <Icon className="mt-px size-3.5 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  )
}

/** The actions under an empty answer, side by side, wrapping on a phone. */
export function EmptyActions({ children }: { children: ReactNode }): JSX.Element {
  return <div className="flex flex-wrap items-center justify-center gap-2">{children}</div>
}

/** The kinds as a row of choices with their counts. */
export function KindCount({ children }: { children: ReactNode }): JSX.Element {
  return <span className="ml-1 tabular-nums text-muted-foreground">{children}</span>
}

// ─── Result list ────────────────────────────────────────────────────────────

/** One kind's results: its name and count over the rows, „Mehr“ under them. */
export function ResultSection({
  title,
  count,
  children,
  footer,
  testId,
}: {
  title: string
  count: string
  children: ReactNode
  footer?: ReactNode
  testId?: string
}): JSX.Element {
  return (
    <section className="flex min-w-0 flex-col" data-testid={testId}>
      <header className="flex items-baseline gap-2 pb-1.5">
        <SectionLabel as="h2">{title}</SectionLabel>
        <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
      </header>
      <ul className="flex min-w-0 flex-col divide-y divide-border/70 border-y border-border/70">{children}</ul>
      {footer}
    </section>
  )
}

/** One hit: an icon, its name in the strong weight, one muted line of where and what, what matched under it. */
export function ResultRow({
  href,
  icon: Icon,
  title,
  meta,
  aside,
  children,
  active = false,
  testId,
}: {
  href: string
  icon: LucideIcon
  title: ReactNode
  /** One line: „Projekt · Ordner · EP-03 · Index C · 14.10.2026“. */
  meta?: ReactNode
  /** At the row's end: where it is kept (`ShelfMark`), a state. */
  aside?: ReactNode
  /** The passage, the excerpt. */
  children?: ReactNode
  /** The row the arrow keys are on. */
  active?: boolean
  testId?: string
}): JSX.Element {
  const ref = useRef<HTMLAnchorElement>(null)
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [active])
  return (
    <li className="list-none">
      <Item asChild className="items-start gap-x-3 gap-y-1.5 px-2 py-2.5 max-sm:flex-wrap">
        <Link ref={ref} href={href} data-testid={testId} aria-current={active ? 'true' : undefined}>
          <ItemMedia className="size-5 pt-0.5 text-muted-foreground">
            <Icon className="size-4" aria-hidden />
          </ItemMedia>
          <ItemContent className="flex flex-col gap-0.5">
            <span className="truncate text-sm font-semibold tracking-tight text-foreground">{title}</span>
            {meta ? <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">{meta}</span> : null}
            {children}
          </ItemContent>
          {aside ? <span className="ml-auto flex shrink-0 items-center gap-1.5 pt-0.5 max-sm:ml-8 max-sm:basis-full max-sm:pt-0">{aside}</span> : null}
        </Link>
      </Item>
    </li>
  )
}

/** A part of the meta line; identifiers (Plannummer, Index, Maßstab) in the mono face, as the design language sets them. */
export function MetaPart({ children, code = false }: { children: ReactNode; code?: boolean }): JSX.Element {
  return <span className={cn('whitespace-nowrap', code && 'font-mono text-xs text-foreground/80')}>{children}</span>
}

/** The meta line's parts that are there, a dot between each. */
export function MetaLine({ parts }: { parts: ReadonlyArray<ReactNode | null | undefined | false> }): JSX.Element {
  const present = parts.filter((part): part is ReactNode => Boolean(part))
  return (
    <>
      {present.map((part, index) => (
        <span key={index} className="contents">
          {index > 0 ? (
            <span className="text-muted-foreground/60" aria-hidden>
              ·
            </span>
          ) : null}
          {part}
        </span>
      ))}
    </>
  )
}

/** Where a hit is kept, by the provenance signal: icon, label and colour together. */
export function ShelfMark({ shelf, label }: { shelf: 'project' | 'office_shelf'; label: string }): JSX.Element {
  const Icon = shelf === 'office_shelf' ? Archive : FolderKanban
  return (
    <span
      className="inline-flex h-5 max-w-40 items-center gap-1 rounded-md px-1.5 text-xs font-medium"
      style={sourceTint(shelf === 'office_shelf' ? 'office' : 'project')}
      title={label}
    >
      <Icon className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{label}</span>
    </span>
  )
}

/** A short state beside a hit: Ersetzt, Offen, Mangel. */
export function HitBadge({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'warning' | 'outline' }): JSX.Element {
  return (
    <Chip size="sm" variant={tone}>
      {children}
    </Chip>
  )
}

/** The words that matched, set apart by weight on a faint ink wash, with the page they are on. */
export function PassageQuote({ segments, page }: { segments: readonly TextSegment[]; page?: string }): JSX.Element {
  return (
    <p className="mt-1 flex min-w-0 items-baseline gap-2 text-sm leading-relaxed text-foreground/80" data-testid="search-passage">
      <span className="line-clamp-2 min-w-0 text-pretty">
        „
        {segments.map((segment, index) =>
          segment.match ? (
            <mark key={index} className="rounded-[2px] bg-foreground/[0.07] px-px font-semibold text-foreground">
              {segment.text}
            </mark>
          ) : (
            <span key={index}>{segment.text}</span>
          )
        )}
        “
      </span>
      {page ? (
        <Chip size="sm" variant="outline">
          {page}
        </Chip>
      ) : null}
    </p>
  )
}

/** A plain excerpt (an annotation's body, a folder's description). */
export function Excerpt({ children }: { children: ReactNode }): JSX.Element {
  return <p className="mt-0.5 line-clamp-2 text-pretty text-sm text-foreground/75">{children}</p>
}

/** The shape of the first answer while it is on its way. */
export function ResultsSkeleton({ rows = 6 }: { rows?: number }): JSX.Element {
  return (
    <div className="flex flex-col divide-y divide-border/70 border-y border-border/70" data-testid="search-skeleton" aria-hidden>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-start gap-3 px-2 py-3">
          <Skeleton className="size-4" />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-3.5 w-2/5" />
            <Skeleton className="h-3 w-3/5" />
          </div>
        </div>
      ))}
    </div>
  )
}

/** The results while a newer answer is read: they stay, quieter, so the page does not jump. */
export function ResultsBody({ stale, children }: { stale: boolean; children: ReactNode }): JSX.Element {
  return (
    <div
      className={cn('flex min-w-0 flex-col gap-6 transition-opacity duration-quick motion-reduce:transition-none', stale && 'opacity-60')}
      aria-busy={stale || undefined}
      data-testid="search-results"
    >
      {children}
    </div>
  )
}

// ─── Register ───────────────────────────────────────────────────────────────

/** The register's box: it scrolls, so the header row can stay put above the rows. */
export function RegisterTable({ children, caption, testId }: { children: ReactNode; caption: string; testId?: string }): JSX.Element {
  return (
    <div className="max-h-[calc(100dvh-12rem)] min-w-0 overflow-auto border-y border-border/70" data-testid={testId}>
      <table className="w-full caption-bottom border-separate border-spacing-0 text-sm">
        <caption className="py-2 text-left text-xs text-muted-foreground">{caption}</caption>
        {children}
      </table>
    </div>
  )
}

export function RegisterHead({ children }: { children: ReactNode }): JSX.Element {
  return (
    <TableHeader className="sticky top-0 z-10 bg-background [&_th]:border-b [&_th]:border-border/70 [&_tr]:border-b-0">
      <TableRow className="hover:bg-transparent">{children}</TableRow>
    </TableHeader>
  )
}

/** A header cell; a sortable one is the kit's `SortableHead`. Figures align right, as their column does. */
export function RegisterHeadCell({
  label,
  numeric = false,
  sort,
}: {
  label: string
  numeric?: boolean
  sort?: { ariaLabel: string; direction: 'asc' | 'desc' | null; onSort: () => void }
}): JSX.Element {
  const className = cn('h-8 whitespace-nowrap px-2', numeric && 'text-right')
  if (!sort) return <TableHead className={className}>{label}</TableHead>
  return (
    <SortableHead
      className={className}
      label={label}
      ariaLabel={sort.ariaLabel}
      active={sort.direction !== null}
      direction={sort.direction ?? 'asc'}
      onSort={sort.onSort}
    />
  )
}

export function RegisterBody({ children }: { children: ReactNode }): JSX.Element {
  return <TableBody>{children}</TableBody>
}

export function RegisterRow({ children, active = false, testId }: { children: ReactNode; active?: boolean; testId?: string }): JSX.Element {
  const ref = useRef<HTMLTableRowElement>(null)
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [active])
  return (
    <TableRow
      ref={ref}
      data-state={active ? 'selected' : undefined}
      aria-selected={active || undefined}
      className="h-9 border-b-0 even:bg-secondary/30 [&>td]:border-b [&>td]:border-border/50"
      data-testid={testId}
    >
      {children}
    </TableRow>
  )
}

/** A cell: one line, cut with an ellipsis; figures right-aligned in tabular digits, identifiers in the mono face. */
export function RegisterCell({
  children,
  kind = 'text',
  title,
}: {
  children?: ReactNode
  kind?: 'text' | 'strong' | 'code' | 'figure' | 'muted'
  title?: string
}): JSX.Element {
  return (
    <TableCell
      className={cn(
        'max-w-40 truncate px-2 py-1.5',
        kind === 'strong' && 'max-w-64 font-medium text-foreground',
        kind === 'code' && 'whitespace-nowrap font-mono text-xs',
        kind === 'figure' && 'whitespace-nowrap text-right tabular-nums',
        kind === 'muted' && 'whitespace-nowrap tabular-nums text-muted-foreground',
        kind === 'text' && 'text-foreground/80'
      )}
      title={title}
    >
      {children}
    </TableCell>
  )
}

/** The register's name cell: a link that opens the document. */
export function RegisterLink({ href, children }: { href: string; children: ReactNode }): JSX.Element {
  return (
    <Link href={href} className={cn('rounded-sm hover:underline', FOCUS_RING_INSET)}>
      {children}
    </Link>
  )
}

// ─── Saved searches ─────────────────────────────────────────────────────────

/** A saved search in the list: its name applies it, the controls after it share or delete it. */
export function SavedSearchRow({
  name,
  detail,
  onApply,
  controls,
}: {
  name: string
  detail?: string
  onApply: () => void
  controls?: ReactNode
}): JSX.Element {
  return (
    <li className="flex min-w-0 list-none items-center gap-2 py-1.5">
      <button
        type="button"
        onClick={onApply}
        className={cn('min-w-0 flex-1 rounded-sm text-left', FOCUS_RING_INSET)}
        data-testid="saved-search-apply"
      >
        <span className="block truncate text-sm font-medium text-foreground">{name}</span>
        {detail ? <span className="block truncate text-xs text-muted-foreground">{detail}</span> : null}
      </button>
      {controls ? <div className="flex shrink-0 items-center gap-1">{controls}</div> : null}
    </li>
  )
}

export function SavedSearchList({ children }: { children: ReactNode }): JSX.Element {
  return <ul className="flex max-h-72 min-w-0 flex-col divide-y overflow-y-auto">{children}</ul>
}

/** A popover's body: a heading line and what follows. */
export function PanelBody({ children }: { children: ReactNode }): JSX.Element {
  return <div className="flex min-w-0 flex-col gap-3">{children}</div>
}

/** A line of muted text where a list would be. */
export function QuietLine({ children }: { children: ReactNode }): JSX.Element {
  return <p className="text-sm text-muted-foreground">{children}</p>
}

/** The search inside a shelf's own frame (Dateien, Büroablage), which lends no page padding. */
export function SearchInset({ children }: { children: ReactNode }): JSX.Element {
  return <div className="min-w-0 px-4 py-4 md:px-6">{children}</div>
}
