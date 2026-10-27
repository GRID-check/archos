/**
 * SourceCard — one document in the Herleitung's source fan-out.
 *
 * It renders a {@link CitedDocument}, which is the same object the answer's
 * "Belegt durch" chips render. That is the point: this card and that chip used
 * to be built from two disconnected pipelines (the trace-lane text block here,
 * the structured citation wire there) with no shared identity, so the trace
 * could show what was searched but never say which document became `[3]`, and
 * the two could disagree about a document's name and colour without anything
 * noticing.
 *
 * Now the card can state both halves of the derivation honestly:
 *  - the markers it carries in the answer (`[2] [7]`), or
 *  - "abgerufen, nicht zitiert" when retrieval returned it and the answer
 *    did not use it — a real research outcome that was previously not
 *    expressible at all.
 *
 * Shape: a tinted uppercase folder tab (icon + provenance label) seated on the
 * top-left of a card holding the name, its edition when the title states one,
 * and a place chip („Pkt. 3.1.1“, „S. 7“) with the `[N]` beside it. No hit
 * count: the place proves, the number does not (the 2026-10 value test).
 */

import { Fragment, type FC } from 'react'
import { Scale, FileText, Archive, Globe, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { FOCUS_RING } from '@/components/ui/focus-ring'
import { useTranslations } from '@/i18n'
import { chatCopy } from '@/i18n/namespaces/chat'
import { sourceSignalStyle } from '@/features/layout/components/SourceSignalChip'
import type { SourceSignal } from '@/features/layout/lib/source-presets'
import { SectionLabel } from '@/components/ui/section-label'
import { AuthorityTag } from '../AuthorityTag'
import { KIND_TO_SIGNAL } from '../../lib/source-kinds'
import {
  citationNumbers,
  documentPages,
  documentTabLabel,
  isCited,
  type CitedDocument,
} from '../../lib/citations'
import type { RoundLocus } from '../../lib/retrieval-rounds'
import { Ruler } from 'lucide-react'
import { SourcePreviewChip } from '../SourcePreview'
import { CitationMarkers } from '../CitationMarker'
import { documentEdition, documentShortName } from '../../lib/document-names'
import { documentLocation } from '../../lib/derivation-basis'

/** Provenance icon per signal — mirrors SourceSignalChip so they never drift. */
const SIGNAL_ICON: Record<SourceSignal, LucideIcon> = {
  law: Scale,
  project: FileText,
  office: Archive,
  auto: Globe,
  // Ruler, matching SourceSignalChip: the measurement lane is the one source
  // that was MEASURED rather than retrieved, and the comment above promises
  // these two never drift.
  model: Ruler,
}

/**
 * The pages and Punkte one round read of one document, in the order the round
 * returned them, printed exactly as the backend stated them (`p.12`,
 * `Pkt. 3.1` — rendered, never parsed).
 *
 * `marked` is off when EVERY locus was a re-fetch: the pill above already says
 * so once, and repeating it beside each line would bury the one thing the
 * reader came for. It is on for a mixed round, where the distinction between
 * "read three more Punkte" and "read them all again" lives per locus.
 */
const RoundLoci: FC<{ loci: RoundLocus[]; marked: boolean; repeatLabel: string }> = ({
  loci,
  marked,
  repeatLabel,
}) => {
  const named = loci.filter((locus) => locus.detail)
  if (named.length === 0) return null
  return (
    <span className="tabular-nums">
      {named.map((locus, i) => (
        // A Fragment, not a wrapper span: the separators and the loci stay
        // direct text of one element, so the line reads as one string to a
        // screen reader and to a test rather than as a row of chips.
        <Fragment key={`${locus.detail}-${i}`}>
          {i > 0 && ', '}
          {locus.detail}
          {marked && locus.repeat && (
            <span className="text-muted-foreground/80 italic"> ({repeatLabel})</span>
          )}
        </Fragment>
      ))}
    </span>
  )
}

/** How a card stands to the reader's tap on a row or a card (`LinkSelection`). */
export type CardLink = 'selected' | 'linked' | 'receded'

/**
 * How far a card that is not part of the reader's selection sits back. One
 * value, and never multiplied by the uncited card's own dimming: 0.4 × 0.75
 * left a receded uncited card at 30%, below any legible contrast.
 */
export const RECEDED = 'opacity-60'
/**
 * The folder tab's height, fixed so the fan's connector can end where the
 * card's body starts (the column's `in` handle sits this far down) rather than
 * in the blank beside the tab. 14px line + 8px padding; the authority badge
 * (13.5px) and the icon (10px) both fit inside it.
 */
export const FOLDER_TAB_H = 22
/** The folder tab's box, shared by the document card and the uncited fold. */
export const FOLDER_TAB =
  'ml-2.5 inline-flex h-[22px] items-center gap-1 self-start rounded-t-md px-2 leading-[14px]'

/** The uncited card's own dimming, dropped while the card is receded (see {@link RECEDED}). */
export const UNCITED_DIM = 'opacity-75'

export const SourceCard: FC<{
  document: CitedDocument
  /** The turn is still running — see the `live` note on the verdict below. */
  live?: boolean
  /**
   * Every passage THIS round read of the document, when a ledger round built
   * the fan.
   *
   * The card is the same card — same chip, same preview, same markers — but a
   * fan slot under a round is a claim about that round, so the locus line
   * states the round's own pages/Punkte, in its own order, and a passage the
   * round fetched a second time says so. Absent on the turn-level fan, where
   * the aggregate IS the claim.
   */
  loci?: RoundLocus[]
  /** Where the card stands to the reader's tap; absent while nothing is tapped. */
  link?: CardLink
  /**
   * A tap on the card links it to the rows of the calls that returned it; a
   * tap on its name also opens the preview (the chip is that button, and its
   * click bubbles here). The keyboard reaches the same toggle through a real
   * button stretched under the card's content (`aria-pressed`), a sibling of
   * the chip and the markers rather than their parent. Absent when no call
   * names the card.
   */
  onSelect?: () => void
}> = ({ document: doc, live = false, loci, link, onSelect }) => {
  const t = useTranslations(chatCopy)
  // The tab states the document's provenance: its fine lane, else the SHELF the
  // wire carried (ADR-0047 — read as data, never prefix-matched off a collection
  // id), else the coarse display stratum. A document with no shelf on the wire
  // is simply not attributed to one; it never inherits a guessed shelf.
  const tabLabel = documentTabLabel(doc, t)
  // Icon keys off the coarse SIGNAL (all Baurecht shares the scales glyph); the
  // tint keys off the fine ACCENT so OIB and RIS are distinguishable at a
  // glance instead of relying on the badge text alone.
  const Icon = SIGNAL_ICON[KIND_TO_SIGNAL[doc.kind]]
  const tint = sourceSignalStyle(doc.tint)
  const used = isCited(doc)
  const numbers = citationNumbers(doc)
  // `documentPages`, not `citedPages`: this card also stands for a document
  // the answer did not cite, every locus of which is uncited, and the precise
  // claim is empty for exactly those — silently deleting the pages retrieval
  // actually read from the one surface whose job is to show them.
  const pages = documentPages(doc)
  // Every passage this round read was one it had already fetched, so the round
  // did no new work on this document, and the card says so once.
  const allRepeat = !!loci && loci.length > 0 && loci.every((locus) => locus.repeat)
  // The badge earns its space only when it names a tier the label does not
  // already say: "OIB · OIB-Richtlinie" repeated itself and pushed the label
  // into an ellipsis, while "RIS · Bundesrecht" names the register behind it.
  const showAuthority =
    !!doc.authority && !tabLabel.toLowerCase().startsWith(doc.authority.toLowerCase())
  // The edition is the card's second line (Ausgabe, Rev.), and the name loses
  // it: „OIB-Richtlinie 2“ over „Ausgabe Mai 2023“ instead of one long title.
  const fileName = doc.fileName ?? doc.title
  const edition = documentEdition(fileName, doc.title)
  const named = edition ? { ...doc, title: documentShortName(fileName, doc.title) } : doc
  // The place, not a count: „Pkt. 3.1.1“ or „S. 7“ proves; „4 Treffer“ does not.
  const location = loci
    ? loci.flatMap((locus) => (locus.detail ? [locus.detail] : [])).join(', ')
    : doc.loci.some((locus) => locus.clause?.trim())
      ? (documentLocation(t, doc) ?? '')
      : pages.length === 0
        ? ''
        : pages.length === 1
          ? t('answerSources.page', { page: pages[0]! })
          : t('answerSources.pages', { pages: pages.join(', ') })

  return (
    <div
      role="listitem"
      data-source-card
      data-link={link}
      onClick={onSelect}
      className={cn(
        'duration-quick flex min-w-0 flex-col transition-opacity ease-out motion-reduce:transition-none',
        link === 'receded' && RECEDED
      )}
    >
      {/* Folder tab — tinted, uppercase, seated on the card's top-left. */}
      <SectionLabel
        className={cn(FOLDER_TAB, 'max-w-[calc(100%-0.625rem)]')}
        style={{ backgroundColor: tint.backgroundColor, color: tint.color }}
      >
        {/* The glyph is dropped when a badge is shown: at column width the tab
            fits roughly one of icon / badge / full label, and "RIS" carries the
            provenance in TEXT — which satisfies the same a11y rule the icon
            exists for (colour is never the only carrier). */}
        {!showAuthority && (
          <Icon
            className="size-2.5 shrink-0"
            style={{ color: `var(--source-${doc.tint})` }}
            aria-hidden="true"
          />
        )}
        {showAuthority && <AuthorityTag>{doc.authority}</AuthorityTag>}
        <span className="truncate">{tabLabel}</span>
      </SectionLabel>

      {/* Card body. A document that was read but never cited sits back
          (dashed hairline, muted ink) so it never reads as grounding the answer
          did not use; the one the reader tapped wears a full outline. */}
      <div
        className={cn(
          // A long single word („Brandschutzkonzept“) hyphenates at a syllable
          // rather than spill past a narrow column (grid-design-language
          // §Typography); `break-word` is the last resort for a word the
          // dictionary does not know, never a mid-syllable cut by default.
          'bg-card relative min-w-0 flex-1 rounded-lg border px-3 py-2.5 shadow-xs hyphens-auto [overflow-wrap:break-word] [hyphenate-limit-chars:10_4_4]',
          !used && !live && 'border-dashed',
          !used && !live && link !== 'receded' && UNCITED_DIM,
          link === 'selected' && 'border-foreground ring-foreground ring-1'
        )}
      >
        {/* The keyboard's way to the card's own toggle: a real button under the
            content, named by the document as the card names it, pressed while the card is the
            selection. The chip and the markers sit above it (`relative z-10`),
            so it wraps neither; a press anywhere else on the card lands on it,
            and its click bubbles to the card like any other tap there. */}
        {onSelect && (
          <button
            type="button"
            aria-pressed={link === 'selected'}
            aria-label={t('thinking.node.cardLink', {
              name: [named.title, edition].filter(Boolean).join(', '),
            })}
            data-source-card-toggle=""
            className={cn('absolute inset-0 cursor-pointer rounded-lg outline-none', FOCUS_RING)}
          />
        )}

        {/* The card IS the citation — clicking it opens the document at the
            page the answer used, exactly as the chip under the answer does. */}
        <SourcePreviewChip
          citation={{ document: named }}
          variant="card"
          detail="name-only"
          // `p-0` strips the row down to the name, and with it the TARGET:
          // `min-h-11` buys the 44px floor back out of padding the card already
          // spends (`-my-2`), so the card grows ~9px instead of ~25px.
          className="relative z-10 border-0 bg-transparent p-0 shadow-none hover:bg-transparent pointer-coarse:-my-2 pointer-coarse:min-h-11 pointer-coarse:items-center focus-visible:ring-offset-card"
        />
        {edition && <p className="text-muted-foreground text-[13px] leading-[19px]">{edition}</p>}

        {(location || allRepeat || numbers.length > 0) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[13px] leading-[19px]">
            {location && (
              <span className="bg-muted text-foreground rounded-md px-1.5 tabular-nums">
                {loci ? (
                  <RoundLoci
                    loci={loci}
                    marked={!allRepeat}
                    repeatLabel={t('thinking.node.roundDocRepeat')}
                  />
                ) : (
                  location
                )}
              </span>
            )}
            {/* A round that only re-fetched what it already had states THAT:
                the turn aggregate is identical on every repeat of the same
                file, which made a re-read indistinguishable from a new fetch. */}
            {allRepeat && (
              <span className="text-muted-foreground italic">
                {t('thinking.node.roundDocRepeat')}
              </span>
            )}
            {/* Which markers in the answer this document carries — the link
                between "what was read" and "what was used". */}
            {/* The answer's own marker: it peeks the passage and opens the
                document at its page, as the `[N]` in the prose does. Its press
                stays its own: the card's tap links the rows of the calls, and
                a press on the marker (or inside the peek and the viewer it
                opens, which bubble through React's tree from their portals)
                is not a tap on the card. */}
            {numbers.length > 0 && (
              <span
                data-source-card-markers=""
                className="text-foreground relative z-10 ml-auto text-[15px] font-semibold tabular-nums"
                onClick={(event) => event.stopPropagation()}
              >
                <CitationMarkers numbers={numbers} />
              </span>
            )}
          </div>
        )}
        {/* "abgerufen, nicht zitiert" is a claim about the FINISHED answer, so
            it waits for the turn to land. Said to a screen reader; the dashed
            hairline says it to the eye. */}
        {!used && !live && <span className="sr-only">{t('thinking.readNotUsed')}</span>}
      </div>
    </div>
  )
}

/**
 * A ledger doc the turn's card model has no card for.
 *
 * The answer-repair pass reads files after the cards are built, and a name the
 * model dropped is a name the fan would otherwise silently lose — so the slot
 * survives as what the ledger actually knows: the name and the loci THAT round
 * read, with the same repeat verdict a carded slot draws. Deliberately bare
 * otherwise: no chip, no preview, no citation markers. Every one of those would
 * be a claim about a document this turn has no card for, and a control that
 * opens nothing is worse than no control.
 */
export const BareSourceCard: FC<{ name: string; loci?: RoundLocus[]; workspace?: boolean }> = ({
  name,
  loci,
  workspace,
}) => {
  const t = useTranslations(chatCopy)
  // The same verdict the carded slot draws, through the same component — a
  // slot without a card still knows what its round did, and dropping the
  // marker here would make a re-fetch look like a first read on exactly the
  // documents the reader can check least.
  const allRepeat = !!loci && loci.length > 0 && loci.every((locus) => locus.repeat)
  return (
    <div role="listitem" data-source-card className="flex min-w-0 flex-col">
      <div
        className={cn(
          'bg-card min-w-0 flex-1 rounded-lg border border-dashed px-3 py-2.5 shadow-xs',
          UNCITED_DIM
        )}
      >
        {workspace ? (
          // A read of the office's state: worded for the reader, the operation it ran beneath as its identifier.
          <>
            <p className="text-foreground line-clamp-2 text-sm leading-snug">
              {t('thinking.node.workspaceRead')}
            </p>
            <p className="text-muted-foreground mt-0.5 truncate font-mono text-xs">{name}</p>
          </>
        ) : (
          <p className="text-foreground line-clamp-2 text-sm leading-snug">{name}</p>
        )}
        {loci && loci.length > 0 && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {/* No hit tally to stand in for: a bare slot has no card, so the
                pill appears only when there is a repeat to declare. */}
            {allRepeat && (
              <span className="bg-muted text-muted-foreground/80 inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium italic">
                {t('thinking.node.roundDocRepeat')}
              </span>
            )}
            <RoundLoci
              loci={loci}
              marked={!allRepeat}
              repeatLabel={t('thinking.node.roundDocRepeat')}
            />
          </div>
        )}
      </div>
    </div>
  )
}
