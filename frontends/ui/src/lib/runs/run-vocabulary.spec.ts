/**
 * @vitest-environment node
 */

/**
 * The vocabulary map — what one ledger is read to SAY.
 *
 * Three surfaces render from these derivations (the block, the compact line,
 * the task card), so each answer is pinned once here rather than three times
 * in three component specs. The fixtures are built with the ledger's own fold
 * helpers, at fixed instants, so a tally or a duration below is a fact about
 * the helpers and the derivation together — the same pair production runs.
 */

import { describe, expect, it } from 'vitest'
import {
  appendStep,
  closePhase,
  emptyRunLedger,
  failRun,
  finishRun,
  openPhase,
  setRunStatus,
} from './run-ledger'
import type { RunLedger, RunStep } from './run-ledger-types'
import {
  activePhase,
  completedBefore,
  elapsedMs,
  basisReceipt,
  isLiveStatus,
  phaseDurationMs,
  phaseState,
  runDisplayStatus,
  runTallies,
  stepsInPhase,
} from './run-vocabulary'

const T0 = new Date('2026-09-16T08:00:00.000Z')
const at = (seconds: number): Date => new Date(T0.getTime() + seconds * 1000)

const step = (id: string, phase: RunStep['phase'], docs: string[], seconds: number): RunStep => ({
  id,
  phase,
  intent: `Schritt ${id}`,
  startedAt: at(seconds).toISOString(),
  docs: docs.map((name) => ({ name, loci: ['S. 1'] })),
})

/** Planen done at 12 s, two research rounds over four documents, still researching. */
function researching(): RunLedger {
  let ledger = emptyRunLedger('run-1', T0)
  ledger = openPhase(ledger, 'planning', at(0))
  ledger = appendStep(ledger, step('p1', 'planning', [], 1), at(1))
  ledger = closePhase(ledger, 'planning', at(12))
  ledger = openPhase(ledger, 'researching', at(12))
  ledger = appendStep(
    ledger,
    step('r1', 'researching', ['OIB-Richtlinie 2', 'BO Wien'], 20),
    at(20)
  )
  ledger = appendStep(
    ledger,
    step('r2', 'researching', ['OIB-Richtlinie 2', 'Grundriss EG', 'Brandschutzkonzept'], 45),
    at(45)
  )
  return ledger
}

describe('runDisplayStatus', () => {
  it('is the ledger status when it is one of the seven', () => {
    expect(runDisplayStatus(researching())).toBe('running')
    expect(runDisplayStatus(setRunStatus(researching(), 'waiting', at(50)))).toBe('waiting')
  })

  it('derives a word for a status this build does not know', () => {
    const unknown = { ...researching(), status: 'paused' as RunLedger['status'] }
    expect(runDisplayStatus(unknown)).toBe('running')
    expect(runDisplayStatus({ ...unknown, phases: [] })).toBe('created')
    expect(
      runDisplayStatus({ ...failRun(unknown, 'Budget', at(60)), status: unknown.status })
    ).toBe('failed')
    expect(
      runDisplayStatus({
        ...finishRun(unknown, { filedAt: at(60).toISOString() }, at(60)),
        status: unknown.status,
      })
    ).toBe('done')
  })
})

describe('isLiveStatus', () => {
  it('is true for the three states that still move or wait', () => {
    expect(isLiveStatus('created')).toBe(true)
    expect(isLiveStatus('running')).toBe(true)
    expect(isLiveStatus('waiting')).toBe(true)
    expect(isLiveStatus('done')).toBe(false)
    expect(isLiveStatus('failed')).toBe(false)
    expect(isLiveStatus('cancelled')).toBe(false)
    expect(isLiveStatus('interrupted')).toBe(false)
  })
})

describe('activePhase and phaseState', () => {
  it('names the last open phase and reads each phase relative to it', () => {
    const ledger = researching()
    expect(activePhase(ledger)).toBe('researching')
    expect(phaseState(ledger, 'planning')).toBe('done')
    expect(phaseState(ledger, 'researching')).toBe('active')
    expect(phaseState(ledger, 'checking')).toBe('pending')
    expect(phaseState(ledger, 'filed')).toBe('pending')
  })

  it('has no active phase before the first one opens, or once every one has closed', () => {
    expect(activePhase(emptyRunLedger('run-0', T0))).toBeNull()
    const done = finishRun(researching(), { filedAt: at(90).toISOString() }, at(90))
    expect(activePhase(done)).toBeNull()
    expect(phaseState(done, 'researching')).toBe('done')
  })

  it('keeps the phase a failed run stopped in as active — the ring without the pulse', () => {
    let ledger = closePhase(researching(), 'researching', at(60))
    ledger = openPhase(ledger, 'checking', at(60))
    const failed = failRun(ledger, 'Das Budget war aufgebraucht.', at(70))
    expect(phaseState(failed, 'checking')).toBe('active')
    expect(activePhase(failed)).toBe('checking')
  })
})

describe('runTallies and stepsInPhase', () => {
  it('counts research rounds and distinct document names', () => {
    expect(runTallies(researching())).toEqual({ rounds: 2, docs: 4, findings: 0 })
    expect(stepsInPhase(researching(), 'researching').map((s) => s.id)).toEqual(['r1', 'r2'])
    expect(stepsInPhase(researching(), 'checking')).toEqual([])
  })

  it('does not count a planning step as a round', () => {
    expect(runTallies(emptyRunLedger('run-0', T0))).toEqual({ rounds: 0, docs: 0, findings: 0 })
    let ledger = openPhase(emptyRunLedger('run-0', T0), 'planning', at(0))
    ledger = appendStep(ledger, step('p1', 'planning', ['Grundriss EG'], 1), at(1))
    expect(runTallies(ledger)).toEqual({ rounds: 0, docs: 1, findings: 0 })
  })
})

describe('completedBefore', () => {
  it('is the error’s own list on a failed run, in phase order', () => {
    let ledger = closePhase(researching(), 'researching', at(60))
    ledger = openPhase(ledger, 'checking', at(60))
    const failed = failRun(ledger, 'Budget', at(70))
    expect(completedBefore(failed)).toEqual(['planning', 'researching'])
  })

  it('falls back to the ended phases for a run that stopped without an error', () => {
    const stopped = setRunStatus(researching(), 'cancelled', at(50))
    expect(completedBefore(stopped)).toEqual(['planning'])
  })

  it('orders the phases as the run walks them, whatever order the error lists', () => {
    const ledger: RunLedger = {
      ...researching(),
      error: { reason: 'x', completedBefore: ['researching', 'planning'] },
    }
    expect(completedBefore(ledger)).toEqual(['planning', 'researching'])
  })
})

describe('elapsedMs and phaseDurationMs', () => {
  it('measures a live run up to now and a finished run up to its end', () => {
    const live = researching()
    expect(elapsedMs(live, at(102).getTime())).toBe(102_000)
    const done = finishRun(live, { filedAt: at(90).toISOString() }, at(90))
    expect(elapsedMs(done, at(500).getTime())).toBe(90_000)
  })

  // A run that asked a question on Friday afternoon showed „68 h" on Monday:
  // a true number about the wrong subject. The pill says how long the WORK
  // took, and between the ask and the answer the run is doing none.
  it('stops the clock at the ask while a run is waiting for an answer', () => {
    const asking = setRunStatus(researching(), 'waiting', at(102))
    expect(elapsedMs(asking, at(102).getTime())).toBe(102_000)
    expect(elapsedMs(asking, at(60_000).getTime())).toBe(102_000)
  })

  it('never goes negative and reads zero for an instant it cannot parse', () => {
    expect(elapsedMs(researching(), at(-5).getTime())).toBe(0)
    expect(elapsedMs({ ...researching(), startedAt: 'gestern' }, at(10).getTime())).toBe(0)
  })

  it('measures a closed phase by its own bounds and an open one up to now', () => {
    const live = researching()
    expect(phaseDurationMs(live, 'planning', at(100).getTime())).toBe(12_000)
    expect(phaseDurationMs(live, 'researching', at(100).getTime())).toBe(88_000)
    expect(phaseDurationMs(live, 'checking', at(100).getTime())).toBeNull()
  })

  it('stops an open phase at the run’s end once the run is terminal', () => {
    const failed = failRun(researching(), 'Budget', at(70))
    expect(phaseDurationMs(failed, 'researching', at(1000).getTime())).toBe(58_000)
  })
})

describe('basisReceipt', () => {
  it('reads every named document against the steps: read with its loci, or unread', () => {
    const ledger: RunLedger = {
      ...researching(),
      basis: [
        { name: 'grundriss eg', title: 'Grundriss EG', shelf: 'project', loci: [] },
        { name: 'Einreichplan.pdf', shelf: 'project', loci: [] },
      ],
    }
    const receipt = basisReceipt(ledger)
    expect(receipt.map((row) => [row.doc.name, row.read, row.loci])).toEqual([
      ['grundriss eg', true, ['S. 1']],
      ['Einreichplan.pdf', false, []],
    ])
  })

  it('collects the loci across rounds, once each, for a document reached twice', () => {
    let ledger = researching()
    ledger = appendStep(
      ledger,
      {
        ...step('r3', 'researching', ['Grundriss EG'], 60),
        docs: [{ name: 'Grundriss EG', loci: ['Achse C–E', 'S. 2'] }],
      },
      at(60)
    )
    ledger = appendStep(
      ledger,
      {
        ...step('r4', 'researching', ['Grundriss EG'], 70),
        docs: [{ name: 'Grundriss EG', loci: ['S. 2', 'S. 3'] }],
      },
      at(70)
    )
    const withNamed: RunLedger = { ...ledger, basis: [{ name: 'Grundriss EG', loci: [] }] }
    expect(basisReceipt(withNamed)[0]?.loci).toEqual(['S. 1', 'Achse C–E', 'S. 2', 'S. 3'])
  })

  it('is empty for a run nobody named documents for', () => {
    expect(basisReceipt(researching())).toEqual([])
  })
})
