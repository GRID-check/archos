'use client'

/**
 * Subagent groups dev preview: the nested groups the Herleitung draws for a
 * turn that ran subagents (AG-UI 1.0 `SUBAGENT_*`), folded from wire frames by
 * the app's own fold, in the 680 px box the thread uses. Not linked anywhere;
 * the `/dev` layout 404s it outside development.
 *
 * `?variant=`:
 *   - (none) → an in-chat deep research, finished: planning, two researchers
 *     (one failed) and the report, nested under it.
 *   - live   → the same run mid-research: a researcher still working.
 *   - phone  → the finished run at 380 px and 320 px.
 */

import { useEffect, useState } from 'react'
import { parseWireEvent, type WireEvent } from '@/adapters/api/wire-v2'
import { SubagentGroups } from '@/features/chat/components/reasoning/SubagentGroups'
import { foldTurnEvents } from '@/features/chat/lib/turn-fold'
import type { StoredThinkingStep } from '@/lib/conversations/message-provenance'

const DEEP = 'sa_deep'
const PLANNER = 'sa_plan'
const RESEARCH_A = 'sa_res_a'
const RESEARCH_B = 'sa_res_b'
const WRITER = 'sa_write'

const BODIES: Record<string, unknown>[] = [
  { type: 'RUN_STARTED', message_id: 'm' },
  { type: 'SUBAGENT_STARTED', subagent_run_id: DEEP, name: 'deep_researcher' },
  { type: 'SUBAGENT_STARTED', subagent_run_id: PLANNER, name: 'planner-agent', parent_subagent_run_id: DEEP },
  {
    type: 'STEP_FINISHED',
    step: { id: 'tool:p1', kind: 'tool', tool: 'knowledge_search', status: 'ok', scope: 'deep' },
    subagent_run_id: PLANNER,
  },
  { type: 'SUBAGENT_FINISHED', subagent_run_id: PLANNER },
  {
    type: 'SUBAGENT_STARTED',
    subagent_run_id: RESEARCH_A,
    name: 'researcher-agent',
    description: 'Fluchtweglänge OIB-RL 4 Pkt. 2.8',
    parent_subagent_run_id: DEEP,
  },
  {
    type: 'SUBAGENT_STARTED',
    subagent_run_id: RESEARCH_B,
    name: 'researcher-agent',
    description: 'Brandabschnittsgröße OIB-RL 2 Tabelle 1b',
    parent_subagent_run_id: DEEP,
  },
  {
    type: 'STEP_FINISHED',
    step: { id: 'tool:a1', kind: 'tool', tool: 'knowledge_search', status: 'ok', scope: 'deep' },
    subagent_run_id: RESEARCH_A,
  },
  {
    type: 'STEP_FINISHED',
    step: { id: 'tool:a2', kind: 'tool', tool: 'read_passage', status: 'ok', scope: 'deep' },
    subagent_run_id: RESEARCH_A,
  },
  { type: 'SUBAGENT_FINISHED', subagent_run_id: RESEARCH_A },
  // `live` stops here: the second researcher is still working.
  { type: 'SUBAGENT_ERROR', subagent_run_id: RESEARCH_B, message: 'failed', code: 'ResearcherExhaustedError' },
  { type: 'SUBAGENT_STARTED', subagent_run_id: WRITER, name: 'writer-agent', parent_subagent_run_id: DEEP },
  { type: 'SUBAGENT_FINISHED', subagent_run_id: WRITER },
  { type: 'SUBAGENT_FINISHED', subagent_run_id: DEEP },
  { type: 'RUN_FINISHED', outcome: 'answered', result: { message_id: 'm', text: 'Höchstens 40 m.' } },
]

const LIVE_UNTIL = 10

const stepsOf = (bodies: Record<string, unknown>[]): StoredThinkingStep[] => {
  const events = bodies
    .map((body, index) =>
      parseWireEvent({ v: 2, conversation_id: 'c', turn_id: 't', seq: index + 1, ts: 1759000800000 + index * 400, ...body })
    )
    .filter((event): event is WireEvent => event !== null)
  const view = foldTurnEvents(undefined, events)
  return view ? view.stepOrder.map((id) => view.steps[id]) : []
}

export default function SubagentsPreviewPage() {
  const [variant, setVariant] = useState<string | null>(null)
  useEffect(() => setVariant(new URLSearchParams(window.location.search).get('variant')), [])
  const steps = stepsOf(variant === 'live' ? BODIES.slice(0, LIVE_UNTIL) : BODIES)
  const widths = variant === 'phone' ? ['w-[380px]', 'w-[320px]'] : ['w-[680px] max-w-full']
  return (
    <main className="bg-background flex min-h-screen flex-col items-start gap-8 p-6">
      {widths.map((width) => (
        <div key={width} className={`${width} bg-card rounded-xl border p-4`} data-testid="subagents-preview">
          <SubagentGroups steps={steps} />
        </div>
      ))}
    </main>
  )
}
