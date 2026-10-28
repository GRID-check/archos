/**
 * @vitest-environment node
 */
/**
 * The fold over AG-UI 1.0's subagent events (`SUBAGENT_*`, `subagent_run_id`
 * on steps): a subagent is one stored row, its steps name it, and the stored
 * shape survives the provenance sanitizer a reload reads through.
 */
import { describe, expect, it } from 'vitest'
import type { WireEvent } from '@/adapters/api/wire-v2'
import { MAX_THINKING_STEPS, boundSteps, sanitizeThinkingSteps } from '@/lib/conversations/message-provenance'
import { eventOf, frameOf, wireEvents } from '@/test-utils/wire-v2-fixtures'
import { foldTurnEvents, subagentStepId, type TurnView } from './turn-fold'

const fold = (events: readonly WireEvent[]): TurnView => {
  const view = foldTurnEvents(undefined, events)
  if (!view) throw new Error('no events')
  return view
}

const body = (seq: number, raw: Record<string, unknown>): WireEvent => eventOf(frameOf(seq, raw))
const started = (seq: number, run: string, extra: Record<string, unknown> = {}) =>
  body(seq, { type: 'SUBAGENT_STARTED', subagent_run_id: run, name: 'researcher-agent', ...extra })

describe('subagents in the fold', () => {
  const view = fold(wireEvents('turn-subagents.jsonl'))
  const DEEP = 'sa_0d1e2a3b4c5d6e7f8091'
  const PLANNER = 'sa_1a2b3c4d5e6f70819203'

  it('keeps each invocation as one row, its parent in subagentRunId', () => {
    const deep = view.steps[subagentStepId(DEEP)]
    const planner = view.steps[subagentStepId(PLANNER)]
    expect(deep).toMatchObject({ kind: 'status', isComplete: true, detail: { name: 'deep_researcher', status: 'ok' } })
    expect(deep.subagentRunId).toBeUndefined()
    expect(planner).toMatchObject({ subagentRunId: DEEP, detail: { name: 'planner-agent', status: 'ok' } })
  })

  it('attributes each step to the invocation that took it, the spawning task call to the parent', () => {
    expect(view.steps['tool:5a2d'].subagentRunId).toBe(PLANNER)
    expect(view.steps['tool:4f1c'].subagentRunId).toBe(DEEP)
    expect(view.steps['status:escalation'].subagentRunId).toBeUndefined()
  })

  it('says which researcher failed, with the query it ran', () => {
    const failed = Object.values(view.steps).filter((step) => step.detail?.status === 'error')
    expect(failed).toHaveLength(1)
    expect(failed[0].detail).toMatchObject({
      name: 'researcher-agent',
      description: 'Brandabschnittsgröße OIB-RL 2 Tabelle 1b',
      code: 'ResearcherExhaustedError',
    })
  })

  it('stores what it folds: a reload reads the same rows back', () => {
    const steps = view.stepOrder.map((id) => view.steps[id])
    expect(sanitizeThinkingSteps(JSON.parse(JSON.stringify(steps)))).toEqual(steps)
  })

  it('never lets a late FINISHED undo an error', () => {
    const events = [
      body(1, { type: 'RUN_STARTED', message_id: 'a' }),
      started(2, 'sa_x'),
      body(3, { type: 'SUBAGENT_ERROR', subagent_run_id: 'sa_x', message: 'failed', code: 'ValueError' }),
      body(4, { type: 'SUBAGENT_FINISHED', subagent_run_id: 'sa_x' }),
    ]
    expect(fold(events).steps[subagentStepId('sa_x')].detail?.status).toBe('error')
  })

  it('leaves an invocation the turn outlived running in detail, closed as a row', () => {
    const events = [
      body(1, { type: 'RUN_STARTED', message_id: 'a' }),
      started(2, 'sa_y'),
      body(3, { type: 'RUN_FINISHED', outcome: 'cancelled', result: { message_id: 'a', text: '' } }),
    ]
    const row = fold(events).steps[subagentStepId('sa_y')]
    expect(row).toMatchObject({ isComplete: true, detail: { status: 'running' } })
  })

  it('a step without subagent_run_id belongs to the turn’s own agent', () => {
    const events = [
      body(1, { type: 'RUN_STARTED', message_id: 'a' }),
      body(2, { type: 'STEP_FINISHED', step: { id: 'status:a', kind: 'status', slot: 'a', channel: 'technical' } }),
    ]
    expect(fold(events).steps['status:a'].subagentRunId).toBeUndefined()
  })

  it('keeps the subagent rows when a long run is cut to the stored bound', () => {
    const rows = view.stepOrder.map((id) => view.steps[id])
    const filler = Array.from({ length: MAX_THINKING_STEPS }, (_, n) => ({
      ...view.steps['status:escalation'],
      id: `status:filler:${n}`,
    }))
    const kept = boundSteps([...rows, ...filler])
    const subagentRows = (steps: typeof rows) => steps.filter((step) => step.id.startsWith('subagent:'))
    expect(subagentRows(kept)).toEqual(subagentRows(rows))
  })
})
