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

import { type FC, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import { useTranslations } from '@/i18n'
import { chatCopy } from '@/i18n/namespaces/chat'
import { useLayoutStore } from '@/features/layout/store'
import { TechnicalSteps } from './TechnicalSteps'
import { LookStepRows } from './LookStepRow'
import {
  placedLookIds,
  withActionRounds,
  workRounds,
  type LinkSelection,
} from '../../lib/work-list'
import { deriveTraceLanes } from '../../lib/trace-lanes'
import { buildCitationModel } from '../../lib/citations'
import { retrievalRounds } from '../../lib/retrieval-rounds'
import { FALLBACK_W, planFan } from './flow/flow-layout'
import { defaultFoldedRounds, SpineFolding, GraphInteraction } from './flow/round-kind'
import { buildGraph } from './flow/build-graph'
import { FlowInner } from './flow/flow-inner'
import { ReasoningFlowProps } from './flow/reasoning-flow-props'

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
