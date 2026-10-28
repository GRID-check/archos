/**
 * ReasoningFlow — the Herleitung rendered as a real node graph (@xyflow/react).
 *
 * Framing → (for two or more fetches: each checkpoint, then the files THAT
 * fetch returned) → findings. One retrieval stays the
 * old fan. A second search is a new layer: conclusion, tools, then its own
 * fan. Each layer speaks the model's thought when it wrote one, never the
 * search query. Every layer is numbered in execution order (`Schritt N`) with
 * a typed sublabel for what it did — tool-call ids are never shown as numbers.
 * Files hang off the checkpoint that fetched them, and each checkpoint FOLDS:
 * a click on the layer replaces its fan with the scent of what that fetch
 * returned (the count plus the top filename(s)) and a second click brings it
 * back. Every layer arrives EXPANDED — evidence hidden by default reads as no
 * evidence, so there is no auto-fold; see `defaultFoldedRounds`. A folded
 * layer contributes no column nodes at all, so the measured stacking pass
 * reclaims the row rather than leaving a gap where the fan was.
 * derived from the SAME streamed props the old ReasoningChain used, so the graph
 * grows as a turn streams in. The canvas is non-interactive (no pan/zoom/drag)
 * and renders at 1:1 — its height comes from MEASURED node heights (no fitView,
 * no hardcoded guesses), so it sits inline in the chat like any other block.
 *
 * ## What hangs under a checkpoint
 *
 * The backend's `retrieval_ledger` states, per round, the documents THAT round
 * returned and the page it read each at. When the message carries one, the fan
 * under a round is built from its ledger round (matched by `index`): the same
 * turn-level cards, so the chip, the preview and the markers are untouched, but
 * each card names the locus that round read and a file an earlier round already
 * showed says so instead of repeating the turn's hit count. Without a ledger —
 * or for a round it does not cover — the fan is the filename match it always
 * was. Before this, a round that re-opened four files at new pages drew four
 * identical cards a second time, and a re-read was indistinguishable from a
 * second fetch. See `roundFan`.
 *
 * ## Layout: columns, not an orientation flip
 *
 * The sources always fan out into COLUMNS across the full container width. How
 * many columns is purely a function of the width: as many as fit at
 * `MIN_COL_W`, capped at one column per card. Cards that don't fit in the row
 * stack INSIDE a column rather than pushing the graph into a single vertical
 * chain — so a desktop turn with eight sources still reads as a parallel
 * fan-out (4 columns × 2), and only a genuinely phone-width container collapses
 * to the one-column grouped "Quellen" container.
 *
 * The banners span the full content width, so every handle sits INSIDE its node
 * (the old fixed 460px banner left the outer columns' edges dangling in empty
 * space beside it).
 *
 * ## Wiring: one trunk that splits and merges
 *
 * Both banners expose a SINGLE centred handle, so the connectors share their
 * first and last segment: one line leaves the framing card, splits across the
 * columns, and merges back into one line entering the assessment. The old
 * per-column handles landed N separate drops side by side on the banner edges,
 * which read as parallel arrows rather than a fan.
 *
 * Getting the bar to be one line rather than a staircase is entirely
 * @xyflow/react's own `getSmoothStepPath` — it takes `centerX`/`centerY` (the
 * bend location) and `offset` (the minimum straight run out of a handle), none
 * of which the built-in `SmoothStepEdge` forwards through `pathOptions`. Pin
 * all three to the shared end and every edge bends on the same line; leave them
 * to their defaults and each edge bends at its own midpoint, which with columns
 * of unequal height scatters the merge and draws a doubled hairline. See
 * `trunkEdge`.
 *
 * ## Handles are structural, never conditional
 *
 * React Flow measures a node's handle positions when the node element is first
 * measured and re-measures them only when that element RESIZES (its
 * ResizeObserver) or when the node's type / sourcePosition / targetPosition
 * changes. Mounting a new `<Handle>` into a node already on screen is invisible
 * to it: the stale `handleBounds` has no entry for the new id, so
 * `getEdgePosition` returns null and every edge on that handle silently fails
 * to render.
 *
 * That is what a conditional handle used to do here. A live turn starts with no
 * sources and no verdict, so the framing card was measured with an EMPTY handle
 * list; the first streamed source then added its bottom anchor without changing
 * the card's height, and the fan-out drew no connectors at all — unless another
 * framing line happened to land in the same tick and resize the card into a
 * re-measure. Hence "sometimes the connectors are mangled".
 *
 * So every node declares its FULL handle set for its whole lifetime, whether or
 * not an edge is currently attached: the anchors are 1×1 and invisible, and one
 * nothing connects to costs nothing. The `handleSigs` effect is the belt to that
 * braces — if a handle set ever becomes conditional again it re-measures the
 * node instead of quietly dropping its edges.
 *
 * ## No flicker
 *
 * Four rules, because this graph re-lays out while a turn streams:
 *  1. Nodes are re-seeded by MERGING into the previous ones — a streamed data
 *     update never resets a measured position back to y=0, and a brand-new node
 *     is seeded at its row's last known y instead of on top of the framing card.
 *  2. Both the re-seed and the measure→place pass are LAYOUT effects, so a
 *     streamed update lands its data, its x and its measured y in one pre-paint
 *     commit. As a passive effect the re-seed painted a frame of the previous
 *     tick's data at the new tick's layout, every tick.
 *  3. The pass measures the node ELEMENTS, and re-runs on every width the fan is
 *     planned against. React Flow's own `measured` is a frame behind across a
 *     reflow, and it emits no dimension change for a node that ends a reflow at
 *     the size it started — a viewport that widens and snaps back (a rotation, a
 *     devtools pane, a full-page screenshot) therefore left the graph placed
 *     from the widths it had MID-reflow, with every row overlapping the next and
 *     nothing left to trigger a correction.
 *  4. The opacity gate lifts once, after the FIRST layout. Reflows (resize,
 *     streaming, column re-packing) keep the graph visible — the old gate was
 *     keyed on orientation and fired a full fade-out/in on every flip.
 *
 * ## The 2026-10 evolution (ADR-0132, amendment)
 *
 * A step with calls draws them as rows inside its node (`RoundCalls`), not as
 * nodes of their own, and carries no fold: the rows are its controls. The
 * decision's prefetch (round 0, `RetrievalStep.prefetch`) is no step; its
 * documents join the first fan. Each fan shows the cited documents as cards and
 * folds the rest into one dashed card (`partitionFan`). A tap on a row or a
 * card links the two through `call_id` (`GraphInteraction`). The last node is
 * „Grundlagen · Entwurf“ (`basisLines`, `openPoints`), not a tally.
 *
 * ## What moves
 *
 * Only React Flow's own `animated` edge: while the turn is live, the
 * connectors INTO the newest row march (`.react-flow__edge.animated`, the
 * library's `dashdraw`). Everything else simply appears. See `renderedEdges`.
 */

'use client'

import { type FC, useCallback, useId, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Circle } from 'lucide-react'
import { FOCUS_RING, FOCUS_RING_INSET } from '@/components/ui/focus-ring'
import {
  ReactFlow,
  ReactFlowProvider,
  BaseEdge,
  Handle,
  Position,
  applyNodeChanges,
  getSmoothStepPath,
  useNodesInitialized,
  useUpdateNodeInternals,
  type Node,
  type NodeChange,
  type Edge,
  type EdgeProps,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { Translator } from '@/i18n'
import { useTranslations } from '@/i18n'
import { chatCopy } from '@/i18n/namespaces/chat'
import { cn } from '@/lib/utils'
import { useLayoutStore } from '@/features/layout/store'
import { TechnicalSteps } from './TechnicalSteps'
import { LookStepRows } from './LookStepRow'
import { RoundCalls, type RowLinking } from './WorkList'
import { quoteQuery } from '../../lib/work-sentence'
import {
  callIdsByDocument,
  isLinked,
  placedLookIds,
  prefetchRounds,
  withActionRounds,
  workKind,
  workRounds,
  type LinkSelection,
  type WorkRound,
} from '../../lib/work-list'
import {
  basisLines,
  cardForTarget,
  cardName,
  openPoints,
  type BasisLine,
} from '../../lib/derivation-basis'
import type { CitationSource } from '../../types'
import type { StoredThinkingStep } from '@/lib/conversations/message-provenance'
import { deriveTraceLanes } from '../../lib/trace-lanes'
import {
  buildCitationModel,
  citedLoci,
  isCited,
  normalizeFileName,
  type CitedDocument,
  type CitationLocus,
} from '../../lib/citations'
import { documentShortName } from '../../lib/document-names'
import {
  BareSourceCard,
  FOLDER_TAB,
  FOLDER_TAB_H,
  RECEDED,
  SourceCard,
  type CardLink,
} from './SourceCard'
import { CitationMarkers } from '../CitationMarker'
import { SectionLabel } from '@/components/ui/section-label'
import {
  answerDegradations,
  deepResearchCutoff,
  researchTruncation,
  type AnswerDegradation,
  type DeepResearchCutoff,
} from '../../lib/turn-events'
import { stepNameLabel } from '../../lib/executed-steps'
import {
  retrievalRounds,
  roundFan,
  type FanCard,
  type RetrievalRound,
} from '../../lib/retrieval-rounds'
import type { RetrievalLedger } from '@/lib/conversations/message-retrieval-ledger'

/** Hidden connection handle (edges anchor to it; the dot itself is invisible). */
const H = {
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
const EDGE_STROKE = 'color-mix(in oklch, var(--foreground) 18%, transparent)'

/** One anchor point on a banner edge: a handle id + its x offset within the node. */
type HandleSpec = { id: string; left: string }

/**
 * The centred anchors every banner carries for its whole lifetime. Declared here
 * rather than inline so they read as what they are: a fixed part of each node's
 * shape, not something a turn's state switches on. See the module header — a
 * handle that appears after its node was measured never gets measured, and the
 * edges on it disappear.
 */
const CENTRE_BOTTOM: HandleSpec = { id: 'c-bottom', left: '50%' }
const CENTRE_TOP: HandleSpec = { id: 'c-top', left: '50%' }
const CENTRE_OUT: HandleSpec = { id: 'out', left: '50%' }

const Eyebrow: FC<{ children: React.ReactNode }> = ({ children }) => (
  <SectionLabel as="div">{children}</SectionLabel>
)

// ── node payloads ───────────────────────────────────────────────────────────
type FramingData = {
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
type SourceColumnData = {
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
type ColumnSlot =
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
type FindingsData = {
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
type RoundData = {
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

// ── node components ───────────────────────────────────────────────────────────
const FramingFlowNode: FC<NodeProps<Node<FramingData>>> = ({ data }) => (
  <div className="bg-card w-[var(--banner-w)] max-w-full rounded-xl border px-4 py-3 text-left shadow-xs">
    <Eyebrow>
      <span className="inline-flex items-center gap-1.5">{data.label}</span>
    </Eyebrow>
    <p className="text-foreground mt-1 text-sm leading-relaxed">{data.question}</p>
    {data.escalation && (
      <p className="text-warning mt-1.5 text-xs leading-relaxed">{data.escalation}</p>
    )}
    {data.sources.map((h) => (
      <Handle
        key={h.id}
        id={h.id}
        type="source"
        position={Position.Bottom}
        style={{ ...H, left: h.left }}
      />
    ))}
  </div>
)

/**
 * One checkpoint layer, and the control that folds the fan under it.
 *
 * The whole card is the target, because "the step" is what a reader points at —
 * so the control is a stretched overlay button rather than a chevron in the
 * corner. It carries its own `aria-label` (the card's body is a conclusion, not
 * a control name) and reports the state through `aria-expanded`, which is what
 * makes it keyboard-operable at all: React Flow is configured with
 * `nodesFocusable={false}` and `disableKeyboardA11y`, so a node is only ever
 * reachable through a real `<button>` inside it.
 *
 * There is deliberately no `aria-controls`: the fan is a SIBLING node in the
 * React Flow pane, not a descendant of this card, and its column elements carry
 * `data-id` rather than `id`. Pointing at an id that does not exist is worse
 * than pointing at nothing.
 */
const RoundFlowNode: FC<NodeProps<Node<RoundData>>> = ({ data }) => (
  <div className="bg-card relative w-[var(--banner-w)] max-w-full rounded-xl border px-4 pt-3 pb-2 text-left shadow-xs">
    {data.targets.map((h) => (
      <Handle
        key={h.id}
        id={h.id}
        type="target"
        position={Position.Top}
        style={{ ...H, left: h.left }}
      />
    ))}
    {data.foldable && (
      <button
        type="button"
        onClick={data.onToggle}
        aria-expanded={!data.folded}
        aria-label={data.toggleLabel}
        data-testid="reasoning-round-toggle"
        className={cn(
          'absolute inset-0 z-10 cursor-pointer rounded-xl outline-none',
          // Inset: the banner spans the content width, and an offset ring is
          // clipped by the pane on both sides.
          FOCUS_RING_INSET
        )}
      />
    )}
    <div className="flex items-start justify-between gap-2">
      <Eyebrow>
        {data.label} · {data.sub}
      </Eyebrow>
      {data.foldable && (
        <ChevronDown
          aria-hidden="true"
          className={cn(
            'text-muted-foreground duration-quick mt-px size-3.5 shrink-0 transition-transform ease-out motion-reduce:transition-none',
            data.folded && '-rotate-90'
          )}
        />
      )}
    </div>
    {/* The model's sentence, when it wrote one: it names the intent. A step
        without one loses nothing — its rows say what it did. */}
    {data.text ? <p className="text-foreground mt-1 text-sm leading-relaxed">{data.text}</p> : null}
    {/* A step stored before the action rows (ADR-0132) still names its tools. */}
    {!data.calls && data.actions.length > 0 ? (
      <ul className="mt-1.5 flex flex-wrap gap-1">
        {data.actions.map((action) => (
          <li
            key={action}
            className="bg-muted text-muted-foreground rounded-md px-1.5 py-0.5 text-[11px] leading-snug pointer-coarse:text-xs"
          >
            {action}
          </li>
        ))}
      </ul>
    ) : null}
    {data.calls ? (
      <RoundCalls
        round={data.calls}
        compact={data.compact}
        linking={data.linking}
        ruled={Boolean(data.text)}
      />
    ) : null}
    {/* Folded: the fan collapses to its scent — the count plus the top
        filename(s). Not the query (PF-12), and never a bare count: evidence
        hidden behind a number reads as no evidence. */}
    {data.foldable && data.folded ? (
      <p className="border-base text-muted-foreground mt-1.5 border-t pt-1.5 pb-1 text-xs leading-relaxed">
        {data.foldSummary}
      </p>
    ) : null}
    {data.sources.map((h) => (
      <Handle
        key={h.id}
        id={h.id}
        type="source"
        position={Position.Bottom}
        style={{ ...H, left: h.left }}
      />
    ))}
  </div>
)

/**
 * One fan-out column. Exactly two edges touch it — framing → column and
 * column → assessment — both centred, so the connector is always a straight
 * drop no matter how many cards the column carries. Stacked cards are joined by
 * a short hairline in the same ink as the edges, so the stack reads as "these
 * were searched together", not as a sequence of steps.
 */
const SourceColumnFlowNode: FC<NodeProps<Node<SourceColumnData>>> = ({ data }) => {
  const stack = (
    <div role="list" aria-label={data.groupLabel} className="flex w-full flex-col">
      {data.cards.map((slot, i) => (
        <div
          key={slot.type === 'card' ? slot.fan.key : `fold:${slot.key}`}
          className="flex flex-col"
        >
          {/* The hairline joins cards; the open fold is a text control under
              the last uncited card, not a card, and hangs on nothing. */}
          {i > 0 && !(slot.type === 'fold' && slot.expanded) && (
            <span
              aria-hidden="true"
              className="mx-auto h-2.5 w-px shrink-0"
              style={{ backgroundColor: EDGE_STROKE }}
            />
          )}
          {slot.type === 'fold' ? (
            <UncitedFoldCard slot={slot} onToggle={() => data.onToggleFold(slot.key)} />
          ) : (
            <FanSlotCard slot={slot} live={data.live} onSelect={data.onSelect} />
          )}
        </div>
      ))}
    </div>
  )

  return (
    <div
      className="max-w-full"
      style={{ width: data.colW !== undefined ? `${data.colW}px` : 'var(--source-w)' }}
    >
      <Handle
        id="in"
        type="target"
        position={Position.Top}
        style={{ ...H, left: '50%', top: data.inTop }}
      />
      {data.grouped ? (
        <div className="bg-muted rounded-xl border px-3 py-3">
          <Eyebrow>{data.groupLabel}</Eyebrow>
          <div className="mt-2">{stack}</div>
        </div>
      ) : (
        stack
      )}
      <Handle id="out" type="source" position={Position.Bottom} style={{ ...H, left: '50%' }} />
    </div>
  )
}

/**
 * One document of a fan. Tapping it (it opens its preview, as it always did)
 * also lights up the rows of the calls that returned it; a card no call names
 * (the prefetch's, or a turn stored before `call_id`) links to nothing.
 */
const FanSlotCard: FC<{
  slot: Extract<ColumnSlot, { type: 'card' }>
  live: boolean
  onSelect: (selection: LinkSelection | null) => void
}> = ({ slot, live, onSelect }) => {
  const { fan, callIds, link } = slot
  const select =
    callIds.length > 0
      ? () => onSelect(link === 'selected' ? null : { key: fan.key, callIds })
      : undefined
  return fan.card ? (
    <SourceCard
      document={fan.card}
      live={live}
      {...(fan.loci ? { loci: fan.loci } : {})}
      {...(link ? { link } : {})}
      {...(select ? { onSelect: select } : {})}
    />
  ) : (
    <BareSourceCard
      name={fan.workspace ? fan.name : documentShortName(fan.name, fan.title)}
      {...(fan.workspace ? { workspace: true } : {})}
      {...(fan.loci ? { loci: fan.loci } : {})}
    />
  )
}

/**
 * The round's uncited documents as one dashed card: „+2 abgerufen, nicht
 * zitiert“ with their names. While the answer runs nothing is cited yet, so it
 * reads „+2 weitere“. A button: it opens the folded cards in place.
 *
 * Open, it is no longer a card: the cards it held stand above it, and what
 * remains is the way back, a plain muted line under the last of them. The
 * button's name is what it shows (the count and the names, never a label that
 * hides them); the tab describes it.
 */
const UncitedFoldCard: FC<{
  slot: Extract<ColumnSlot, { type: 'fold' }>
  onToggle: () => void
}> = ({ slot, onToggle }) => {
  const t = useTranslations(chatCopy)
  const tabId = useId()
  const U = 'thinking.node.uncited.'
  if (slot.expanded) {
    return (
      <div role="listitem" data-testid="uncited-fold" className="mt-1.5 flex min-w-0">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded
          className={cn(
            'text-muted-foreground duration-snap pointer-fine:hover:text-foreground inline-flex min-h-8 items-center gap-1 rounded-md px-1 text-left text-[13px] leading-[19px] transition-[color,scale] ease-out outline-none active:scale-[0.985] motion-reduce:transition-none pointer-coarse:min-h-11',
            FOCUS_RING
          )}
        >
          <ChevronUp aria-hidden="true" className="size-3.5 shrink-0" />
          {t(`${U}hide`)}
        </button>
      </div>
    )
  }
  return (
    <div
      role="listitem"
      data-testid="uncited-fold"
      className={cn(
        'duration-quick flex min-w-0 flex-col transition-opacity ease-out motion-reduce:transition-none',
        slot.receded && RECEDED
      )}
    >
      {/* Card-white on the muted panel and the phone's muted box alike: the
          cited tabs carry their kind's tint, this one only its words. */}
      <SectionLabel id={tabId} className={cn(FOLDER_TAB, 'bg-card text-muted-foreground')}>
        {t(`${U}${slot.live ? 'pillLive' : 'pill'}`)}
      </SectionLabel>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={false}
        aria-describedby={tabId}
        className={cn(
          'bg-muted/40 duration-snap pointer-fine:hover:bg-muted flex min-h-11 w-full min-w-0 flex-col rounded-lg border border-dashed px-3 py-2.5 text-left transition-[background-color,scale] ease-out outline-none active:scale-[0.985] motion-reduce:transition-none',
          FOCUS_RING
        )}
      >
        <span className="text-foreground/80 text-sm leading-5 font-semibold">
          {t(`${U}${slot.live ? 'nameLive' : 'name'}`, { count: slot.count })}
        </span>
        <span className="text-muted-foreground line-clamp-2 text-[13px] leading-[19px] hyphens-auto [overflow-wrap:break-word] [hyphenate-limit-chars:10_4_4]">
          {slot.names.join(', ')}
        </span>
      </button>
    </div>
  )
}

const FindingsFlowNode: FC<NodeProps<Node<FindingsData>>> = ({ data }) => (
  <div
    className={cn(
      'bg-card w-[var(--banner-w)] max-w-full rounded-xl border px-4 py-3 text-left shadow-xs',
      // Pending reads as in-flight rather than as an empty result: dashed
      // hairline, no fill — the same visual grammar the uncited fold uses.
      data.pending && 'border-dashed bg-transparent shadow-none'
    )}
  >
    {data.targets.map((h) => (
      <Handle
        key={h.id}
        id={h.id}
        type="target"
        position={Position.Top}
        style={{ ...H, left: h.left }}
      />
    ))}
    <Eyebrow>{data.label}</Eyebrow>
    {data.pendingNote && (
      <p className="text-muted-foreground mt-1 text-sm leading-relaxed">{data.pendingNote}</p>
    )}
    {/* What the answer stands on, as two columns that become one on a phone:
        a label on the left, its lines on the right. „Offen“ sits on its own
        tinted band, with a ring for its shape — a gap, not an alarm. */}
    {data.basis.length > 0 && (
      <dl
        className={cn(
          'mt-2 grid gap-y-2 text-sm leading-[21px]',
          data.compact ? 'grid-cols-1' : 'grid-cols-[124px_minmax(0,1fr)] gap-x-3'
        )}
      >
        {data.basis.map((group) => (
          <div
            key={group.label}
            data-testid={group.open ? 'basis-open' : 'basis-group'}
            className={cn(
              'col-span-full grid grid-cols-subgrid gap-y-0.5',
              group.open && 'bg-muted -mx-3 mt-1 rounded-lg px-3 py-2.5'
            )}
          >
            <dt
              className={cn(
                data.compact && 'text-[13px] leading-[19px]',
                group.open
                  ? 'text-foreground inline-flex items-start gap-1.5 font-semibold'
                  : 'text-muted-foreground'
              )}
            >
              {group.open && (
                <Circle aria-hidden strokeWidth={2.4} className="mt-[5px] size-3 shrink-0" />
              )}
              {group.label}
            </dt>
            <dd className="min-w-0 [overflow-wrap:anywhere]">
              {/* A cited line leads with the answer's own marker, so „1“
                  here peeks and opens what „1“ in the prose does. */}
              {group.lines.map((line) => (
                <p key={line.text}>
                  {line.numbers.length > 0 && (
                    <>
                      <CitationMarkers numbers={line.numbers} className="font-semibold tabular-nums" />{' '}
                    </>
                  )}
                  {line.text}
                </p>
              ))}
            </dd>
          </div>
        ))}
      </dl>
    )}
    {data.truncation && (
      // Same muted register as the lines above it: this is a fact about the
      // evidence, not a warning — the node is not tinted, bordered or
      // iconified for it, because "the search stopped" is not an error.
      <p className="border-base text-muted-foreground mt-1.5 border-t pt-1.5 text-xs leading-relaxed">
        {data.truncation.before}
        {data.truncation.step && (
          <span className={data.truncation.mono ? 'font-mono' : undefined}>
            {data.truncation.step}
          </span>
        )}
        {data.truncation.after}
      </p>
    )}
    {data.limits && (
      <div className="border-base mt-1.5 border-t pt-1.5">
        <Eyebrow>{data.limits.label}</Eyebrow>
        {data.limits.lines.map((line) => (
          <p
            key={line.text}
            className={cn(
              'mt-0.5 text-xs leading-relaxed',
              line.warn ? 'text-warning' : 'text-muted-foreground'
            )}
          >
            {line.text}
          </p>
        ))}
      </div>
    )}
    <Handle
      id={data.source.id}
      type="source"
      position={Position.Bottom}
      style={{ ...H, left: data.source.left }}
    />
  </div>
)

const nodeTypes = {
  framing: FramingFlowNode,
  round: RoundFlowNode,
  sourceColumn: SourceColumnFlowNode,
  findings: FindingsFlowNode,
}

export interface ReasoningFlowProps {
  steps: StoredThinkingStep[]
  userQuestion: string
  answerConfidence?: 'low' | 'medium' | 'high'
  citations?: CitationSource[]
  escalationReason?: string
  /**
   * The backend's own account of this turn's retrieval rounds. When a round is
   * in it (matched by `index`), the fan under that round is the LEDGER's docs
   * — each at the page THAT round read, and marked when an earlier round had
   * already shown the file. A round the ledger does not have keeps the
   * filename match, which is what every turn before the ledger had.
   */
  retrievalLedger?: RetrievalLedger
  /** Turn is still streaming — the connectors into the newest row march and the graph keeps growing. */
  live?: boolean
  /**
   * The citation model of these steps and citations, when the caller has built
   * it already (ChatThinking counts its sources from it). Built here otherwise;
   * building it twice per step cost the phone twice.
   */
  sourceCards?: CitedDocument[]
}

// ── layout constants ──────────────────────────────────────────────────────────
/**
 * Narrowest a source card may get before we stack instead of adding a column.
 *
 * 172: a hyphenated twelve-letter compound („Brandschutzkonzept“) keeps a
 * syllable of four on each line, where 146 cut it into three-letter shards.
 * Still three columns in the 680px chat column; two from 544px down, then one.
 */
const MIN_COL_W = 172
/** Widest a single column grows to, so 2 sources don't become two half-pages. */
const MAX_COL_W = 236
/**
 * At or below this content width the fan always collapses to ONE grouped
 * column. A phone would arithmetically fit two ~160px columns, but a source
 * card's name is a two-line clamp — side-by-side at that width it turns into
 * two columns of ellipses. This is a readability floor, not a fitting rule.
 */
const GROUPED_MAX_W = 420
const COL_GAP = 14
/** Vertical gap between graph rows (framing / sources / assessment). */
const ROW_GAP = 40
/**
 * Container bottom padding below the last row.
 *
 * Must clear what renders OUTSIDE a node's border box, because React Flow's
 * pane clips: `shadow-xs` bleeds a few px past the last row.
 */
const PAD = 24
/** Floor for the content width, so a not-yet-measured container still builds. */
const MIN_CONTENT_W = 220
/**
 * Width assumed when the container reports none — a typical desktop chat
 * column. `clientWidth` is 0 in jsdom and in any display:none ancestor, and the
 * graph must still render there; the ResizeObserver corrects it on the first
 * real measurement (before paint, since it runs in a layout effect).
 */
const FALLBACK_W = 680

/** How the sources are packed into columns for a given container width. */
export interface FanLayout {
  /** Card indices per column, left→right. Empty when the turn has no sources. */
  columns: number[][]
  colW: number
  gap: number
  /** x of the first column (the fan is centred in the content width). */
  fanX: number
  contentW: number
  /**
   * Narrow container → the single column wears the grouped "Quellen"
   * container. Note this is about the WIDTH, not the column count: one source
   * on a desktop is a single normal card, not a full-width box.
   */
  grouped: boolean
}

/**
 * Pack `cardCount` source cards into as many columns as `width` affords.
 *
 * Exported for tests: this is the whole responsive story, and the property that
 * matters is that the desktop chat column NEVER degrades to a single column
 * just because a turn touched a lot of documents — it packs wider instead.
 */
export function planFan(width: number, cardCount: number): FanLayout {
  const contentW = Math.max(MIN_CONTENT_W, Math.floor(width) || MIN_CONTENT_W)
  const grouped = contentW <= GROUPED_MAX_W
  if (cardCount <= 0) {
    return { columns: [], colW: contentW, gap: COL_GAP, fanX: 0, contentW, grouped: false }
  }
  const capacity = grouped
    ? 1
    : Math.max(1, Math.floor((contentW + COL_GAP) / (MIN_COL_W + COL_GAP)))
  const count = Math.min(cardCount, capacity)
  const colW = grouped
    ? contentW
    : Math.min(MAX_COL_W, Math.floor((contentW - (count - 1) * COL_GAP) / count))
  const fanW = count * colW + (count - 1) * COL_GAP
  const fanX = Math.max(0, Math.round((contentW - fanW) / 2))

  // Balanced, reading-order distribution: the remainder lands on the LEFT
  // columns so the row is never one lone tall column at the end.
  const base = Math.floor(cardCount / count)
  const remainder = cardCount % count
  const columns: number[][] = []
  let next = 0
  for (let c = 0; c < count; c++) {
    const size = base + (c < remainder ? 1 : 0)
    columns.push(Array.from({ length: size }, () => next++))
  }
  return { columns, colW, gap: COL_GAP, fanX, contentW, grouped }
}

/**
 * {@link planFan} over a fan's slots. An OPEN fold is no card: it is the way
 * back, a line under the last uncited card, so it takes no column of its own
 * and hangs under that card, which reading order puts in the last column.
 */
function packSlots(width: number, slots: readonly ColumnSlot[]): FanLayout {
  const last = slots.at(-1)
  const openFold = last?.type === 'fold' && last.expanded
  if (!openFold) return planFan(width, slots.length)
  const packed = planFan(width, slots.length - 1)
  const columns = packed.columns.map((column, i, all) =>
    i === all.length - 1 ? [...column, slots.length - 1] : column
  )
  return { ...packed, columns }
}

/** Corner rounding on every connector. */
const EDGE_RADIUS = 12
/**
 * Where the shared elbow sits, as a distance from the banner the edges leave
 * (split) or enter (merge) — i.e. the middle of ROW_GAP. Keep it at least
 * EDGE_RADIUS away from BOTH rows: the tallest column ends exactly ROW_GAP
 * above the assessment, so an elbow closer than one corner radius leaves
 * getSmoothStepPath no room and it degenerates into a doubled, kinked line.
 */
const TRUNK_ELBOW = ROW_GAP / 2

/**
 * A connector whose bend is pinned to a SHARED height instead of its own
 * midpoint.
 *
 * `getSmoothStepPath` takes a `centerY` — the y of the horizontal segment — but
 * React Flow's built-in `SmoothStepEdge` only forwards `borderRadius`/`offset`
 * from `pathOptions`, so the bend defaults to each edge's own midpoint. With
 * columns of unequal height that scatters the merge into a staircase: every
 * edge turns at a different height on its way into the assessment.
 *
 * Pinning `centerY` to a fixed offset from the banner all these edges share
 * puts every bend on ONE line, so the fan reads as a single trunk that splits
 * and then merges — which is the whole point of the shape.
 */
function trunkEdge(anchor: 'source' | 'target'): FC<EdgeProps> {
  const TrunkEdge: FC<EdgeProps> = ({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    markerEnd,
    style,
  }) => {
    const [path] = getSmoothStepPath({
      sourceX,
      sourceY,
      sourcePosition,
      targetX,
      targetY,
      targetPosition,
      borderRadius: EDGE_RADIUS,
      // Split: pinned just below the framing card, which every edge leaves.
      // Merge: pinned just above the assessment, which every edge enters.
      centerY: anchor === 'source' ? sourceY + TRUNK_ELBOW : targetY - TRUNK_ELBOW,
      // Pin the x bend to the SHARED end too. Left to compute its own centerX,
      // the path takes a second bend at the horizontal midpoint — a sub-pixel
      // jog that renders as a doubled hairline along the trunk.
      centerX: anchor === 'source' ? sourceX : targetX,
      // `offset` is the minimum straight run out of a handle, and it OVERRIDES
      // centerY when the two disagree. The default (20) is the full elbow
      // distance, so the tallest column — which ends exactly ROW_GAP above the
      // assessment — got pushed off the shared bar by a pixel or two, drawing
      // the trunk as two near-parallel lines. Keep it well under TRUNK_ELBOW.
      offset: TRUNK_ELBOW / 2,
    })
    return <BaseEdge path={path} markerEnd={markerEnd} style={style} interactionWidth={0} />
  }
  TrunkEdge.displayName = anchor === 'source' ? 'SplitEdge' : 'MergeEdge'
  return TrunkEdge
}

const edgeTypes = {
  split: trunkEdge('source'),
  merge: trunkEdge('target'),
}

/** One connector. `type` picks which end its shared elbow is pinned to. */
function edge(
  source: string,
  sourceHandle: string,
  target: string,
  targetHandle: string,
  type: 'split' | 'merge' = 'merge'
): Edge {
  return {
    id: `${source}:${sourceHandle}->${target}:${targetHandle}`,
    source,
    sourceHandle,
    target,
    targetHandle,
    type,
    style: { stroke: EDGE_STROKE, strokeWidth: 1.5 },
  }
}

/** Copy for the caveat lines, all under one dictionary group. */
const LIMIT = 'thinking.node.limits.'

/**
 * A cut-off deep run needs at least this much clock behind it before the panel
 * names a duration. Below a minute the sentence would read "stopped after 0
 * minutes", which is a true number that says nothing — and the cause line
 * ("reached its time limit") already carries the fact that matters.
 */
const MIN_REPORTED_MINUTES = 1

/**
 * The assessment node's caveat lines, in the reader's own nouns.
 *
 * Every one of these is derived from a technical-channel record, so this is the
 * one place in the trace that turns telemetry into a statement — and the
 * translation is deliberately lossy. `report_chars` never appears: a character
 * count is the textbook case of a fact that only names a mechanism, and the
 * reader already learns what it would have told them from whether the findings
 * reached the answer at all. What DOES survive is what an architect can act on:
 * the research stopped early, this much of it was usable, nothing was verified.
 *
 * A cutoff yields at most two lines — the cause and its consequence in one
 * sentence pair, then what had been gathered by then — so the block stays
 * readable when a turn was both cut off and degraded.
 */
/**
 * Dictionary key per degradation, total over the closed set: a token added to
 * `ANSWER_DEGRADATIONS` without a line here fails the typecheck, rather than
 * rendering as whichever line a fallback branch happened to pick.
 */
const DEGRADATION_KEYS: Record<AnswerDegradation, string> = {
  no_report_file: 'noReport',
  no_valid_citations: 'noCitations',
  cards_generation_failed: 'noCards',
  basis_unread: 'basisUnread',
}

function limitations(
  cutoff: DeepResearchCutoff | null,
  degradations: AnswerDegradation[],
  t: Translator
): Array<{ text: string; warn: boolean }> {
  const lines: Array<{ text: string; warn: boolean }> = []

  if (cutoff) {
    // An unknown reason token still gets a line: THAT the run stopped early is
    // the part the reader needs, and it is true whatever ended it.
    const cause =
      cutoff.reason === 'wall_clock' ? 'time' : cutoff.reason === 'step_limit' ? 'steps' : 'other'
    const outcome = cutoff.salvaged ? 'salvaged' : 'nothing'
    lines.push({
      text: `${t(`${LIMIT}deepCutoff.${cause}`)} ${t(`${LIMIT}deepCutoff.${outcome}`)}`,
      warn: false,
    })

    // What had been gathered when the clock ran out. Zero sources is left
    // unsaid rather than counted — "0 Quellen" is a true number that reads as a
    // failure, and `nothing` above has already said the honest version of it.
    const context: string[] = []
    if (cutoff.sourceCount) {
      context.push(t(`${LIMIT}deepCutoff.sources`, { count: cutoff.sourceCount }))
    }
    // FLOORED, not rounded: "it stopped after 1 minute" is a claim, and 41
    // seconds rounded up would make the panel overstate the run by half.
    const minutes = Math.floor((cutoff.elapsedSeconds ?? 0) / 60)
    if (minutes >= MIN_REPORTED_MINUTES) {
      context.push(t(`${LIMIT}deepCutoff.after`, { minutes }))
    }
    if (context.length > 0) lines.push({ text: context.join(' '), warn: false })
  }

  for (const reason of degradations) {
    lines.push({ text: t(`${LIMIT}degraded.${DEGRADATION_KEYS[reason]}`), warn: true })
  }

  return lines
}

export interface BuiltGraph {
  nodes: Node[]
  edges: Edge[]
  /** Row groups, top→bottom, for the measured y-stacking pass. */
  rows: string[][]
}

/**
 * How many retrieval rounds a spine may show in full before the older layers
 * arrive folded.
 *
 * RESERVED, not read: every layer currently arrives expanded, because evidence
 * hidden by default reads as no evidence. The manual fold control stays — the
 * reader can still close any layer by hand — and should a turn shape arrive
 * that needs an auto-fold again, this is the dial, not a new rule.
 */
export const SPINE_FOLD_THRESHOLD = 3

/**
 * Which layers a spine of `count` rounds opens with, before the reader touches
 * anything: all of them. Exported because it is the rule, not an
 * implementation detail — `ReasoningFlow` seeds its state from it and the spec
 * asserts it directly.
 */
export function defaultFoldedRounds(_count: number): Set<number> {
  return new Set()
}

/**
 * The tools that open a passage of a document the turn already found: `read_file` on the estate
 * since ADR-0133 slice 6, `read_passage` before it and for the turns stored with it. A skill read
 * never reaches a round's tools (`retrieval_status._describe_calls` skips it), and a draft read returns
 * no documents, so a `read_file` round with documents opened the office's own.
 */
const OPEN_TOOLS: ReadonlySet<string> = new Set(['read_file', 'read_passage'])

/** Tool basename as the round records it (`tool: read_passage` → `read_passage`). */
const toolBase = (tool: string): string =>
  tool
    .trim()
    .replace(/^tool:\s*/i, '')
    .toLowerCase()

/** This layer only opened passages — it searched for nothing new. */
const onlyOpened = (tools: string[]): boolean =>
  tools.length > 0 && tools.every((tool) => OPEN_TOOLS.has(toolBase(tool)))

/**
 * WHAT a retrieval layer did, from the facts the spine already owns about it:
 * the tools it called, whether the model wrote a Thought (it concluded
 * something) and whether the fetch returned files. A layer that only opened
 * passages of files the turn already had OPENED them: it searched for nothing,
 * and a re-read at a new page is precisely the round a reader needs told apart
 * from a fresh fetch. A layer that concluded on the back of what it fetched is
 * a finding; a bare fetch that returned nothing is a search. The NUMBER on the
 * layer (`Schritt N`) is the execution order; this is the type.
 *
 * `accounted` is whether the backend's retrieval ledger holds this round. A
 * ledger round with no documents is a fetch the backend SAW return nothing —
 * a miss, and the layer says so, whatever the model concluded beside it. A
 * turn stored before the ledger existed has no such record: there an empty
 * layer may be a miss or a hit the old wire never stamped, and `Suche` stays
 * the honest word for not knowing which.
 */
/** Tools that list or open a folder: a round of only these fetched no documents, by design. */
const BROWSE_TOOLS: ReadonlySet<string> = new Set(['ls', 'glob', 'list_files'])

/**
 * Tools whose round can come back empty. A round of tools outside this set
 * (a listing, a workspace call, an IFC query) returns no documents by design,
 * so „no documents“ is no miss there (ADR-0132).
 */
const SEARCH_TOOLS: ReadonlySet<string> = new Set([
  'knowledge_search',
  'grep',
  'read_file',
  'project_lookup',
  'read_passage',
  'surface_documents',
  'web_search_tool',
  'advanced_web_search_tool',
  'ris_search_tool',
  'ris_fetch_tool',
  'ris_lookup_tool',
  'ris_catalog_lookup_tool',
])

/** A round that called tools, and none of them looks for documents. */
const searchedNothing = (tools: string[]): boolean =>
  tools.length > 0 && !tools.some((tool) => SEARCH_TOOLS.has(toolBase(tool)))

export function roundKind(
  hasThought: boolean,
  documentCount: number,
  tools: string[],
  t: Translator,
  accounted = false
): string {
  if (
    documentCount === 0 &&
    tools.length > 0 &&
    tools.every((tool) => BROWSE_TOOLS.has(toolBase(tool)))
  ) {
    return t('thinking.node.stepKindBrowse')
  }
  if (documentCount === 0 && accounted && !searchedNothing(tools))
    return t('thinking.node.stepKindNoHits')
  if (documentCount > 0 && onlyOpened(tools)) return t('thinking.node.stepKindOpen')
  if (hasThought && documentCount > 0) return t('thinking.node.stepKindFinding')
  if (hasThought) return t('thinking.node.stepKindConclusion')
  if (documentCount > 0) return t('thinking.node.stepKindRead')
  return t('thinking.node.stepKindSearch')
}

/**
 * The locus a folded single-file layer names beside the document: the cited
 * passage when the answer cited one, else nothing. A document the answer never
 * cited names NO locus — its fan card already reads "abgerufen, nicht
 * zitiert", so a fold naming a passage beside it would promise a Beleg the
 * fan withholds. Punkt wins over page — it is the finer address.
 */
function foldLocusOf(doc: CitedDocument): CitationLocus | undefined {
  const loci = citedLoci(doc)
  if (loci.length === 0) return undefined
  return (
    loci.find((locus) => locus.clause?.trim()) ??
    loci.find((locus) => typeof locus.page === 'number') ??
    loci[0]
  )
}

function foldLocusLabel(doc: CitedDocument, t: Translator): string | undefined {
  const locus = foldLocusOf(doc)
  if (!locus) return undefined
  const clause = locus.clause?.trim()
  const page = typeof locus.page === 'number' ? locus.page : undefined
  if (clause && page !== undefined)
    return t('thinking.node.roundFoldLocusClausePage', { clause, page })
  if (clause) return t('thinking.node.roundFoldLocusClause', { clause })
  if (page !== undefined) return t('thinking.node.roundFoldLocusPage', { page })
  return undefined
}

/** The name a fan slot folds to: the card's short name, else the ledger's own. */
const foldName = (slot: FanCard): string =>
  slot.card
    ? documentShortName(slot.card.fileName ?? slot.card.title, slot.card.title)
    : documentShortName(slot.name, slot.title)

/**
 * The locus beside a folded single file: the FIRST passage that round read,
 * when the ledger accounted for the round. The fan under it lists them all,
 * and a fold that fell back to the turn aggregate would name a page a
 * different round read. Without a ledger it stays the cited passage (see
 * `foldLocusOf`).
 */
const foldLocus = (slot: FanCard, t: Translator): string | undefined => {
  if (slot.loci) return slot.loci[0]?.detail
  return slot.card ? foldLocusLabel(slot.card, t) : undefined
}

/**
 * The scent of a folded fan, from the round's own slots: one file is document +
 * its locus (bare name when there is none to name — see `foldLocus`), two
 * files are both names, three or more are count + first name + "u.a.". Short
 * names throughout — the edition tail says nothing a folded layer needs. Empty
 * when the fetch returned nothing (the layer is then not foldable, so this
 * never renders).
 */
function foldSummary(roundCards: FanCard[], t: Translator): string {
  const names = roundCards.map(foldName)
  if (names.length === 0) return ''
  if (names.length === 1) {
    const locus = foldLocus(roundCards[0]!, t)
    return locus
      ? t('thinking.node.roundFoldOne', { name: names[0], locus })
      : t('thinking.node.roundFoldOneBare', { name: names[0] })
  }
  if (names.length === 2)
    return t('thinking.node.roundFoldTwo', { first: names[0], second: names[1] })
  return t('thinking.node.roundFoldMany', { count: names.length, first: names[0] })
}

/**
 * The fold state of the spine, and the way back out of it.
 *
 * Passed in rather than held here because `buildGraph` is pure: the state lives
 * in `ReasoningFlow` (see the note there on where it does NOT live), and a spec
 * can build any fold configuration it wants without rendering.
 */
export interface SpineFolding {
  folded: ReadonlySet<number>
  onToggle: (index: number) => void
}

/**
 * What the reader has tapped, and how to change it: the link between rows and
 * cards, and which rounds' uncited cards are open. Passed in rather than held
 * here for the reason `SpineFolding` is: `buildGraph` is pure.
 */
export interface GraphInteraction {
  selection: LinkSelection | null
  onSelect: (selection: LinkSelection | null) => void
  /** Fans (by key) whose uncited cards the reader opened. */
  openFolds: ReadonlySet<string>
  onToggleFold: (key: string) => void
}

const NO_INTERACTION: GraphInteraction = {
  selection: null,
  onSelect: () => {},
  openFolds: new Set<string>(),
  onToggleFold: () => {},
}

/** While the answer runs, a fan of more than this many shows its first {@link LIVE_SHOWN} and folds the rest. */
const LIVE_FAN_MAX = 3
const LIVE_SHOWN = 2

/**
 * Which of a fan's documents stand as cards and which fold into the dashed
 * „+N abgerufen, nicht zitiert“ card. Settled, the cited ones stand; while the
 * answer runs nothing is cited yet, so the first few stand and the rest fold
 * as „+N weitere“. Exported for its spec.
 */
export function partitionFan(
  slots: readonly FanCard[],
  live: boolean
): { shown: FanCard[]; folded: FanCard[] } {
  if (live) {
    if (slots.length <= LIVE_FAN_MAX) return { shown: [...slots], folded: [] }
    return { shown: slots.slice(0, LIVE_SHOWN), folded: slots.slice(LIVE_SHOWN) }
  }
  const cited = (slot: FanCard) => Boolean(slot.card && isCited(slot.card))
  return { shown: slots.filter(cited), folded: slots.filter((slot) => !cited(slot)) }
}

/** A fan's slots with the prefetch's merged in front, once each by document. */
const mergeFans = (first: readonly FanCard[], second: readonly FanCard[]): FanCard[] => {
  const seen = new Set<string>()
  const out: FanCard[] = []
  for (const slot of [...first, ...second]) {
    const key = normalizeFileName(slot.card?.fileName ?? slot.name) || slot.key
    if (seen.has(key)) continue
    seen.add(key)
    out.push(slot)
  }
  return out
}

/**
 * Pure graph builder — exported for structural regression tests. Produces the
 * nodes (with per-column handle specs), the parallel wiring, and the row groups
 * for the measured layout pass. See ReasoningFlow.spec.
 */
export function buildGraph(
  props: ReasoningFlowProps,
  t: Translator,
  layout: FanLayout,
  cards: CitedDocument[],
  /**
   * Which checkpoint layers are folded, and how to unfold one. Absent means
   * "nothing is folded and the control does nothing" — the right answer for a
   * structural test that is not about folding.
   */
  folding: SpineFolding = { folded: new Set<number>(), onToggle: () => {} },
  /** `retrievalRounds(props.steps)`, when the caller has parsed it already. */
  rounds: RetrievalRound[] = withActionRounds(retrievalRounds(props.steps), props.steps),
  interaction: GraphInteraction = NO_INTERACTION
): BuiltGraph {
  const work = workRounds(props.steps)
  const live = Boolean(props.live)
  // Phone width, whether or not the turn has a fan to group: the rows and the
  // last card stack their parts instead of setting them side by side.
  const compact = layout.contentW <= GROUPED_MAX_W
  const { selection } = interaction
  // The decision's prefetch (round 0) is no step a reader sees: its documents
  // join the first fan like any other source (ADR-0132).
  const prefetch = prefetchRounds(props.steps)
  const visible = rounds.filter((round) => !prefetch.has(round.index))
  const prefetched = rounds.filter((round) => prefetch.has(round.index))

  // The calls that returned each document, for the row↔card link.
  const callsOf = callIdsByDocument(props.steps, normalizeFileName)
  const slotCalls = (slot: FanCard): string[] => {
    const names = [slot.name, slot.card?.fileName, slot.card?.title].filter(
      (name): name is string => Boolean(name)
    )
    return [...new Set(names.flatMap((name) => callsOf.get(normalizeFileName(name)) ?? []))]
  }
  const linkOf = (key: string, callIds: string[]): CardLink | undefined => {
    if (!selection) return undefined
    if (selection.key === key) return 'selected'
    return isLinked(selection, callIds) ? 'linked' : 'receded'
  }

  /** A fan's column slots: the standing cards, then the fold of the rest. */
  const columnSlots = (fanKey: string, slots: readonly FanCard[]): ColumnSlot[] => {
    const { shown, folded } = partitionFan(slots, live)
    const open = interaction.openFolds.has(fanKey)
    const standing = open ? [...shown, ...folded] : shown
    const out: ColumnSlot[] = standing.map((fan) => {
      const callIds = slotCalls(fan)
      const link = linkOf(fan.key, callIds)
      return { type: 'card', fan, callIds, ...(link ? { link } : {}) }
    })
    if (folded.length > 0) {
      out.push({
        type: 'fold',
        key: fanKey,
        count: folded.length,
        names: folded.map((fan) =>
          documentShortName(fan.card?.fileName ?? fan.name, fan.card?.title ?? fan.title)
        ),
        folded,
        live,
        expanded: open,
        receded: selection !== null && !folded.some((fan) => isLinked(selection, slotCalls(fan))),
      })
    }
    return out
  }

  // While the turn streams there is no answer yet, but the graph still gets its
  // converge node — in a pending state. Without it the source columns end in
  // mid-air and the whole shape jumps the instant the answer lands.
  const spine = visible.length >= 2 || (visible.length === 1 && work.length > 0)
  const pendingFindings = live && (cards.length > 0 || spine)
  // Only once the turn has landed: while it streams, the graph already has its
  // pending converge node, and the answer's own note does not exist yet.
  const truncation = live ? null : researchTruncation(props.steps)
  // The two records a DEEP run keeps about its own limits, under the same live gate.
  const cutoff = live ? null : deepResearchCutoff(props.steps)
  const degradations = live ? [] : answerDegradations(props.steps)
  const limitLines = limitations(cutoff, degradations, t)
  // „Grundlagen · Entwurf“: the cited law, the cited project and office
  // sources, and what stayed open. Read off the turn, never invented.
  const basis = live ? null : basisLines(t, cards)
  const open = live ? [] : openPoints(t, work, cards)
  const B = 'thinking.node.basis.'
  const basisGroups: FindingsData['basis'] = basis
    ? [
        ...(basis.law.length > 0 ? [{ label: t(`${B}law`), lines: basis.law }] : []),
        ...(basis.evidence.length > 0 ? [{ label: t(`${B}evidence`), lines: basis.evidence }] : []),
        ...(open.length > 0
          ? [{ label: t(`${B}open`), lines: open.map((text) => ({ numbers: [], text })), open: true }]
          : []),
      ]
    : []
  const hasFindings =
    pendingFindings || basisGroups.length > 0 || Boolean(truncation) || limitLines.length > 0

  const convergeId = hasFindings ? 'findings' : null

  // ONE centred anchor on each banner, both directions, unconditional: see the
  // module header on structural handles.
  const framingSources: HandleSpec[] = [CENTRE_BOTTOM]
  const convergeTargets: HandleSpec[] = [CENTRE_TOP]

  const framingData: FramingData = {
    label: t('thinking.node.framingTab'),
    question: props.userQuestion.trim()
      ? t('thinking.node.framingQuestion', { question: quoteQuery(t, props.userQuestion) })
      : t('thinking.node.framingTitle'),
    escalation: props.escalationReason?.trim()
      ? t('thinking.escalationNarration', { reason: props.escalationReason.trim() })
      : undefined,
    sources: framingSources,
  }
  /**
   * The truncation sentence, split around the step name, resolved through the
   * SAME authority the "Ausgeführt:" chips use: a reader-facing noun where one
   * exists, otherwise the bare tool id shown as an id (`mono`).
   */
  const truncationLine = (() => {
    if (!truncation) return undefined
    if (!truncation.lastTool) {
      return { before: t('thinking.node.findingsTruncated'), after: '', mono: false }
    }
    const named = stepNameLabel(truncation.lastTool, t)
    const template = t('thinking.node.findingsTruncatedStep')
    const [before = '', after = ''] = template.split('{tool}')
    return { before, step: named ?? truncation.lastTool, after, mono: named === null }
  })()
  const findingsData: FindingsData | null = hasFindings
    ? {
        label: pendingFindings ? t(`${B}pendingLabel`) : t(`${B}label`),
        pending: pendingFindings,
        ...(pendingFindings ? { pendingNote: t(`${B}pending`) } : {}),
        basis: basisGroups,
        compact,
        truncation: truncationLine,
        limits:
          limitLines.length > 0 ? { label: t(`${LIMIT}label`), lines: limitLines } : undefined,
        targets: convergeTargets,
        source: CENTRE_OUT,
      }
    : null
  const nodes: Node[] = []
  const edges: Edge[] = []

  // One retrieval stays the old fan. Two or more are a spine: each checkpoint
  // hangs the files THAT fetch returned, then the next conclusion. The body
  // is the thought, never the query (PF-12). A turn with calls drawn
  // (ADR-0132) is a spine even in one round: the calls sit on its node.
  const roundIds = spine ? visible.map((_, i) => `round-${i}`) : []

  const actionLabels = (tools: string[]): string[] => {
    const out: string[] = []
    const seen = new Set<string>()
    for (const tool of tools) {
      const label = stepNameLabel(tool, t)
      if (!label || seen.has(label)) continue
      seen.add(label)
      out.push(label)
    }
    return out
  }

  // The prefetch's documents, in front of the first step's own.
  const prefetchSlots = prefetched.flatMap((round) => roundFan(round, cards, props.retrievalLedger))

  // A folded layer keeps its cards (the count is the whole point of the fold)
  // and contributes NO column nodes: the fan is gone from the graph, not merely
  // hidden with CSS, so the measured stacking pass reclaims its row and the
  // checkpoint wires straight into the next one.
  const fans = spine
    ? visible.map((round, i) => {
        const own = roundFan(round, cards, props.retrievalLedger)
        const roundCards = i === 0 ? mergeFans(prefetchSlots, own) : own
        const slots = columnSlots(`round-${round.index}`, roundCards)
        const packed = packSlots(layout.contentW, slots)
        const folded = folding.folded.has(i)
        return {
          roundCards,
          slots,
          packed,
          folded,
          ids: folded ? [] : packed.columns.map((_, c) => `r${i}-col-${c}`),
        }
      })
    : []

  const pushColumns = (ids: string[], packed: FanLayout, slots: ColumnSlot[]) => {
    // Driven by the ID list, not by the packing: a FOLDED layer keeps its
    // packing and is given no ids.
    if (ids.length === 0) return
    const xOf = (i: number) => packed.fanX + i * (packed.colW + packed.gap)
    packed.columns.slice(0, ids.length).forEach((indices, i) => {
      const cards = indices.map((idx) => slots[idx]!)
      const first = cards[0]
      const tabbed = first?.type === 'fold' ? !first.expanded : Boolean(first?.fan.card)
      const columnData: SourceColumnData = {
        cards,
        inTop: tabbed && !packed.grouped ? FOLDER_TAB_H : 0,
        grouped: packed.grouped,
        groupLabel: t('thinking.sourcesFanOut'),
        live,
        colW: packed.colW,
        onSelect: interaction.onSelect,
        onToggleFold: interaction.onToggleFold,
      }
      nodes.push({
        id: ids[i]!,
        type: 'sourceColumn',
        position: { x: xOf(i), y: 0 },
        data: columnData as unknown as Record<string, unknown>,
      })
    })
  }

  const linking: RowLinking = {
    selection,
    onSelect: interaction.onSelect,
    // Only a call that returned a card links its row: a listing or a search for files returns none.
    carded: new Set([...callsOf.values()].flat()),
    nameOf: (target) => {
      const card = cardForTarget(target, cards)
      return card ? cardName(card) : undefined
    },
  }
  nodes.push({
    id: 'framing',
    type: 'framing',
    position: { x: 0, y: 0 },
    data: framingData as Record<string, unknown>,
  })
  const turnFan = spine
    ? null
    : (() => {
        const slots = columnSlots(
          'turn',
          cards.map((card) => ({ key: card.id, card, name: card.fileName ?? card.title }))
        )
        return { slots, packed: packSlots(layout.contentW, slots) }
      })()
  const columnIds = turnFan ? turnFan.packed.columns.map((_, i) => `col-${i}`) : []
  if (spine) {
    visible.forEach((round, i) => {
      const text = round.reason?.trim() ?? ''
      const fan = fans[i]!
      // DOCUMENTS, not hits: a slot is one file with every passage this round
      // read of it.
      const documentCount = fan.roundCards.length
      const accounted = props.retrievalLedger?.some((entry) => entry.index === round.index) ?? false
      const calls = work.find((entry) => entry.round === round.index)
      const roundData: RoundData = {
        label: t('thinking.node.stepTab', { n: i + 1 }),
        // A step with calls is named by what they did („Suchen“, „Lesen“); one
        // stored before them by what its round's tools and files say.
        sub: calls
          ? t(`thinking.work.kind.${workKind(calls)}`)
          : roundKind(text.length > 0, documentCount, round.tools, t, accounted),
        text,
        actions: actionLabels(round.tools),
        ...(calls ? { calls } : {}),
        compact,
        linking,
        targets: [CENTRE_TOP],
        sources: [CENTRE_BOTTOM],
        // A step with rows has none of its own fold: the rows are its controls,
        // and the Herleitung as a whole folds in its header.
        foldable: !calls && documentCount > 0,
        folded: fan.folded,
        foldSummary: foldSummary(fan.roundCards, t),
        toggleLabel: t(fan.folded ? 'thinking.node.roundUnfold' : 'thinking.node.roundFold', {
          n: i + 1,
        }),
        onToggle: () => folding.onToggle(i),
      }
      nodes.push({
        id: roundIds[i]!,
        type: 'round',
        position: { x: 0, y: 0 },
        data: roundData as unknown as Record<string, unknown>,
      })
      pushColumns(fan.ids, fan.packed, fan.slots)
    })
  } else if (turnFan) {
    pushColumns(columnIds, turnFan.packed, turnFan.slots)
  }
  if (findingsData) {
    nodes.push({
      id: 'findings',
      type: 'findings',
      position: { x: 0, y: 0 },
      data: findingsData as Record<string, unknown>,
    })
  }

  // Wiring: a single retrieval still fans framing → columns → assessment
  // (parallel, never a source-to-source chain). Two or more retrievals put
  // each checkpoint above the files THAT fetch returned; the next conclusion
  // hangs off that fan's merge.
  if (spine) {
    edges.push(edge('framing', 'c-bottom', roundIds[0]!, 'c-top'))
    visible.forEach((_, i) => {
      const roundId = roundIds[i]!
      const { ids } = fans[i]!
      const next = i < visible.length - 1 ? roundIds[i + 1]! : convergeId
      if (ids.length > 0) {
        ids.forEach((cid) => edges.push(edge(roundId, 'c-bottom', cid, 'in', 'split')))
        if (next) ids.forEach((cid) => edges.push(edge(cid, 'out', next, 'c-top', 'merge')))
      } else if (next) {
        edges.push(edge(roundId, 'c-bottom', next, 'c-top'))
      }
    })
  } else {
    const fanFrom = 'framing'
    if (columnIds.length > 0) {
      columnIds.forEach((cid) => edges.push(edge(fanFrom, 'c-bottom', cid, 'in', 'split')))
      if (convergeId)
        columnIds.forEach((cid) => edges.push(edge(cid, 'out', convergeId, 'c-top', 'merge')))
    } else if (convergeId) {
      edges.push(edge(fanFrom, 'c-bottom', convergeId, 'c-top'))
    }
  }

  // Row groups for the measured stacking pass — every column of one fan
  // shares a row, so the next checkpoint clears the TALLEST column of this
  // fetch, not a mix of two fetches.
  const rows: string[][] = [['framing']]
  if (spine) {
    fans.forEach((fan, i) => {
      rows.push([roundIds[i]!])
      if (fan.ids.length > 0) rows.push(fan.ids)
    })
  } else if (columnIds.length > 0) {
    rows.push(columnIds)
  }
  if (findingsData) rows.push(['findings'])

  return { nodes, edges, rows }
}

/**
 * Is a rebuilt node's data the same as what the node already shows? Compared
 * by value, because `buildGraph` builds every node afresh. Functions count as
 * equal: the ones in node data are labels and handlers rebuilt from the same
 * translations and props, and they do not change what a node draws; the fold
 * toggle reads the round count through a ref for that reason. Exported for its
 * own spec.
 */
export function sameNodeData(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a === 'function' && typeof b === 'function') return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map && b instanceof Map) || a.size !== b.size) return false
    for (const [key, value] of a) if (!b.has(key) || !sameNodeData(value, b.get(key))) return false
    return true
  }
  if (a instanceof Set || b instanceof Set) {
    if (!(a instanceof Set && b instanceof Set) || a.size !== b.size) return false
    for (const value of a) if (!b.has(value)) return false
    return true
  }
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime()
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!(Array.isArray(a) && Array.isArray(b)) || a.length !== b.length) return false
    return a.every((value, i) => sameNodeData(value, b[i]))
  }
  const aFields: Record<string, unknown> = { ...a }
  const bFields: Record<string, unknown> = { ...b }
  const keys = Object.keys(aFields)
  if (keys.length !== Object.keys(bFields).length) return false
  return keys.every((key) => key in bFields && sameNodeData(aFields[key], bFields[key]))
}

// Module constants, not literals in the JSX: React Flow compares these by
// identity, and a new object on every ReasoningFlow render re-rendered its
// GraphView, FlowRenderer and ZoomPane each time (React performance audit, 2026-09).
const DEFAULT_VIEWPORT = { x: 0, y: 0, zoom: 1 }
const PRO_OPTIONS = { hideAttribution: true }

/**
 * The edges as React Flow draws them: the connectors INTO `newestRow` get the
 * library's own `animated` flag (the marching `dashdraw` dash), every other
 * connector stays solid. Pass an empty row for a settled graph. Exported for
 * its spec.
 */
export function animateFrontier(edges: Edge[], newestRow: readonly string[]): Edge[] {
  if (newestRow.length === 0) return edges
  const frontier = new Set(newestRow)
  return edges.map((e) => (frontier.has(e.target) ? { ...e, animated: true } : e))
}

/**
 * Keep the previous edge object wherever a rebuilt edge says the same thing.
 * `buildGraph` makes every edge afresh, and React Flow re-renders an edge
 * whose object changed; this is the edge half of what `sameNodeData` does for
 * the nodes. Exported for its spec.
 */
export function keepEdgeIdentity(prev: readonly Edge[], next: Edge[]): Edge[] {
  if (prev.length === 0) return next
  const prevById = new Map(prev.map((e) => [e.id, e]))
  const kept = next.map((e) => {
    const old = prevById.get(e.id)
    return old && sameNodeData(old, e) ? old : e
  })
  const unchanged = kept.length === prev.length && kept.every((e, i) => e === prev[i])
  return unchanged ? (prev as Edge[]) : kept
}

const FlowInner: FC<{ built: BuiltGraph; layout: FanLayout; live: boolean }> = ({
  built,
  layout,
  live,
}) => {
  const t = useTranslations(chatCopy)
  const { nodes, edges, rows } = built
  const initialized = useNodesInitialized()
  const paneRef = useRef<HTMLDivElement>(null)
  const [rfNodes, setRfNodes] = useState<Node[]>(nodes)
  const [height, setHeight] = useState<number | null>(null)
  // Lifts once, after the first measured layout. Reflows afterwards (resize,
  // streaming, column re-packing) keep the graph visible — fading on every
  // relayout is exactly the flicker this replaced.
  const [laidOut, setLaidOut] = useState(false)
  /** Last measured y per row index — seeds nodes that appear mid-stream. */
  const rowYRef = useRef<number[]>([])

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => setRfNodes((nds) => applyNodeChanges(changes, nds)),
    []
  )

  /** Row index a node belongs to, for seeding a newly-streamed node's y. */
  const rowIndexById = useMemo(() => {
    const map = new Map<string, number>()
    rows.forEach((row, i) => row.forEach((id) => map.set(id, i)))
    return map
  }, [rows])

  // Sync the derived graph into the controlled node list. Data (streamed text,
  // new source cards) and x always come from the fresh build; y and the measured
  // size are carried over from the node we already have, so an update never
  // resets the layout to the provisional y=0 stack.
  //
  // A LAYOUT effect, not a passive one: the measure→place pass below is one, so
  // as a passive effect this landed a frame later and every stream tick painted
  // the previous tick's node data sitting at the new tick's layout.
  useLayoutEffect(() => {
    setRfNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]))
      const next = nodes.map((n) => {
        const old = prevById.get(n.id)
        if (!old) {
          // A node in a row that has never been measured (the assessment
          // landing) seeds at the sentinel the
          // place pass leaves one past the last row — BELOW the graph — rather
          // than at y=0 on top of the framing card.
          const rowY = rowYRef.current[rowIndexById.get(n.id) ?? -1]
          return { ...n, position: { x: n.position.x, y: rowY ?? rowYRef.current.at(-1) ?? 0 } }
        }
        // Nothing about the node changed: keep the very object, so React Flow
        // neither re-renders nor re-measures it. Every node used to be a new
        // object on every step, and each arriving round re-rendered and
        // re-measured the whole graph: a 65–70 ms task per round on a 4×
        // throttled phone (Herleitung audit, 2026-09).
        if (
          old.position.x === n.position.x &&
          old.type === n.type &&
          sameNodeData(old.data, n.data)
        ) {
          return old
        }
        return { ...old, ...n, position: { x: n.position.x, y: old.position.y } }
      })
      const unchanged = next.length === prev.length && next.every((n, i) => n === prev[i])
      return unchanged ? prev : next
    })
  }, [nodes, rowIndexById])

  // React Flow gives a node handle bounds when it measures the element and
  // re-measures them only when the element RESIZES, so a handle that appears on
  // a node already on screen never gets bounds and every edge on it stops
  // rendering. The node components declare their handles unconditionally so
  // this cannot happen; this is the guard that keeps it that way, re-measuring
  // any node whose handle set changed under us anyway.
  const updateNodeInternals = useUpdateNodeInternals()
  const handleSigs = useMemo(() => {
    const sigs = new Map<string, string>()
    for (const n of nodes) {
      const d = n.data as {
        sources?: HandleSpec[]
        targets?: HandleSpec[]
        source?: HandleSpec
        inTop?: number
      }
      const specs = [...(d.sources ?? []), ...(d.targets ?? []), ...(d.source ? [d.source] : [])]
      // A column's `in` handle moves with its first slot's tab: a move is a
      // changed handle too, and React Flow keeps the old bounds until told.
      const moved = d.inTop !== undefined ? `;in@${d.inTop}` : ''
      sigs.set(n.id, specs.map((h) => `${h.id}@${h.left}`).join(',') + moved)
    }
    return sigs
  }, [nodes])
  const prevHandleSigs = useRef(handleSigs)
  useEffect(() => {
    const changed: string[] = []
    for (const [id, sig] of handleSigs) {
      // Only an EXISTING node matters; a new one is measured on mount anyway.
      const prev = prevHandleSigs.current.get(id)
      if (prev !== undefined && prev !== sig) changed.push(id)
    }
    prevHandleSigs.current = handleSigs
    if (changed.length > 0) updateNodeInternals(changed)
  }, [handleSigs, updateNodeInternals])

  // The connectors are solid. While the turn streams, the ones into the newest
  // row are React Flow's own `animated` edges, and nothing else in the graph
  // moves. That dash loop repaints on the main thread (a marching connector
  // measured ~245 ms of main thread per second on a 4x throttled phone,
  // Herleitung audit, 2026-09), so it is held to the frontier and to a live
  // turn: a settled graph draws no animated edge at all. People watch it to
  // see the agent work (2026-10), which is what it costs that for.
  const frontierKey = live ? (rows.at(-1) ?? []).join('|') : ''
  // The last edges handed to React Flow, so an unchanged edge keeps its object
  // (`keepEdgeIdentity`). Rewritten only when the memo recomputes, and the
  // write is idempotent, so a double render lands on the same array.
  const keptEdgesRef = useRef<Edge[]>([])
  const renderedEdges = useMemo(() => {
    const newestRow = frontierKey ? frontierKey.split('|') : []
    const kept = keepEdgeIdentity(keptEdgesRef.current, animateFrontier(edges, newestRow))
    keptEdgesRef.current = kept
    return kept
  }, [edges, frontierKey])

  const rowsKey = useMemo(() => rows.map((r) => r.join('|')).join('/'), [rows])

  // Measure → place: once every node reports a measured size, stack the rows by
  // their REAL heights and size the container to the exact content. A layout
  // effect so the provisional positions are never painted, and both updates bail
  // out when nothing moved — that bail-out is what lets this depend on `rfNodes`
  // (re-running as heights settle) without oscillating.
  //
  // The heights come off the node ELEMENTS, not off React Flow's `measured`.
  // Its copy is written by a ResizeObserver, so across a reflow it is a frame
  // behind — and for a node that ends a reflow at the size it started at, React
  // Flow emits no dimension change at all. A viewport that widens and snaps back
  // (an orientation change, a devtools pane, a full-page screenshot) therefore
  // used to strand this graph in the heights it had MID-reflow: rows overlapping
  // the next, and nothing left that would ever trigger a correction. Reading the
  // DOM in a layout effect is always current, and `contentW`/`colW` in the deps
  // guarantee a pass on both edges of the reflow, so the second one lands on the
  // real geometry.
  useLayoutEffect(() => {
    if (!initialized) return
    const pane = paneRef.current
    const measured = new Map<string, number>()
    pane?.querySelectorAll<HTMLElement>('.react-flow__node[data-id]').forEach((el) => {
      if (el.dataset.id) measured.set(el.dataset.id, el.offsetHeight)
    })
    const yById = new Map<string, number>()
    const rowY: number[] = []
    let y = 0
    rows.forEach((row, i) => {
      rowY[i] = y
      let rowH = 0
      for (const id of row) {
        yById.set(id, y)
        rowH = Math.max(rowH, measured.get(id) ?? 0)
      }
      y += rowH + ROW_GAP
    })
    // One past the last row: where a row that does not exist yet would start.
    // The re-seed above reads it so a node arriving mid-stream never appears on
    // top of the framing card.
    rowY[rows.length] = y
    rowYRef.current = rowY

    setRfNodes((prev) => {
      let moved = false
      const next = prev.map((n) => {
        const ny = yById.get(n.id)
        if (ny === undefined || n.position.y === ny) return n
        moved = true
        return { ...n, position: { ...n.position, y: ny } }
      })
      return moved ? next : prev
    })
    // A live graph only grows. At the second round the fan's nodes are replaced
    // by the spine's, and until those are measured the rows came out short: the
    // graph shrank 697 → 408 px and grew to 1009 px, and the page jumped with it
    // (Herleitung audit, 2026-09). Once the turn ends it takes its real height.
    const measuredHeight = Math.max(120, Math.ceil(Math.max(0, y - ROW_GAP)) + PAD)
    setHeight((previous) =>
      live && previous !== null ? Math.max(previous, measuredHeight) : measuredHeight
    )
    setLaidOut(true)
    // rows is covered by rowsKey (a stable string). contentW/colW are the widths
    // the nodes are sized against, so both edges of a reflow get a pass.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialized, rowsKey, rfNodes, layout.contentW, layout.colW, live])

  return (
    <div
      ref={paneRef}
      style={{
        height: height ?? undefined,
        minHeight: height ? undefined : 160,
        // The gate hides the provisional first layout and nothing else: it
        // lifts in one frame.
        opacity: laidOut ? 1 : 0,
        ['--banner-w' as string]: `${layout.contentW}px`,
        ['--source-w' as string]: `${layout.colW}px`,
      }}
      // `reasoning-flow-scrollable` hands the browser back the touch gestures
      // React Flow's stylesheet takes and this graph never uses. See the rule in
      // globals.css — without it the whole Herleitung is a dead zone under a
      // finger, and it is the tallest thing in a turn.
      className="reasoning-flow-scrollable w-full overflow-hidden"
      data-testid="reasoning-flow"
      role="group"
      aria-label={t('thinking.reasoningGraphLabel')}
    >
      <ReactFlow
        style={height ? { height } : undefined}
        nodes={rfNodes}
        edges={renderedEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        defaultViewport={DEFAULT_VIEWPORT}
        minZoom={1}
        maxZoom={1}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        // This is a read-only display graph — nothing is selectable, draggable,
        // or deletable. Leaving nodes/edges focusable makes every node an inert
        // keyboard tab stop and has the screen reader announce "press enter to
        // select / delete to remove" on content where those keys do nothing. The
        // real interactive content (fold toggles, „Quelle ansehen") are native <button>s
        // and stay reachable regardless.
        nodesFocusable={false}
        edgesFocusable={false}
        disableKeyboardA11y
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        panOnDrag={false}
        panOnScroll={false}
        preventScrolling={false}
        proOptions={PRO_OPTIONS}
      />
    </div>
  )
}

export const ReasoningFlow: FC<ReasoningFlowProps> = (props) => {
  const {
    steps,
    userQuestion,
    answerConfidence,
    citations,
    escalationReason,
    retrievalLedger,
    live,
    sourceCards,
  } = props
  const t = useTranslations(chatCopy)
  const showTechnicalReasoning = useLayoutStore((s) => s.showTechnicalReasoning)
  const containerRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const measure = () => setWidth(el.clientWidth)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /**
   * The turn's documents — retrieval fan-out AND the answer's own citations,
   * folded into one model. Feeding both in is what lets a card in this fan say
   * which `[N]` it became; before, the trace was built from the retrieval half
   * alone and had no way to reach the other.
   */
  const cards = useMemo(
    () => sourceCards ?? buildCitationModel({ traceLanes: deriveTraceLanes(steps), citations }),
    [sourceCards, steps, citations]
  )
  const layout = useMemo(() => planFan(width || FALLBACK_W, cards.length), [width, cards.length])

  /**
   * Which checkpoint layers the reader has folded or unfolded BY HAND, keyed by
   * round index. Absent means "whatever `defaultFoldedRounds` says" — which is
   * currently nothing, so every layer arrives expanded and only a click folds
   * one. A layer the reader folded stays folded when later rounds stream in.
   *
   * Component state, and not the thinking store, because there is no natural
   * place for it there: `ReasoningFlow` is handed steps, not a message id
   * (neither is `ChatThinking` above it), and `useLayoutStore` holds
   * app-wide chrome — `showTechnicalReasoning` and the panels — with no
   * per-message map to hang this on. Inventing one would mean a store key
   * whose lifetime nothing prunes, for a preference whose whole scope is one
   * expanded Herleitung. The panel itself already collapses on the turn's own
   * terms (`ChatThinking`), which is the persistence that matters.
   */
  const [foldOverrides, setFoldOverrides] = useState<ReadonlyMap<number, boolean>>(new Map())
  // Parsed once per step change and handed to `buildGraph`, which needs the
  // rounds themselves; the fold state only needs how many there are.
  const rounds = useMemo(() => withActionRounds(retrievalRounds(steps), steps), [steps])
  const roundCount = rounds.length
  const unplacedSteps = useMemo(() => {
    const placed = placedLookIds(workRounds(steps))
    return placed.size === 0
      ? steps
      : steps.filter((step) => !(step.kind === 'look' && placed.has(step.id)))
  }, [steps])
  // Read at click time, not captured: a node whose data did not change keeps
  // the handler it was built with (`sameNodeData`), across later rounds too.
  const roundCountRef = useRef(roundCount)
  useEffect(() => {
    roundCountRef.current = roundCount
  }, [roundCount])
  const toggleFold = useCallback(
    (index: number) =>
      setFoldOverrides((prev) => {
        const next = new Map(prev)
        next.set(index, !(prev.get(index) ?? defaultFoldedRounds(roundCountRef.current).has(index)))
        return next
      }),
    []
  )
  const folding = useMemo<SpineFolding>(() => {
    const byDefault = defaultFoldedRounds(roundCount)
    const folded = new Set<number>()
    for (let i = 0; i < roundCount; i++) {
      if (foldOverrides.get(i) ?? byDefault.has(i)) folded.add(i)
    }
    return { folded, onToggle: toggleFold }
  }, [foldOverrides, roundCount, toggleFold])

  /**
   * The reader's tap: a row or a card, and the calls it stands for. The other
   * side of the link lights up and the rest recede; a second tap clears it.
   * Component state for the reason the fold state is: its scope is one
   * expanded Herleitung.
   */
  const [selection, setSelection] = useState<LinkSelection | null>(null)
  /** Fans whose uncited cards the reader opened, by fan key. */
  const [openFolds, setOpenFolds] = useState<ReadonlySet<string>>(new Set())
  const toggleOpenFold = useCallback(
    (key: string) =>
      setOpenFolds((prev) => {
        const next = new Set(prev)
        if (!next.delete(key)) next.add(key)
        return next
      }),
    []
  )
  const interaction = useMemo<GraphInteraction>(
    () => ({ selection, onSelect: setSelection, openFolds, onToggleFold: toggleOpenFold }),
    [selection, openFolds, toggleOpenFold]
  )

  // Memoised on the fields that actually shape the graph — NOT on the props
  // object, whose identity changes on every parent render and would rebuild
  // (and re-measure) the whole graph each time.
  const built = useMemo(
    () =>
      buildGraph(
        {
          steps,
          userQuestion,
          answerConfidence,
          citations,
          escalationReason,
          // The backend's account of the rounds, when this message carries one:
          // it decides what hangs under each checkpoint.
          ...(retrievalLedger ? { retrievalLedger } : {}),
          // Drives the pending converge node: while the turn streams the graph
          // still needs its merge point, or the source columns end in mid-air.
          live,
        },
        t,
        layout,
        cards,
        folding,
        rounds,
        interaction
      ),
    [
      steps,
      userQuestion,
      answerConfidence,
      citations,
      escalationReason,
      retrievalLedger,
      live,
      t,
      layout,
      cards,
      folding,
      rounds,
      interaction,
    ]
  )

  return (
    <div ref={containerRef} className="flex w-full flex-col gap-3">
      <ReactFlowProvider>
        <FlowInner built={built} layout={layout} live={live ?? false} />
      </ReactFlowProvider>

      {/* Looks the graph's round nodes do not draw (ADR-0128): all of them in a turn
          from before the action step, none in one that has it. */}
      <LookStepRows steps={unplacedSteps} />

      {showTechnicalReasoning && steps.length > 0 && (
        <div className="border-base border-t pt-2">
          <TechnicalSteps steps={steps} t={t} />
        </div>
      )}
    </div>
  )
}
