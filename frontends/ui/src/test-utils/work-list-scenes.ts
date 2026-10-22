/**
 * The north-star scene of ADR-0131 as wire steps, for specs and the
 * `/dev/derivation?variant=work` preview: round 1 runs a literal search, a
 * folder listing and a meaning search together; round 2 reads a plan sheet
 * and looks at it. Pure data (no `node:fs`), so a page can import it.
 */

import { parseWireEvent } from '@/adapters/api/wire-v2'
import { foldTurnEvents } from '@/features/chat/lib/turn-fold'
import type { StoredThinkingStep } from '@/lib/conversations/message-provenance'

export type WireStepInput = Record<string, unknown>

const DOCUMENT_ID = '00000000-0000-4000-8000-0000000000c1'

/** One call: `at` ms after the scene's origin, running `ms`. */
export interface TimedStep {
  at: number
  /** The wire event type this step is sent as. */
  type: 'STEP_STARTED' | 'STEP_FINISHED'
  step: WireStepInput
}

const call = (id: string, at: number, ms: number, step: WireStepInput): TimedStep[] => [
  {
    at,
    type: 'STEP_STARTED',
    step: { id, call_id: id, kind: 'action', status: 'running', ...step },
  },
  {
    at: at + ms,
    type: 'STEP_FINISHED',
    step: { id, call_id: id, kind: 'action', elapsed_ms: ms, ...step },
  },
]

const round1 = (): TimedStep[] => [
  ...call('action:1', 0, 1800, {
    round: 1,
    verb: 'search',
    mode: 'exact',
    shelf: 'project',
    query: 'Brandabschnitt',
    status: 'ok',
    counts: { hits: 14, documents: 3, searched: 212 },
  }),
  ...call('action:2', 100, 600, {
    round: 1,
    verb: 'list',
    target: '03 Einreichung/Pläne',
    status: 'ok',
    counts: { files: 12, folders: 2 },
  }),
  ...call('action:3', 150, 2250, {
    round: 1,
    verb: 'search',
    mode: 'meaning',
    shelf: 'base',
    query: 'Brandabschnitte Fläche',
    status: 'ok',
    counts: { hits: 6, documents: 2 },
  }),
]

const round2 = (at: number, running = false): TimedStep[] => [
  ...(running
    ? [
        {
          at,
          type: 'STEP_STARTED' as const,
          step: {
            id: 'action:4',
            call_id: 'action:4',
            kind: 'action',
            status: 'running',
            round: 2,
            verb: 'read',
            target: 'Einreichplan EG.pdf',
            document_id: DOCUMENT_ID,
            pages: '2-3',
          },
        },
        {
          at: at + 120,
          type: 'STEP_STARTED' as const,
          step: {
            id: 'action:5',
            call_id: 'action:5',
            kind: 'action',
            status: 'running',
            round: 2,
            verb: 'look',
            target: 'Einreichplan EG.pdf',
            document_id: DOCUMENT_ID,
            pages: '2',
          },
        },
      ]
    : [
        ...call('action:4', at, 900, {
          round: 2,
          verb: 'read',
          target: 'Einreichplan EG.pdf',
          document_id: DOCUMENT_ID,
          pages: '2-3',
          status: 'ok',
        }),
        ...call('action:5', at + 120, 1500, {
          round: 2,
          verb: 'look',
          target: 'Einreichplan EG.pdf',
          document_id: DOCUMENT_ID,
          pages: '2',
          status: 'ok',
        }),
      ]),
]

/** The look step the model's `look` call stores beside its action row. */
export const NORTH_STAR_LOOK: WireStepInput = {
  id: 'look:1',
  kind: 'look',
  round: 2,
  document_name: 'Einreichplan EG.pdf',
  document_id: DOCUMENT_ID,
  page: 2,
  region: [0.62, 0.04, 0.34, 0.22],
  where: 'oben rechts',
}

/** Both rounds, settled: three calls together, then two. */
export const northStarScene = (): TimedStep[] =>
  [
    ...round1(),
    ...round2(2600),
    { at: 4220, type: 'STEP_FINISHED' as const, step: NORTH_STAR_LOOK },
  ].sort((a, b) => a.at - b.at)

/** Round 1 settled, round 2 started and not ended: the live state. */
export const northStarLiveScene = (): TimedStep[] =>
  [...round1(), ...round2(2600, true)].sort((a, b) => a.at - b.at)

/** 2026-10-22 10:00:00 UTC, the scene's origin. */
export const SCENE_ORIGIN = Date.UTC(2026, 9, 22, 10, 0, 0)

/** A scene folded the way the app folds the wire: the stored rows a reader gets. */
export const foldScene = (
  scene: readonly TimedStep[],
  origin: number = SCENE_ORIGIN
): StoredThinkingStep[] => {
  const events = scene.map(({ at, type, step }, index) => {
    const event = parseWireEvent({
      v: 2,
      conversation_id: 'conv_scene',
      turn_id: 'turn-scene',
      seq: index + 1,
      ts: origin + at,
      type,
      step,
    })
    if (!event) throw new Error(`not a v2 event: ${JSON.stringify(step)}`)
    return event
  })
  const view = foldTurnEvents(undefined, events)
  return view ? view.stepOrder.map((id) => view.steps[id]) : []
}
