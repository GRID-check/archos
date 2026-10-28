import { type RowLinking } from '../WorkList'
import { type LinkSelection, type WorkRound } from '../../../lib/work-list'
import { type BasisLine } from '../../../lib/derivation-basis'
import { type CardLink } from '../SourceCard'
import { type FanCard } from '../../../lib/retrieval-rounds'

/** Hidden connection handle (edges anchor to it; the dot itself is invisible). */
export const H = {
  opacity: 0,
  width: 1,
  height: 1,
  minWidth: 0,
  minHeight: 0,
  border: 'none',
  background: 'transparent',
} as const

/**
 * The edge ink: foreground at 18%, mixed rather than a token so it sits on any
 * surface (muted, card, popover) in both themes without a second variable.
 *
 * It lived in `components/ui/timeline.tsx` while the run block drew a connected
 * phase list with the same mix. That list is now hairline-separated rows
 * (`ItemList`), so the graph is the only surface left that strokes an edge, and
 * the constant lives where it is used.
 */
export const EDGE_STROKE = 'color-mix(in oklch, var(--foreground) 18%, transparent)'

/** One anchor point on a banner edge: a handle id + its x offset within the node. */
export type HandleSpec = { id: string; left: string }

/**
 * The centred anchors every banner carries for its whole lifetime. Declared here
 * rather than inline so they read as what they are: a fixed part of each node's
 * shape, not something a turn's state switches on. See the module header — a
 * handle that appears after its node was measured never gets measured, and the
 * edges on it disappear.
 */
export const CENTRE_BOTTOM: HandleSpec = { id: 'c-bottom', left: '50%' }

export const CENTRE_TOP: HandleSpec = { id: 'c-top', left: '50%' }

export const CENTRE_OUT: HandleSpec = { id: 'out', left: '50%' }

export type FramingData = {
  label: string
  question: string
  escalation?: string
  /**
   * Bottom (source) handles. Always populated — even on a turn that has not
   * streamed a single source yet. See the module header on structural handles.
   */
  sources: HandleSpec[]
}

/**
 * One column of the fan-out. Usually a single card; on a container too narrow
 * for one column per source the extra cards stack inside the column instead of
 * collapsing the whole graph into a vertical chain.
 */
export type SourceColumnData = {
  /**
   * The slots this column carries: a document card (plus, when the backend's
   * ledger accounted for the round, what THAT round did with it — see
   * `FanCard`), or the one dashed card the round's uncited documents fold
   * into („+N abgerufen, nicht zitiert“).
   */
  cards: ColumnSlot[]
  /** Single-column (phone) layout — the cards get the grouped container. */
  grouped: boolean
  groupLabel: string
  /** Packed column width for this fan. Falls back to `--source-w` when omitted. */
  colW?: number
  /**
   * How far down the column the incoming edge ends: the folder tab's height
   * when the first slot wears one, so the connector meets the card's body as
   * it does on every column, never the blank beside the tab. 0 for a bare
   * first card and for the grouped box, whose own top is the body.
   */
  inTop: number
  /**
   * The turn is still running.
   *
   * "abgerufen, nicht zitiert" is a claim about the FINISHED answer, and while
   * the turn streams there is no answer to make it about — so every retrieved
   * document briefly reads as discarded, including the ones the answer is about
   * to cite. The card withholds the verdict until the turn lands.
   */
  live: boolean
  /** A card was tapped: its calls' rows light up (`LinkSelection`). */
  onSelect: (selection: LinkSelection | null) => void
  /** The dashed fold card was tapped: its round's uncited cards open or close. */
  onToggleFold: (key: string) => void
}

/** One slot of a fan column: a document, or the fold of a round's uncited documents. */
export type ColumnSlot =
  | { type: 'card'; fan: FanCard; callIds: string[]; link?: CardLink }
  | {
      type: 'fold'
      /** The fan this fold belongs to: what `onToggleFold` opens. */
      key: string
      count: number
      /** Short names of the folded documents, in order. */
      names: string[]
      /** The folded documents themselves: what opens in place. */
      folded: FanCard[]
      live: boolean
      expanded: boolean
      receded: boolean
    }

export type FindingsData = {
  label: string
  /** Streaming: the answer has not landed, so the node reads as in-flight. */
  pending?: boolean
  /** While pending, what the node waits for. */
  pendingNote?: string
  /**
   * What the answer stands on („Grundlagen · Entwurf“), each a labelled list:
   * the cited law with its edition, the cited project and office sources with
   * their place, and what stayed open (a call that failed or found nothing).
   * Never „nachgewiesen“: this is the basis of a draft, not a verdict.
   */
  basis: Array<{ label: string; lines: BasisLine[]; open?: boolean }>
  /** Phone width: each label sits over its lines instead of beside them. */
  compact: boolean
  /**
   * The turn ran into its research ceiling. Rendered as the node's last line —
   * the assessment answers "what was this built on?", and "the chain stopped
   * here" is part of that answer.
   *
   * Split into the sentence around the step name and the name itself, because
   * the name may be a bare tool identifier: the dictionary owns the sentence,
   * and an identifier is shown AS an identifier (`mono`) rather than dressed up
   * as a reader-facing noun. Same ladder the executed-step chips use.
   */
  truncation?: { before: string; step?: string; after: string; mono: boolean }
  /**
   * What the answer is NOT, stated plainly: research that ran out of clock or
   * steps, and evidence that did not hold up. Rendered under its own eyebrow
   * below the truncation line, because these are qualifications on the answer
   * rather than more detail about the evidence.
   *
   * A line is `warn` when it says the answer is weaker than it looks — a report
   * that was never filed, a citation set that verified to nothing. Those want to
   * be noticed. A research run that stopped early is a fact about the process
   * and keeps the muted register the lines above it use.
   *
   * Absent when there is nothing to qualify. There is deliberately no "all
   * clear" variant: the backend emits these records only when they are true, so
   * presence IS the fact and a "no limits" row would be a constant.
   */
  limits?: { label: string; lines: Array<{ text: string; warn: boolean }> }
  /** Top (target) handles — one per incoming column, or a single centre. */
  targets: HandleSpec[]
  /**
   * Bottom (source) handle. Always rendered, though nothing hangs below the
   * assessment today: a handle added to a node already measured gets no handle
   * bounds, so one added later would never draw its connector.
   */
  source: HandleSpec
}

export type RoundData = {
  /** `Schritt N` — one counter for every layer, in 1-based execution order. */
  label: string
  /**
   * WHAT the layer did (Suche / Lesen / Befund / Schluss), read off
   * reason × files — see `roundKind`. The number is the order; this is the
   * type. Tool-call ids never appear as numbers.
   */
  sub: string
  text: string
  /** Architect-facing names of the tools this checkpoint actually called. */
  actions: string[]
  /** The calls of this round (`action` steps, ADR-0132): one row each, linked to the cards they returned. */
  calls?: WorkRound
  /** Phone width: a row's result goes under its object instead of beside it. */
  compact: boolean
  /** What links the rows to the cards: the reader's tap. */
  linking: RowLinking
  targets: HandleSpec[]
  sources: HandleSpec[]
  /**
   * This layer has a fan to fold. A checkpoint that returned nothing has no
   * fold: a control that removes nothing is a control that lies about what it
   * does, and the reader learns to distrust the ones that do work.
   */
  foldable: boolean
  /** Folded — the fan is gone and {@link foldSummary} stands in its place. */
  folded: boolean
  /**
   * The scent of the folded fan: the count plus the top filename(s) — one
   * file is document + its cited locus (bare name when uncited), two are
   * both names, three or more are count + first name + "u.a."
   * (see `foldSummary`). Never a bare count, and never
   * the query — the same PF-12 rule as the body.
   */
  foldSummary: string
  /** Accessible name of the fold control; the card's own text is the context. */
  toggleLabel: string
  onToggle: () => void
}
