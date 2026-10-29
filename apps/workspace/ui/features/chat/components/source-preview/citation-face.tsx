/** What a citation shows before it is clicked, in the chip and the card layout. */

import type { CSSProperties, FC, ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { FOCUS_RING } from '@/components/ui/focus-ring'
import { PRESSABLE } from '@/components/ui/press'
import { Spinner } from '@/components/ui/spinner'
import { iconForTint, sourceSignalStyle } from '@/features/layout/components/SourceSignalChip'
import type { SourceTint } from '@/lib/source-kinds'
import type { CitationRef } from '../../lib/citations'
import { AuthorityTag } from '../AuthorityTag'

// ---------------------------------------------------------------------------
// Shared chip styling (mirrors SourceSignalChip's chip vocabulary)
// ---------------------------------------------------------------------------

// (The per-signal icon map used to be duplicated here "kept in sync with
// SourceSignalChip" by hand; it now comes from `iconForTint`, so the accent
// families cannot drift between the chip and the preview.)

// The press and the ring are the shared ones (`PRESSABLE`, `FOCUS_RING`): this
// chip used to dip to 0.95 on the colour's 180ms while the card beside it
// dipped to 0.99, and both drew a third focus ring. Busy is `aria-busy`, never
// `disabled` — see `DocumentPreviewChip`.
const chipButtonClasses = cn(
  // Under a finger the chip may take two lines: the edition and the Fundstelle are
  // what tells two chips of one Richtlinie apart, and they sit at the END of a
  // title that a single truncated line cut off.
  'inline-flex h-6 max-w-full shrink-0 cursor-pointer items-center gap-1 truncate whitespace-nowrap pointer-coarse:h-auto pointer-coarse:min-h-11 pointer-coarse:whitespace-normal pointer-coarse:py-1.5 pointer-coarse:text-left',
  'rounded-control border px-2.5 text-xs font-medium outline-none',
  '[&>svg]:size-3 [&>svg]:shrink-0 hover:brightness-95 dark:hover:brightness-125 aria-busy:cursor-progress',
  PRESSABLE,
  FOCUS_RING
)

// ---------------------------------------------------------------------------
// Layout variants — ONE behaviour, two shapes
// ---------------------------------------------------------------------------

/**
 * How a citation is laid out. The variant changes only the SHAPE; the
 * provenance tint, the authority badge, the resolved target and the click
 * behaviour are identical, which is the whole point: the same source must not
 * be a tinted, openable pill under the answer and an inert line of text one tab
 * over.
 */
export type CitationVariant = 'chip' | 'card'

/**
 * How much of a citation's chrome the card layout prints.
 *
 * `full` is the roomy technical row, and the default: provenance icon,
 * authority badge, the `[N]`, and the raw locator as the Fundstelle.
 *
 * `name-only` is for a surface that ALREADY states all of that around the
 * citation — the Herleitung fan-out puts the icon, the badge and the lane on
 * its folder tab and the markers and pages on its own meta line, so repeating
 * them inside the card left the document's NAME, the one thing only the card
 * can say, squeezed into an ellipsis.
 */
export type CitationDetail = 'full' | 'name-only'

/**
 * The card is the source list's existing row, unchanged in shape: one bordered
 * card holding everything, hover-highlighted, full-width. Only its CONTENT
 * gained provenance (a tinted icon and an authority badge) and its behaviour
 * became real.
 */
const cardButtonClasses = cn(
  'flex w-full cursor-pointer gap-3 rounded-surface border bg-card p-3 text-left outline-none hover:bg-accent',
  'aria-busy:cursor-progress',
  PRESSABLE,
  FOCUS_RING
)

export const faceClasses = (variant: CitationVariant): string =>
  variant === 'card' ? cardButtonClasses : cn(chipButtonClasses, 'max-w-56 pointer-coarse:max-w-full')

/**
 * The card face while nothing can be opened yet (the preview index is still
 * loading): the same shape, none of the affordances. A hover tint and a press
 * scale on a box with no handler behind it read as a broken button, which is
 * exactly what the Herleitung's source chips looked like before resolution.
 */
export const inertCardClasses = 'flex w-full gap-3 rounded-surface border bg-card p-3 text-left'

/**
 * The card keeps the calm neutral card surface a long list needs and carries
 * its provenance in the icon + badge instead — tinting whole rows would make
 * the list unreadable.
 */
export const faceStyle = (variant: CitationVariant, signal: SourceTint): CSSProperties | undefined =>
  variant === 'card' ? undefined : sourceSignalStyle(signal)

/**
 * The `[N]` a source carries in the answer prose, rendered inside its chip.
 *
 * This is the one thing the written source list held that a chip could not: it
 * is what an inline `[2]` in the answer points at. It uses the chip's own
 * currentColor vocabulary (same as AuthorityTag) so it reads as part of the
 * chip rather than as a new element bolted on.
 */
export const CitationIndex: FC<{ index?: string }> = ({ index }) =>
  !index ? null : (
    // `me-1`, not the parent's flex gap: `SourceSignalChip` collapses ALL its
    // children into one truncating span, so a gap between them never applies
    // there and the marker renders flush against the label ("3Attika-Detail").
    // Carrying its own trailing space makes the marker read correctly in every
    // chip shape rather than only in the ones that keep it a flex child.
    <span className="me-1 shrink-0 text-xs font-semibold tabular-nums opacity-60">{index}</span>
  )

/** Everything a citation shows before it is clicked, in either layout. */
interface CitationFaceProps {
  variant?: CitationVariant
  signal: SourceTint
  label: string
  authority?: string
  /**
   * The marker(s) this source carries in the answer prose — "3", or "2, 7" for
   * a document the answer cites in more than one place.
   */
  index?: string
  /** Backing reference — supplies the card layout's excerpt and locator. */
  citation?: CitationRef
  /**
   * Card layout only: quiet metadata pinned to the right of the title row
   * (the source list's cited marker + timestamp). Keeps that metadata INSIDE
   * the card, where it reads as part of the row, rather than stranded under it.
   */
  trailing?: ReactNode
  /** Card layout only — see {@link SourcePreviewChipProps.detail}. */
  detail?: CitationDetail
  /**
   * Opening has taken long enough to say so: the leading icon becomes a
   * spinner in the same slot, so nothing else in the face moves.
   */
  busy?: boolean
}

/** The provenance icon, or the spinner standing in its slot while busy. */
const LeadingIcon: FC<{ signal: SourceTint; busy?: boolean; className?: string }> = ({
  signal,
  busy,
  className,
}) => {
  const Icon = iconForTint(signal)
  return busy ? (
    <Spinner size="xs" aria-hidden="true" className={cn('[&_svg]:size-[inherit]', className)} />
  ) : (
    <Icon aria-hidden="true" className={className} />
  )
}

/**
 * The visual body of a citation, shared by every branch (document / link /
 * info / plain) and by both variants — so a source cannot look like a
 * first-class citation in one place and a bare label in another.
 */
export const CitationFace: FC<CitationFaceProps> = ({
  variant = 'chip',
  signal,
  label,
  authority,
  index,
  citation,
  trailing,
  detail = 'full',
  busy,
}) => {
  if (variant !== 'card') {
    return (
      <>
        <CitationIndex index={index} />
        <LeadingIcon signal={signal} busy={busy} className="size-3 shrink-0" />
        {authority && <AuthorityTag>{authority}</AuthorityTag>}
        <span className="truncate pointer-coarse:line-clamp-2 pointer-coarse:whitespace-normal pointer-coarse:break-words">{label}</span>
      </>
    )
  }

  // The card has room the chip does not, so it leads with the document's real
  // NAME. The chip's label is a hostname for links — right when space is one
  // pill, wrong as the headline of a row that can spell out "Bauordnung für
  // Wien § 108".
  const headline = citation?.document.title.trim() || label
  // The passage the source contributed. The model already refused to put a bare
  // locator line ("file.pdf, p.3") in a snippet field, so nothing to strip here.
  const excerpt = citation?.locus?.snippet ?? citation?.document.snippet
  const locator =
    citation?.locus?.citationKey || citation?.document.fileName || citation?.document.url

  // Never say the same thing twice. The wire's `content` is built as
  // "<origin token> <citation key | title | url>", so for most sources it
  // restates the headline or the locator rather than carrying a passage — a
  // tool result would otherwise print its own name three times over.
  // Containment (not equality), because "[RIS] Bauordnung für Wien § 108" is
  // still a restatement of the title "Bauordnung für Wien § 108 — Fluchtwege".
  // Only ever suppress the SHORTER restatement, so a genuine long passage that
  // happens to quote the title still shows.
  const norm = (value: string | undefined): string =>
    (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
  const restates = (candidate: string, of: string | undefined): boolean =>
    !!candidate && norm(of).includes(norm(candidate))
  const full = detail === 'full'
  const showExcerpt = !!excerpt && !restates(excerpt, headline) && !restates(excerpt, locator)
  const showLocator = full && !!locator && !restates(locator, headline)

  return (
    <>
      {full && index && (
        <span
          className="bg-muted text-muted-foreground mt-0.5 flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full border px-1 font-mono text-xs tabular-nums"
          aria-hidden="true"
        >
          {index}
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex items-center gap-2">
          {full && (
            <span
              className="shrink-0"
              style={{ color: `var(--source-${signal}, var(--muted-foreground))` }}
            >
              <LeadingIcon signal={signal} busy={busy} className="size-4" />
            </span>
          )}
          {full && authority && <AuthorityTag>{authority}</AuthorityTag>}
          <span
            // Two lines, not one: document names are long ("Erläuterungen zu
            // OIB-Richtlinie 2.1, Ausgabe Mai 2023") and the distinguishing
            // part is usually at the END, so a single truncated line makes two
            // different Richtlinien read identically.
            className="text-foreground line-clamp-2 min-w-0 flex-1 text-sm font-medium leading-snug"
            // Storage identity belongs on the tooltip, never in the reading
            // line — a user must not have to read `oib-rl_2_….pdf` to know
            // which document a card stands for.
            title={locator && locator !== headline ? `${headline}\n${locator}` : headline}
          >
            {headline}
          </span>
          {trailing}
        </span>
        {showExcerpt && (
          <span className="text-muted-foreground line-clamp-3 text-sm leading-relaxed">
            {excerpt}
          </span>
        )}
        {showLocator && (
          <span className="text-muted-foreground truncate break-all font-mono text-xs">
            {locator}
          </span>
        )}
      </span>
    </>
  )
}
