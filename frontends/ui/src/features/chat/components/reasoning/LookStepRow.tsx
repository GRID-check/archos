'use client'

/**
 * The Herleitung's look rows (ADR-0128) for looks no call row explains: a
 * turn stored before the work list (ADR-0131), or a look of the prefetch.
 * Each is drawn as the row a `look` call draws („Betrachtet Grundriss EG.pdf,
 * S. 2, oben rechts“), with the thumbnails of its places under it, so a look
 * reads the same wherever it sits. Consecutive looks at one document fold into
 * one row with a strip of thumbnails.
 */

import { useMemo, type FC } from 'react'
import type { StoredThinkingStep } from '@/lib/conversations/message-provenance'
import { lookStepGroups, type LookStepGroup } from '../../lib/look-steps'
import { lookGroupRow } from '../../lib/work-list'
import { WorkRowView } from './WorkList'

export { LookStrip } from './LookStrip'

export const LookStepRow: FC<{ group: LookStepGroup; eager?: boolean }> = ({ group, eager }) => (
  <WorkRowView row={lookGroupRow(group)} eager={eager} />
)

/** Every look row of a turn, under the graph; nothing when the turn did not look. */
export const LookStepRows: FC<{ steps: readonly StoredThinkingStep[]; eager?: boolean }> = ({
  steps,
  eager,
}) => {
  const groups = useMemo(() => lookStepGroups(steps), [steps])
  if (groups.length === 0) return null
  return (
    <ul data-testid="look-step-rows" className="flex flex-col">
      {groups.map((group) => (
        <LookStepRow key={group.key} group={group} eager={eager} />
      ))}
    </ul>
  )
}
