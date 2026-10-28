import { type FC } from 'react'
import { BaseEdge, getSmoothStepPath, type Edge, type EdgeProps } from '@xyflow/react'
import { EDGE_STROKE } from './flow-node-data'
import { ROW_GAP } from './flow-layout'

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

export const edgeTypes = {
  split: trunkEdge('source'),
  merge: trunkEdge('target'),
}

/** One connector. `type` picks which end its shared elbow is pinned to. */
export function edge(
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
