import { type FC, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow,
  applyNodeChanges,
  useNodesInitialized,
  useUpdateNodeInternals,
  type Node,
  type NodeChange,
  type Edge,
} from '@xyflow/react'
import { useTranslations } from '@/i18n'
import { chatCopy } from '@/i18n/namespaces/chat'
import { HandleSpec } from './flow-node-data'
import { nodeTypes } from './flow-nodes'
import { ROW_GAP, PAD, FanLayout } from './flow-layout'
import { edgeTypes } from './flow-edges'
import { BuiltGraph, sameNodeData, animateFrontier, keepEdgeIdentity } from './build-graph'

const DEFAULT_VIEWPORT = { x: 0, y: 0, zoom: 1 }

const PRO_OPTIONS = { hideAttribution: true }

export const FlowInner: FC<{ built: BuiltGraph; layout: FanLayout; live: boolean }> = ({
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
