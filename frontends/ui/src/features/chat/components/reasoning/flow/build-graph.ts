import type { ReasoningFlowProps } from './reasoning-flow-props'
import { type Node, type Edge } from '@xyflow/react'
import type { Translator } from '@/i18n'
import { type RowLinking } from '../WorkList'
import { quoteQuery } from '../../../lib/work-sentence'
import {
  callIdsByDocument,
  isLinked,
  prefetchRounds,
  withActionRounds,
  workKind,
  workRounds,
} from '../../../lib/work-list'
import { basisLines, cardForTarget, cardName, openPoints } from '../../../lib/derivation-basis'
import { isCited, normalizeFileName, type CitedDocument } from '../../../lib/citations'
import { documentShortName } from '../../../lib/document-names'
import { FOLDER_TAB_H, type CardLink } from '../SourceCard'
import {
  answerDegradations,
  deepResearchCutoff,
  researchTruncation,
} from '../../../lib/turn-events'
import { stepNameLabel } from '../../../lib/executed-steps'
import {
  retrievalRounds,
  roundFan,
  type FanCard,
  type RetrievalRound,
} from '../../../lib/retrieval-rounds'
import {
  HandleSpec,
  CENTRE_BOTTOM,
  CENTRE_TOP,
  CENTRE_OUT,
  FramingData,
  SourceColumnData,
  ColumnSlot,
  FindingsData,
  RoundData,
} from './flow-node-data'
import { GROUPED_MAX_W, FanLayout, packSlots } from './flow-layout'
import { edge } from './flow-edges'
import { LIMIT, limitations, foldSummary } from './flow-labels'
import { roundKind, SpineFolding, GraphInteraction, NO_INTERACTION } from './round-kind'

export interface BuiltGraph {
  nodes: Node[]
  edges: Edge[]
  /** Row groups, top→bottom, for the measured y-stacking pass. */
  rows: string[][]
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
          ? [
              {
                label: t(`${B}open`),
                lines: open.map((text) => ({ numbers: [], text })),
                open: true,
              },
            ]
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
