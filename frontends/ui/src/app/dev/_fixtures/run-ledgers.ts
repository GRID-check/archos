/**
 * Run ledgers for the `/dev/run-block` preview — one per state, built with the
 * ledger's own fold helpers so a fixture is a ledger production could have
 * written, not a hand-typed object that drifts from the schema.
 *
 * Live states are anchored to module load (`startedAt = now − 102 s`), so the
 * elapsed pill reads „1:42" rather than the years since a fixed instant.
 * Terminal states are fixed to the morning of the review so their durations
 * are the same on every capture.
 */

import {
  appendStep,
  closePhase,
  emptyRunLedger,
  failRun,
  finishRun,
  openPhase,
  setRunStatus,
} from '@/lib/runs/run-ledger'
import type { RunLedger, RunLedgerDoc, RunStep } from '@/lib/runs/run-ledger-types'

const doc = (
  name: string,
  shelf: RunLedgerDoc['shelf'],
  loci: string[],
  repeat = false,
): RunLedgerDoc => ({ name, shelf, loci, ...(repeat ? { repeat } : {}) })

const OIB_2 = (loci: string[], repeat = false) => doc('OIB-Richtlinie 2, Ausgabe Mai 2023', 'base', loci, repeat)
const VIENNA_BUILDING_CODE = doc('Bauordnung für Wien § 108', 'base', ['§ 108 Abs. 2'])
const FIRE_SAFETY_CONCEPT = (loci: string[], repeat = false) => doc('Brandschutzkonzept Haus A', 'project', loci, repeat)
const FLOOR_PLAN = doc('Grundriss EG', 'project', ['Achse C–E'])
const OIB_2_3 = doc('OIB-Richtlinie 2.3, Ausgabe Mai 2023', 'base', ['Pkt. 3.1'])
const EXPLANATORY_OIB_2 = doc('Erläuterungen zu OIB-Richtlinie 2', 'base', ['S. 4'])
const WBTV = doc('Wiener Bautechnikverordnung 2020', 'base', ['§ 2'])
const CHECKLIST = doc('Checkliste Brandschutz Einreichung', 'office_shelf', ['Abschnitt 3'])
const ONORM = doc('ÖNORM B 1300', 'base', ['Pkt. 5.2'])

const PLAN_STEP = (at: Date): RunStep => ({
  id: 'p1',
  phase: 'planning',
  intent: 'Fluchtweglängen, Gebäudeklasse und Wiener Abweichungen für Haus A klären',
  startedAt: at.toISOString(),
  docs: [],
})

/** The three research rounds every fixture with research shares. */
const ROUNDS = (at: (s: number) => Date): RunStep[] => [
  {
    id: 'r1',
    phase: 'researching',
    intent: 'Klären, welche Fluchtweglängen OIB 2 für Gebäudeklasse 4 vorsieht',
    startedAt: at(20).toISOString(),
    docs: [OIB_2(['Pkt. 5.1.1', 'S. 12']), VIENNA_BUILDING_CODE, FIRE_SAFETY_CONCEPT(['S. 7'])],
  },
  {
    id: 'r2',
    phase: 'researching',
    intent: 'Prüfen, ob das Atrium als Ersatz für den Treppenraum gilt',
    startedAt: at(45).toISOString(),
    docs: [OIB_2(['Pkt. 4.2', 'S. 18'], true), FLOOR_PLAN, OIB_2_3, EXPLANATORY_OIB_2],
    openPoints: ['Landesabweichung Wien prüfen'],
  },
  {
    id: 'r3',
    phase: 'researching',
    intent: 'Wiener Abweichungen zur Fluchtweglänge und die Rauchabschnitte nachlesen',
    startedAt: at(80).toISOString(),
    docs: [WBTV, CHECKLIST, ONORM, FIRE_SAFETY_CONCEPT(['S. 9'], true)],
    openPoints: ['Nachweis der Rauchabschnitte im Atrium', 'Abstimmung mit der MA 37 offen'],
  },
]

/** Planen done, research rounds appended, up to `rounds` of them. */
function researched(runId: string, start: Date, rounds: number): RunLedger {
  const at = (s: number): Date => new Date(start.getTime() + s * 1000)
  let ledger = emptyRunLedger(runId, start)
  ledger = openPhase(ledger, 'planning', at(0))
  ledger = appendStep(ledger, PLAN_STEP(at(1)), at(1))
  ledger = closePhase(ledger, 'planning', at(12))
  ledger = openPhase(ledger, 'researching', at(12))
  for (const step of ROUNDS(at).slice(0, rounds)) {
    ledger = appendStep(ledger, step, new Date(step.startedAt))
  }
  return ledger
}

/**
 * The run's own life, frame by frame: what the ledger looks like at each step
 * of a run that goes all the way. The motion preview walks this list on a
 * timer, so the choreography can be watched rather than argued about — every
 * frame is built by the same fold helpers the real thing uses, so nothing in
 * it can be a shape the product cannot produce.
 */
export function runSequence(runId: string, start: Date): RunLedger[] {
  const at = (s: number): Date => new Date(start.getTime() + s * 1000)
  const frames: RunLedger[] = []
  let ledger = emptyRunLedger(runId, start)
  frames.push(ledger)
  ledger = openPhase(ledger, 'planning', at(1))
  frames.push(ledger)
  ledger = appendStep(ledger, PLAN_STEP(at(2)), at(2))
  ledger = closePhase(ledger, 'planning', at(12))
  ledger = openPhase(ledger, 'researching', at(12))
  frames.push(ledger)
  for (const step of ROUNDS(at)) {
    ledger = appendStep(ledger, step, new Date(step.startedAt))
    frames.push(ledger)
  }
  ledger = closePhase(ledger, 'researching', at(120))
  ledger = openPhase(ledger, 'checking', at(120))
  frames.push(ledger)
  ledger = closePhase(ledger, 'checking', at(145))
  ledger = openPhase(ledger, 'writing', at(145))
  frames.push(ledger)
  ledger = closePhase(ledger, 'writing', at(186))
  ledger = openPhase(ledger, 'filed', at(186))
  frames.push(ledger)
  ledger = finishRun(
    ledger,
    { fileId: 'doc-brandschutz-fluchtwege', reportMessageId: 'm-report', filedAt: at(189).toISOString() },
    at(189),
  )
  frames.push(ledger)
  return frames
}

const NOW = Date.now()
const secondsAgo = (s: number): Date => new Date(NOW - s * 1000)
const MORNING = new Date('2026-09-16T07:41:00.000Z')
const morning = (s: number): Date => new Date(MORNING.getTime() + s * 1000)

export const RUN_CREATED: RunLedger = emptyRunLedger('run-angelegt', secondsAgo(3))

/** Recherchieren live: 3 rounds, 9 documents, one re-read, open points. Started 1:42 ago. */
export const RUN_RUNNING: RunLedger = researched('run-laeuft', secondsAgo(102), 3)

export const RUN_WAITING: RunLedger = setRunStatus(
  researched('run-wartet', secondsAgo(140), 2),
  'waiting',
  secondsAgo(80),
)

function finished(runId: string, fileId: string | undefined): RunLedger {
  let ledger = researched(runId, MORNING, 3)
  ledger = closePhase(ledger, 'researching', morning(102))
  ledger = openPhase(ledger, 'checking', morning(102))
  ledger = closePhase(ledger, 'checking', morning(127))
  ledger = openPhase(ledger, 'writing', morning(127))
  ledger = closePhase(ledger, 'writing', morning(168))
  ledger = openPhase(ledger, 'filed', morning(168))
  return finishRun(
    ledger,
    { ...(fileId ? { fileId } : {}), filedAt: morning(171).toISOString() },
    morning(171),
  )
}

export const RUN_DONE: RunLedger = finished('run-fertig', 'doc-brandschutz-fluchtwege')
export const RUN_DONE_INLINE: RunLedger = finished('run-fertig-inline', undefined)

export const RUN_FAILED: RunLedger = (() => {
  let ledger = researched('run-fehlgeschlagen', MORNING, 2)
  ledger = closePhase(ledger, 'researching', morning(70))
  ledger = openPhase(ledger, 'checking', morning(70))
  return failRun(ledger, 'Das Budget war aufgebraucht, bevor die Prüfung fertig war.', morning(84))
})()

export const RUN_CANCELLED: RunLedger = (() => {
  const ledger = setRunStatus(researched('run-abgebrochen', MORNING, 1), 'cancelled', morning(38))
  return { ...ledger, finishedAt: morning(38).toISOString() }
})()

export const RUN_INTERRUPTED: RunLedger = (() => {
  let ledger = researched('run-unterbrochen', MORNING, 2)
  ledger = closePhase(ledger, 'researching', morning(61))
  ledger = openPhase(ledger, 'writing', morning(61))
  ledger = closePhase(ledger, 'writing', morning(95))
  ledger = openPhase(ledger, 'filed', morning(95))
  ledger = finishRun(ledger, { fileId: 'doc-brandschutz-teil', filedAt: morning(97).toISOString() }, morning(97))
  return setRunStatus(ledger, 'interrupted', morning(97))
})()
