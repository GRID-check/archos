/**
 * The north-star scene of ADR-0132 as wire steps, for specs and the
 * `/dev/derivation?variant=work` preview: round 1 runs a literal search, a
 * folder listing and a meaning search together; round 2 reads a plan sheet
 * and looks at it. Pure data (no `node:fs`), so a page can import it.
 */

import { parseWireEvent } from '@/adapters/api/wire-v2'
import { foldTurnEvents } from '@/features/chat/lib/turn-fold'
import type { StoredThinkingStep } from '@/lib/conversations/message-provenance'
import type { CitationSource } from '@/features/chat/types'

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

// ── The approved mockup's scene (Herleitung, 2026-10 evolution) ─────────────
//
// „Welche Brandabschnitte sind im Einreichplan EG eingetragen, und passt das
// zur OIB-RL 2?“ — the decision's prefetch finds the OIB-RL 2 (no row of its
// own), step 1 searches the project literally, opens a folder and finds
// nothing on the Tiefgarage in the OIB-RL 2, step 2 reads the plan sheet and
// looks at it. The answer cites three documents.

const OIB_2 = 'oib-rl_2_ausgabe_mai_2023.pdf'
const OIB_2_NOTES = 'erlaeuterungen_oib-rl_2_ausgabe_mai_2023.pdf'
const PLAN = 'Einreichplan EG.pdf'
const CONCEPT = 'Brandschutzkonzept.pdf'
const DESCRIPTION = 'Baubeschreibung.pdf'
const PLAN_ID = '00000000-0000-4000-8000-0000000000c2'

type LaneKind = 'building_law' | 'project' | 'office' | 'web'
interface Hit {
  name: string
  detail?: string
  kind: LaneKind
}

const LANE: Record<LaneKind, { key: string; label: string }> = {
  building_law: { key: 'building_law_oib', label: 'OIB-Richtlinie' },
  project: { key: 'project', label: 'Projektwissen' },
  office: { key: 'office', label: 'Büroablage' },
  web: { key: 'web', label: 'Web' },
}

/** The `sources` step a call returned, under its call id. */
const sourcesOf = (at: number, callId: string, round: number, hits: readonly Hit[]): TimedStep => ({
  at,
  type: 'STEP_FINISHED',
  step: {
    id: `sources:${callId}`,
    kind: 'sources',
    tool: 'knowledge_search',
    round,
    call_id: callId,
    lanes: (Object.keys(LANE) as LaneKind[]).flatMap((kind) => {
      const mine = hits.filter((hit) => hit.kind === kind)
      if (mine.length === 0) return []
      return [
        {
          ...LANE[kind],
          kind,
          hit_count: mine.length,
          sources: mine.map((hit) => ({
            name: hit.name,
            ...(hit.detail ? { detail: hit.detail } : {}),
            shelf: kind === 'building_law' ? 'base' : 'project',
            round,
          })),
        },
      ]
    }),
  },
})

/** The `retrieval` step that opens a round: the model's sentence, or the decision's prefetch. */
const retrievalOf = (at: number, round: number, reason?: string, prefetch = false): TimedStep => ({
  at,
  type: 'STEP_FINISHED',
  step: {
    id: `status:retrieval:${round}`,
    kind: 'retrieval',
    round,
    key: 'status.retrieval.withQuery',
    values: { corpus: 'knowledge', query: 'Brandabschnitt' },
    tools: ['knowledge_search'],
    ...(reason ? { reason } : {}),
    ...(prefetch ? { prefetch: true } : {}),
  },
})

const prefetchRound = (): TimedStep[] => [
  retrievalOf(0, 0, undefined, true),
  ...call('call:p0', 10, 400, {
    round: 0,
    verb: 'search',
    mode: 'meaning',
    shelf: 'base',
    query: 'Brandabschnitte Einreichplan OIB-RL 2',
    status: 'ok',
    counts: { hits: 3, documents: 1 },
  }),
  sourcesOf(410, 'call:p0', 0, [{ name: OIB_2, detail: 'Pkt. 3.1.1', kind: 'building_law' }]),
]

const stepOne = (): TimedStep[] => [
  retrievalOf(
    500,
    1,
    'Zuerst die Brandabschnitte in den Projektunterlagen finden, dann die Grenzwerte der OIB-RL 2.'
  ),
  ...call('call:c1', 600, 1800, {
    round: 1,
    verb: 'search',
    mode: 'exact',
    shelf: 'project',
    query: 'Brandabschnitt',
    status: 'ok',
    counts: { hits: 14, documents: 3, searched: 41 },
  }),
  sourcesOf(2400, 'call:c1', 1, [
    { name: CONCEPT, detail: 'S. 7', kind: 'project' },
    { name: DESCRIPTION, detail: 'S. 3', kind: 'project' },
    { name: OIB_2_NOTES, detail: 'S. 12', kind: 'building_law' },
  ]),
  ...call('call:c2', 650, 500, {
    round: 1,
    verb: 'list',
    target: '03 Einreichung/Unterlagen',
    status: 'ok',
    counts: { files: 12, folders: 2 },
  }),
  ...call('call:c3', 700, 2600, {
    round: 1,
    verb: 'search',
    mode: 'meaning',
    shelf: 'base',
    target: 'OIB-RL 2, Ausgabe 2023',
    query: 'Brandabschnitt Tiefgarage',
    status: 'empty',
    counts: { hits: 0 },
  }),
]

const LOOK: WireStepInput = {
  id: 'look:plan',
  kind: 'look',
  round: 2,
  document_name: PLAN,
  document_id: PLAN_ID,
  page: 2,
  region: [0.55, 0.05, 0.4, 0.3],
  where: 'oben rechts',
  reading: 'BA 2: 1.420 m²',
}

const stepTwo = (lookRunning = false): TimedStep[] => [
  retrievalOf(3400, 2),
  ...call('call:c4', 3500, 900, {
    round: 2,
    verb: 'read',
    target: PLAN,
    document_id: PLAN_ID,
    pages: '2-3',
    status: 'ok',
    counts: { hits: 2 },
  }),
  sourcesOf(4400, 'call:c4', 2, [{ name: PLAN, detail: 'S. 2', kind: 'project' }]),
  ...(lookRunning
    ? [
        {
          at: 3600,
          type: 'STEP_STARTED' as const,
          step: {
            id: 'call:c5',
            call_id: 'call:c5',
            kind: 'action',
            status: 'running',
            round: 2,
            verb: 'look',
            target: PLAN,
            document_id: PLAN_ID,
            pages: '2',
          },
        },
      ]
    : [
        ...call('call:c5', 3600, 1500, {
          round: 2,
          verb: 'look',
          target: PLAN,
          document_id: PLAN_ID,
          pages: '2',
          status: 'ok',
        }),
        { at: 5100, type: 'STEP_FINISHED' as const, step: LOOK },
      ]),
]

/** The mockup's turn, settled: a prefetch, two steps, three documents cited. */
export const mockupScene = (): TimedStep[] =>
  [...prefetchRound(), ...stepOne(), ...stepTwo()].sort((a, b) => a.at - b.at)

/** The mockup's turn mid-step 2: the read is done, the look still runs. */
export const mockupLiveScene = (): TimedStep[] =>
  [...prefetchRound(), ...stepOne(), ...stepTwo(true)].sort((a, b) => a.at - b.at)

const citation = (
  id: string,
  number: number,
  fileName: string,
  kind: 'building_law' | 'project',
  locus: { page?: number; clause?: string }
): CitationSource => ({
  id,
  content: `[KB] ${fileName}`,
  citationKey: `${fileName}${locus.page ? `, p.${locus.page}` : ''}`,
  fileName,
  collection: kind === 'building_law' ? 'oib_knowledge' : 'project',
  origin: 'kb',
  timestamp: new Date('2026-10-22T10:00:05Z'),
  kind,
  ...(kind === 'building_law'
    ? { lane: 'building_law_oib', laneLabel: 'OIB-Richtlinie' }
    : { lane: 'project' }),
  ...(locus.page ? { page: locus.page } : {}),
  ...(locus.clause ? { clause: locus.clause } : {}),
  number,
  isCited: true,
})

/** What the mockup's answer cites: [1] the OIB-RL 2, [2] the plan sheet, [3] the fire safety concept. */
export const mockupCitations = (): CitationSource[] => [
  citation('c1', 1, OIB_2, 'building_law', { clause: '3.1.1' }),
  citation('c2', 2, PLAN, 'project', { page: 2 }),
  citation('c3', 3, CONCEPT, 'project', { page: 7 }),
]

export const MOCKUP_QUESTION =
  'Welche Brandabschnitte sind im Einreichplan EG eingetragen, und passt das zur OIB-RL 2?'

/** One step, a failed RIS call beside a search that found what the answer cites. */
export const failedCallScene = (): TimedStep[] =>
  [
    retrievalOf(0, 1, 'Die Garagenvorschrift im RIS und die Stellplätze im Projekt nachsehen.'),
    ...call('call:f1', 100, 3000, {
      round: 1,
      verb: 'law',
      query: 'Wiener Garagengesetz 2008',
      status: 'error',
    }),
    ...call('call:f2', 120, 900, {
      round: 1,
      verb: 'search',
      mode: 'meaning',
      shelf: 'project',
      query: 'Stellplätze Tiefgarage',
      status: 'ok',
      counts: { hits: 4, documents: 2 },
    }),
    sourcesOf(1100, 'call:f2', 1, [
      { name: CONCEPT, detail: 'S. 9', kind: 'project' },
      { name: DESCRIPTION, detail: 'S. 4', kind: 'project' },
    ]),
  ].sort((a, b) => a.at - b.at)

export const failedCallCitations = (): CitationSource[] => [
  citation('f1', 1, CONCEPT, 'project', { page: 9 }),
  citation('f2', 2, DESCRIPTION, 'project', { page: 4 }),
]

/** One call: the fire safety concept read at page 7, and cited. */
export const singleReadScene = (): TimedStep[] => [
  retrievalOf(0, 1),
  ...call('call:s1', 100, 700, {
    round: 1,
    verb: 'read',
    target: CONCEPT,
    pages: '7',
    status: 'ok',
    counts: { hits: 1 },
  }),
  sourcesOf(800, 'call:s1', 1, [{ name: CONCEPT, detail: 'S. 7', kind: 'project' }]),
]

export const singleReadCitations = (): CitationSource[] => [
  citation('s1', 1, CONCEPT, 'project', { page: 7 }),
]

/** One step of many calls: seven reads fold into one row, the empty one leads, the rest fold into „+N weitere“. */
export const manyCallsScene = (): TimedStep[] => {
  const reads = Array.from({ length: 7 }, (_, i) =>
    call(`call:r${i}`, 200 + i * 10, 600, {
      round: 1,
      verb: 'read',
      target: `Plan ${i + 1}.pdf`,
      pages: String(i + 1),
      status: 'ok',
      counts: { hits: i % 3 === 0 ? 3 : 2 },
    })
  ).flat()
  return [
    retrievalOf(0, 1),
    ...reads,
    ...call('call:m1', 100, 1200, {
      round: 1,
      verb: 'search',
      mode: 'meaning',
      shelf: 'base',
      target: 'OIB-RL 4, Ausgabe 2023',
      query: 'Fluchtweglänge Garage',
      status: 'empty',
      counts: { hits: 0 },
    }),
    ...call('call:m2', 110, 900, {
      round: 1,
      verb: 'search',
      mode: 'exact',
      shelf: 'project',
      query: 'EI 90',
      status: 'ok',
      counts: { hits: 5, documents: 2 },
    }),
    ...call('call:m3', 120, 400, {
      round: 1,
      verb: 'list',
      target: '04 Ausführung/Brandschutz',
      status: 'ok',
      counts: { files: 9, folders: 1 },
    }),
    ...call('call:m4', 130, 2200, {
      round: 1,
      verb: 'web',
      query: 'ÖNORM B 3806 Brandabschnitt',
      status: 'ok',
      counts: { hits: 6 },
    }),
    ...call('call:m5', 140, 1500, {
      round: 1,
      verb: 'lookup',
      query: 'Tiefgarage Brandabschnitt Referenzprojekt',
      status: 'ok',
      counts: { hits: 2, documents: 1 },
    }),
    ...call('call:m6', 150, 1700, {
      round: 1,
      verb: 'model',
      query: 'Fläche je Brandabschnitt',
      status: 'ok',
    }),
  ].sort((a, b) => a.at - b.at)
}

// ── The filesystem verbs (ADR-0133): ls, glob, grep and read_file ───────────
//
// The rows exactly as the estate backend emits them (`estate.py`,
// `estate_grep.py`, pinned by `test_estate_action_rows.py`): a place (`mount`)
// and the folder inside it, never a path. Step 1 orients (a folder, a name
// pattern, a literal search), step 2 reads what step 1 found.

const SPEC = 'Baubeschreibung.pdf'

/** The happy turn: list, glob and grep side by side, then a read, a folder card and a citable grep. */
export const filesystemScene = (): TimedStep[] =>
  [
    retrievalOf(0, 1, 'Erst schauen, was in der Einreichung liegt und wo „Brandabschnitt“ steht.'),
    ...call('call:fs1', 100, 400, {
      round: 1,
      verb: 'list',
      mount: 'project',
      target: '03 Einreichung',
      status: 'ok',
      counts: { files: 12, folders: 2 },
    }),
    ...call('call:fs2', 110, 1600, {
      round: 1,
      verb: 'search',
      mode: 'exact',
      query: 'Brandabschnitt',
      mount: 'project',
      target: '03 Einreichung',
      status: 'ok',
      counts: { hits: 14, documents: 3, searched: 12 },
    }),
    ...call('call:fs3', 120, 300, {
      round: 1,
      verb: 'list',
      query: '**/*Brandschutz*',
      mount: 'project',
      status: 'ok',
      counts: { files: 2 },
    }),
    retrievalOf(
      2000,
      2,
      'Die Baubeschreibung nennt die Brandabschnitte auf S. 4–6; dort nachlesen.'
    ),
    ...call('call:fs4', 2100, 700, {
      round: 2,
      verb: 'read',
      target: SPEC,
      pages: '4-6',
      shelf: 'project',
      status: 'ok',
      counts: { hits: 3, documents: 1 },
    }),
    sourcesOf(2800, 'call:fs4', 2, [{ name: SPEC, detail: 'S. 4', kind: 'project' }]),
    // The folder card (`README.md`): a listing of the folder, with the card's counts.
    ...call('call:fs5', 2110, 300, {
      round: 2,
      verb: 'list',
      mount: 'project',
      target: '03 Einreichung/Pläne',
      status: 'ok',
      counts: { files: 9, folders: 0 },
    }),
    ...call('call:fs6', 2120, 1400, {
      round: 2,
      verb: 'search',
      mode: 'exact',
      query: 'Fluchtweg',
      mount: 'estate',
      status: 'ok',
      counts: { hits: 3, documents: 1, searched: 41 },
    }),
    sourcesOf(3500, 'call:fs6', 2, [{ name: CONCEPT, detail: 'S. 3', kind: 'project' }]),
  ].sort((a, b) => a.at - b.at)

export const filesystemCitations = (): CitationSource[] => [
  citation('fs1', 1, SPEC, 'project', { page: 4 }),
  citation('fs2', 2, CONCEPT, 'project', { page: 3 }),
]

/** Every outcome of the four verbs that is not a plain hit, one row each, over three steps. */
export const filesystemEdgesScene = (): TimedStep[] =>
  [
    retrievalOf(
      0,
      1,
      'Wörtlich nach der Sprinkleranlage suchen, im Projekt und in der Büroablage.'
    ),
    ...call('call:fe1', 100, 1200, {
      round: 1,
      verb: 'search',
      mode: 'exact',
      query: 'Sprinkler',
      mount: 'estate',
      status: 'empty',
      counts: { hits: 0, documents: 0, searched: 41 },
    }),
    // The office's scan failed: 9 of 41 searched, three hits, and the row says it is a floor.
    ...call('call:fe2', 110, 3000, {
      round: 1,
      verb: 'search',
      mode: 'exact',
      query: 'Brandabschnitt',
      mount: 'estate',
      incomplete: true,
      status: 'ok',
      counts: { hits: 3, documents: 1, searched: 9 },
    }),
    // The same failure without a hit: no hit in what was searched, and no no.
    ...call('call:fe3', 120, 3000, {
      round: 1,
      verb: 'search',
      mode: 'regex',
      query: 'EI\\s?90',
      mount: 'office',
      target: 'Vorlagen',
      incomplete: true,
      status: 'empty',
      counts: { hits: 0, documents: 0, searched: 9 },
    }),
    retrievalOf(3200, 2, 'Den Personalordner und die Pläne ansehen.'),
    // A folder that does not exist, and a restricted one: one answer for both.
    ...call('call:fe4', 3300, 200, {
      round: 2,
      verb: 'list',
      mount: 'project',
      target: 'Personal',
      status: 'empty',
    }),
    // A guessed path: the name the model asked for, „nicht gefunden“, as for any miss.
    ...call('call:fe5', 3310, 200, {
      round: 2,
      verb: 'read',
      target: 'Vertrag.pdf',
      status: 'empty',
    }),
    ...call('call:fe6', 3320, 200, {
      round: 2,
      verb: 'list',
      query: '*.dwg',
      mount: 'project',
      status: 'empty',
      counts: { files: 0 },
    }),
    retrievalOf(3600, 3, 'Was es an Ablagen gibt.'),
    ...call('call:fe7', 3700, 200, {
      round: 3,
      verb: 'list',
      mount: 'estate',
      status: 'ok',
      counts: { files: 62, folders: 3 },
    }),
    ...call('call:fe8', 3710, 300, {
      round: 3,
      verb: 'list',
      mount: 'law',
      status: 'ok',
      counts: { files: 9, folders: 0 },
    }),
  ].sort((a, b) => a.at - b.at)
