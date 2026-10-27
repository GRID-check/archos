'use client'

/**
 * The search's own atoms: the parts the search organisms are built from, and
 * the only file under `features/search` that writes Tailwind.
 *
 * Each owns one decision. The frame decides where the rail sits (beside the
 * results from `md`, folded behind „Filter“ under it) and that a hairline,
 * not a box, separates the two; a facet option is one dense row that toggles
 * and counts in tabular figures; a result row is the product's list row
 * (`Item`) as a link, the name in the strong weight and everything else on one
 * muted meta line; the register is a table whose header stays put while its
 * rows scroll. The organisms arrange them and never style them.
 */

import type { FormEvent, JSX, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import type { LucideIcon } from 'lucide-react'
import { Archive, ChevronRight, Folder, FolderKanban, History, Users, X } from 'lucide-react'

import { Chip, ChipLabel } from '@/components/ui/chip'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { FOCUS_RING_INSET } from '@/components/ui/focus-ring'
import { Item, ItemContent, ItemMedia } from '@/components/ui/item'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { SectionLabel } from '@/components/ui/section-label'
import { Skeleton } from '@/components/ui/skeleton'
import { SortableHead } from '@/components/ui/sortable-head'
import { Spinner } from '@/components/ui/spinner'
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useTranslations } from '@/i18n'
import type { TextSegment } from '@/lib/text/term-segments'
import { sourceTint } from '@/lib/ui/source-tint'
import { cn } from '@/lib/utils'

// ─── Frame ──────────────────────────────────────────────────────────────────

/** The page: the toolbar and the chips on top, the rail beside the results with a hairline between. */
export function SearchFrame({
  toolbar,
  rail,
  railOpen,
  children,
}: {
  toolbar: ReactNode
  rail: ReactNode
  /** Under `md` the rail is folded away until the reader opens it. */
  railOpen: boolean
  children: ReactNode
}): JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="search-frame">
      <div className="flex min-w-0 flex-col gap-3">{toolbar}</div>
      <div className="flex min-w-0 flex-col gap-6 md:grid md:grid-cols-[14rem_minmax(0,1fr)] md:items-start md:gap-0">
        <aside
          className={cn(
            'min-w-0 flex-col gap-1 md:sticky md:top-4 md:flex md:max-h-[calc(100dvh-2rem)] md:overflow-y-auto md:border-r md:pr-3',
            railOpen ? 'flex' : 'hidden'
          )}
          data-testid="search-rail"
        >
          {rail}
        </aside>
        <div className="flex min-w-0 flex-col gap-3 md:pl-6">{children}</div>
      </div>
    </div>
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

/** The shortcut that focuses the field, inside it: ⌘ K or Strg K. */
export function FieldShortcut({ modifier }: { modifier: string }): JSX.Element {
  return (
    <KbdGroup>
      <Kbd>{modifier}</Kbd>
      <Kbd>K</Kbd>
    </KbdGroup>
  )
}

/** Shown only under `md`, where the rail is folded. */
export function RailToggleSlot({ children }: { children: ReactNode }): JSX.Element {
  return <div className="md:hidden">{children}</div>
}

// ─── Rail ───────────────────────────────────────────────────────────────────

/** A group of the rail: its name folds it, so a long rail is read one group at a time. */
export function RailSection({
  title,
  children,
  testId,
  defaultOpen = true,
}: {
  title: string
  children: ReactNode
  testId?: string
  defaultOpen?: boolean
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
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
        'flex h-7 w-full min-w-0 items-center gap-2 rounded-sm px-1 text-left text-[13px] transition-colors duration-snap ease-out motion-reduce:transition-none pointer-coarse:h-11 pointer-coarse:text-sm',
        FOCUS_RING_INSET,
        active ? 'bg-secondary font-medium text-foreground' : 'text-foreground/80 hover:bg-secondary/60 hover:text-foreground'
      )}
    >
      <span
        className={cn(
          'flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border transition-colors duration-snap',
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
      <span className="min-w-0 flex-1 truncate" title={label}>
        {label}
      </span>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{count}</span>
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

/** Two short fields side by side: from and to, min and max, role and name. */
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

/** A note about the answer, not an error: facts still being read, content searched in part. */
export function SearchNote({ children, icon: Icon, testId }: { children: ReactNode; icon: LucideIcon; testId?: string }): JSX.Element {
  return (
    <p className="flex items-start gap-2 text-pretty rounded-md bg-secondary/70 px-3 py-2 text-xs text-muted-foreground" data-testid={testId}>
      <Icon className="mt-px size-3.5 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  )
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

/**
 * One hit: an icon, its name in the strong weight, then where it lives
 * (project and folder), one muted line of what it is, and what matched under
 * it. The where line comes first because it is what tells two „Grundriss
 * Erdgeschoss“ apart.
 */
export function ResultRow({
  href,
  icon: Icon,
  title,
  where,
  meta,
  aside,
  children,
  active = false,
  testId,
}: {
  href: string
  icon: LucideIcon
  title: ReactNode
  /** Where it lives: the `ShelfMark` and the folder (`WherePart`). */
  where?: ReactNode
  /** One line of what it is: „Einreichplan · EP-03 · Index C · 1:100 · 14.10.2026“. */
  meta?: ReactNode
  /** At the row's end: a state (`SupersededMark`). */
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
            <span className="text-sm font-semibold tracking-tight text-foreground max-sm:line-clamp-2 sm:truncate">{title}</span>
            {where ? <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 py-0.5 text-xs">{where}</span> : null}
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

/**
 * Where a hit is kept, by the provenance signal: icon, label and colour
 * together. In a cell (`wrap` off) it keeps to one line and gives the full
 * name to its title; in a result row's where line it wraps, so a long project
 * name is read whole without a pointer.
 */
export function ShelfMark({ shelf, label, wrap = false }: { shelf: 'project' | 'office_shelf'; label: string; wrap?: boolean }): JSX.Element {
  const Icon = shelf === 'office_shelf' ? Archive : FolderKanban
  return (
    <span
      className={cn(
        'inline-flex min-h-5 items-center gap-1 rounded-md px-1.5 text-xs font-medium',
        wrap ? 'max-w-full py-0.5 leading-tight' : 'max-w-40 md:max-w-56'
      )}
      style={sourceTint(shelf === 'office_shelf' ? 'office' : 'project')}
      title={wrap ? undefined : label}
    >
      <Icon className="size-3 shrink-0" aria-hidden />
      <span className={wrap ? 'min-w-0 [overflow-wrap:anywhere]' : 'truncate'}>{label}</span>
    </span>
  )
}

/**
 * A folder in the where line: an icon and its name, in ink, never a colour.
 * After a shelf mark it leads with a quiet chevron, kept with the name so a
 * wrapped line never ends on the chevron alone. `label` („Ordner“) is read
 * before the name by a screen reader, which does not see the icon.
 */
export function WherePart({ children, label, after = false }: { children: ReactNode; label: string; after?: boolean }): JSX.Element {
  return (
    <span className="inline-flex min-w-0 items-center gap-1 text-foreground/75">
      {after ? <ChevronRight className="size-3 shrink-0 text-muted-foreground/60" aria-hidden /> : null}
      <Folder className="size-3 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 [overflow-wrap:anywhere]">
        <span className="sr-only">{label} </span>
        {children}
      </span>
    </span>
  )
}

/**
 * „Ersetzt“: a newer Fassung replaces this document. Ink outline and the
 * History icon, never the warning amber, which the provenance signal already
 * spends on the Büroablage (design language, principle 2).
 */
export function SupersededMark({ className }: { className?: string }): JSX.Element {
  const t = useTranslations('search.document')
  return (
    <Chip size="sm" variant="outline" className={cn('gap-1 text-muted-foreground', className)} title={t('supersededHint')} data-testid="superseded-mark">
      <History aria-hidden />
      {t('superseded')}
    </Chip>
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

/**
 * The passage that matched, behind a quiet rule like a quotation, with the
 * page it is on first, so the page stands in the same place on every row. The
 * matched words are set apart by weight on a faint ink wash, the wash exactly
 * as wide as the match: no padding, so the rest of a compound („Fluchtweg|e“)
 * runs on without a gap.
 */
export function PassageQuote({ segments, page }: { segments: readonly TextSegment[]; page?: string }): JSX.Element {
  return (
    <p className="mt-1 flex min-w-0 items-baseline gap-2 border-l-2 border-border pl-2.5 text-sm leading-relaxed text-foreground/80" data-testid="search-passage">
      {page ? (
        <Chip size="sm" variant="outline" className="shrink-0 tabular-nums">
          {page}
        </Chip>
      ) : null}
      <span className="line-clamp-2 min-w-0 text-pretty">
        „
        {segments.map((segment, index) =>
          segment.match ? (
            <mark key={index} className="rounded-[2px] bg-foreground/[0.08] font-semibold text-foreground [box-decoration-break:clone]" data-testid="search-passage-match">
              {segment.text}
            </mark>
          ) : (
            <span key={index}>{segment.text}</span>
          )
        )}
        “
      </span>
    </p>
  )
}

/** A plain excerpt (an annotation's body, a folder's description). */
export function Excerpt({ children }: { children: ReactNode }): JSX.Element {
  return <p className="mt-0.5 line-clamp-2 text-pretty text-sm text-foreground/75">{children}</p>
}

/** What the words were found in („Gefunden in Name · Inhalt“): present, never loud. */
export function MatchHint({ label, parts }: { label: string; parts: readonly string[] }): JSX.Element {
  return (
    <span className="mt-0.5 text-xs text-muted-foreground/90" data-testid="search-matched-on">
      {label} {parts.join(' · ')}
    </span>
  )
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
      <table className="w-full caption-bottom border-separate border-spacing-0 text-[13px]">
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
        <span className="line-clamp-2 text-sm font-medium text-foreground [overflow-wrap:anywhere]">{name}</span>
        {detail ? <span className="block truncate text-xs text-muted-foreground">{detail}</span> : null}
      </button>
      {controls ? <div className="flex shrink-0 items-center gap-1">{controls}</div> : null}
    </li>
  )
}

/** A switch with its word beside it („Geteilt“), the word a part of its label, so it is read and clicked as one. */
export function LabelledSwitch({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
      {children}
      <span>{label}</span>
    </label>
  )
}

/** A dialog's form: header, fields and footer apart by the dialog's own rhythm. */
export function DialogForm({ children, onSubmit }: { children: ReactNode; onSubmit: (event: FormEvent<HTMLFormElement>) => void }): JSX.Element {
  return (
    <form className="flex min-w-0 flex-col gap-5" onSubmit={onSubmit} noValidate>
      {children}
    </form>
  )
}

/** Beside a colleague's saved search, where the owner's controls would be: who it came from, as a mark. */
export function ColleagueMark(): JSX.Element {
  return <Users className="size-4 shrink-0 text-muted-foreground" aria-hidden />
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
