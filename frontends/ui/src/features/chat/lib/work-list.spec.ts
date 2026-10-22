/**
 * The work list's data (ADR-0131): action steps folded from the wire, grouped
 * by round, the prefetch drawing none; same-kind calls folded and a long round
 * worst first; the call id that links a row to its cards surviving the
 * sanitizer a reload goes through; and the words of each row.
 */
import { describe, expect, test } from 'vitest'
import { createTranslator } from '@/i18n/translate'
import { de } from '@/i18n/dictionaries/de'
import { en } from '@/i18n/dictionaries/en'
import { sanitizeThinkingSteps, type StoredAction } from '@/lib/conversations/message-provenance'
import {
  foldScene,
  manyCallsScene,
  mockupScene,
  northStarLiveScene,
  northStarScene,
} from '@/test-utils/work-list-scenes'
import { storedSteps } from '@/test-utils/wire-v2-steps'
import {
  allRows,
  callIdsByDocument,
  foldRows,
  hasActions,
  isLinked,
  limitRows,
  prefetchRounds,
  workKind,
  workRounds,
  type WorkRow,
} from './work-list'
import { breadcrumb, firstPage, pageRange, workParts, workPartsText } from './work-sentence'
import { normalizeFileName } from './citations'

describe('the fold of an action', () => {
  test('STARTED makes the running row, FINISHED replaces it by id and keeps the start', () => {
    const started = foldScene(northStarLiveScene()).find((step) => step.id === 'action:4')!
    expect(started).toMatchObject({
      kind: 'action',
      isComplete: false,
      round: 2,
      action: { verb: 'read', status: 'running' },
    })
    const settled = foldScene(northStarScene())
    expect(settled.filter((step) => step.id === 'action:4')).toHaveLength(1)
    const read = settled.find((step) => step.id === 'action:4')!
    expect(read).toMatchObject({
      isComplete: true,
      action: {
        verb: 'read',
        status: 'ok',
        target: 'Einreichplan EG.pdf',
        pages: '2-3',
        elapsedMs: 900,
      },
    })
    expect(Date.parse(read.timestamp)).toBe(Date.UTC(2026, 9, 22, 10, 0, 0) + 2600)
  })

  test('a finish that arrives alone began elapsed_ms before it', () => {
    const [row] = storedSteps([
      {
        id: 'a',
        call_id: 'c',
        kind: 'action',
        verb: 'list',
        status: 'ok',
        round: 0,
        elapsed_ms: 500,
        counts: { files: 3 },
      },
    ])
    // storedSteps stamps ts = origin + seq * 10
    expect(Date.parse(row.timestamp)).toBe(1_759_000_000_000 + 10 - 500)
    expect(row.action?.counts).toEqual({ files: 3 })
  })

  test('survives the sanitizer a reload goes through, and drops what is not a verb', () => {
    const steps = foldScene(northStarScene())
    const kept = sanitizeThinkingSteps(JSON.parse(JSON.stringify(steps)))!
    expect(kept.filter((step) => step.kind === 'action').map((step) => step.action)).toEqual(
      steps.filter((step) => step.kind === 'action').map((step) => step.action)
    )
    expect(kept[0].timestamp).toBe(steps[0].timestamp)
    const bad = sanitizeThinkingSteps([
      { ...steps[0], action: { ...steps[0].action, verb: 'delete' } },
    ])!
    expect(bad[0].action).toBeUndefined()
  })

  test('the call id rides the action and the sources it returned, through the fold and a reload', () => {
    const steps = foldScene(mockupScene())
    const read = steps.find((step) => step.id === 'call:c4')!
    const sources = steps.find((step) => step.id === 'sources:call:c4')!
    expect(read.callId).toBe('call:c4')
    expect(sources.callId).toBe('call:c4')
    const kept = sanitizeThinkingSteps(JSON.parse(JSON.stringify(steps)))!
    expect(kept.find((step) => step.id === 'call:c4')!.callId).toBe('call:c4')
    expect(kept.find((step) => step.id === 'sources:call:c4')!.callId).toBe('call:c4')
    // Only an action or a sources step carries one; and it is bounded like the wire bounds it.
    const [status] = sanitizeThinkingSteps([{ ...steps[0], kind: 'status', callId: 'x' }])!
    expect(status.callId).toBeUndefined()
    const [long] = sanitizeThinkingSteps([{ ...read, callId: 'x'.repeat(200) }])!
    expect(long.callId).toHaveLength(64)
  })

  test('the prefetch flag of round 0 survives the fold and a reload', () => {
    const steps = foldScene(mockupScene())
    expect(prefetchRounds(steps)).toEqual(new Set([0]))
    expect(prefetchRounds(sanitizeThinkingSteps(JSON.parse(JSON.stringify(steps)))!)).toEqual(
      new Set([0])
    )
  })
})

describe('workRounds', () => {
  const rounds = workRounds(foldScene(northStarScene()))

  test('groups calls into rounds in the order they started; no time is kept', () => {
    expect(rounds.map((round) => [round.round, round.rows.map((row) => row.action.verb)])).toEqual([
      [1, ['search', 'list', 'search']],
      [2, ['read', 'look']],
    ])
    expect(rounds.every((round) => !round.running && round.more.length === 0)).toBe(true)
    expect(Object.keys(rounds[0].rows[0])).not.toContain('leftPercent')
  })

  test('the look step joins the look row of its round; none is left over', () => {
    const look = rounds[1].rows.find((row) => row.action.verb === 'look')!
    expect(look.looks).toHaveLength(1)
    expect(rounds[1].strayLooks).toEqual([])
  })

  test('a live round has running rows', () => {
    const live = workRounds(foldScene(northStarLiveScene()))
    expect(live[0].running).toBe(false)
    expect(live[1].running).toBe(true)
    expect(live[1].rows.every((row) => row.running)).toBe(true)
  })

  test('the decision’s prefetch draws no row: its round is no step', () => {
    const steps = foldScene(mockupScene())
    expect(workRounds(steps).map((round) => round.round)).toEqual([1, 2])
    expect(
      workRounds(steps)
        .flatMap(allRows)
        .map((row) => row.id)
    ).not.toContain('call:p0')
  })

  test('every row carries its call id', () => {
    const [first] = workRounds(foldScene(mockupScene()))
    expect(first.rows.map((row) => row.callIds)).toEqual([['call:c1'], ['call:c2'], ['call:c3']])
  })

  test('a turn without actions has no work list', () => {
    expect(
      hasActions(storedSteps([{ id: 't', kind: 'tool', tool: 'list_files', status: 'ok' }]))
    ).toBe(false)
    expect(hasActions(foldScene(northStarScene()))).toBe(true)
  })
})

describe('a busy step stays readable', () => {
  const row = (
    id: string,
    verb: StoredAction['verb'],
    status: StoredAction['status'] = 'ok',
    hits = 1
  ): WorkRow => ({
    id,
    action: { verb, status, counts: { hits } },
    running: false,
    callIds: [id],
    looks: [],
  })

  test('three or more settled calls of one kind fold into one row, at the first one’s place, counts summed', () => {
    const folded = foldRows([
      row('a', 'read'),
      row('s', 'search'),
      row('b', 'read', 'ok', 2),
      row('c', 'read', 'ok', 3),
    ])
    expect(folded.map((r) => r.id)).toEqual(['a', 's'])
    expect(folded[0].fold).toEqual({ count: 3, counts: { hits: 6 } })
    expect(folded[0].callIds).toEqual(['a', 'b', 'c'])
  })

  test('two of a kind stay two; a call that failed or found nothing never folds', () => {
    expect(foldRows([row('a', 'read'), row('b', 'read')])).toHaveLength(2)
    expect(
      foldRows([row('a', 'read', 'empty'), row('b', 'read', 'empty'), row('c', 'read', 'empty')])
    ).toHaveLength(3)
  })

  test('more than five rows: the worst three in view, the rest folded', () => {
    const rows = [
      row('ok1', 'search'),
      row('ok2', 'web'),
      row('empty', 'law', 'empty'),
      row('ok3', 'list'),
      row('err', 'lookup', 'error'),
      row('ok4', 'model'),
    ]
    const { rows: shown, more } = limitRows(rows)
    expect(shown.map((r) => r.id)).toEqual(['err', 'empty', 'ok1'])
    expect(more.map((r) => r.id)).toEqual(['ok2', 'ok3', 'ok4'])
    expect(limitRows(rows.slice(0, 5)).more).toEqual([])
  })

  test('the many-calls scene: ×7 reads, the empty search first, „+N weitere“', () => {
    const [round] = workRounds(foldScene(manyCallsScene()))
    expect(round.rows[0].action.status).toBe('empty')
    expect(round.rows).toHaveLength(3)
    const reads = allRows(round).find((r) => r.action.verb === 'read')!
    expect(reads.fold?.count).toBe(7)
    expect(round.more.length).toBe(4)
  })

  test('a step is named by what its calls did', () => {
    const [first, second] = workRounds(foldScene(mockupScene()))
    expect(workKind(first)).toBe('search')
    expect(workKind(second)).toBe('read')
  })
})

describe('the link between rows and cards', () => {
  test('a document maps to the calls whose sources named it; the prefetch’s own hit too', () => {
    const calls = callIdsByDocument(foldScene(mockupScene()), normalizeFileName)
    expect(calls.get(normalizeFileName('Einreichplan EG.pdf'))).toEqual(['call:c4'])
    expect(calls.get(normalizeFileName('Brandschutzkonzept.pdf'))).toEqual(['call:c1'])
    expect(calls.get(normalizeFileName('oib-rl_2_ausgabe_mai_2023.pdf'))).toEqual(['call:p0'])
  })

  test('a sources step stored before call ids links nothing', () => {
    const steps = foldScene(mockupScene()).map((step) => ({ ...step, callId: undefined }))
    expect(callIdsByDocument(steps, normalizeFileName).size).toBe(0)
  })

  test('linked means sharing a call; nothing is linked without a selection or a call id', () => {
    const selection = { key: 'row', callIds: ['a', 'b'] }
    expect(isLinked(selection, ['b'])).toBe(true)
    expect(isLinked(selection, ['c'])).toBe(false)
    expect(isLinked(selection, [])).toBe(false)
    expect(isLinked(null, ['a'])).toBe(false)
  })
})

describe('workParts', () => {
  const t = createTranslator(de, 'chat')
  const text = (action: StoredAction, options?: Parameters<typeof workParts>[2]) =>
    workPartsText(workParts(t, action, options))

  test('a search: the verb with its mode, the query where it looked, what it found', () => {
    expect(
      workParts(t, {
        verb: 'search',
        status: 'ok',
        mode: 'exact',
        shelf: 'project',
        query: 'Brandabschnitt',
        counts: { hits: 14, documents: 3, searched: 41 },
      })
    ).toEqual({
      verb: 'Sucht wörtlich',
      object: '„Brandabschnitt“ im Projekt',
      result: '14 Treffer · 3 Dokumente',
      tone: 'ok',
    })
    // „von 41“ went by the value test: the place proves, the denominator does not.
    expect(text({ verb: 'search', status: 'ok', query: 'Fläche', counts: { hits: 1 } })).toBe(
      'Sucht „Fläche“: 1 Treffer'
    )
  })

  test('a search in one document that found nothing says where it looked', () => {
    expect(
      workParts(t, {
        verb: 'search',
        status: 'empty',
        target: 'OIB-RL 2, Ausgabe 2023',
        query: 'Brandabschnitt Tiefgarage',
      })
    ).toEqual({
      verb: 'Sucht in',
      object: 'OIB-RL 2, Ausgabe 2023: „Brandabschnitt Tiefgarage“',
      result: 'kein Treffer',
      tone: 'empty',
    })
  })

  test('a listing is a breadcrumb with its counts', () => {
    expect(
      text({
        verb: 'list',
        status: 'ok',
        target: '03 Einreichung/Pläne',
        counts: { files: 12, folders: 2 },
      })
    ).toBe('Öffnet 03 Einreichung › Pläne: 12 Dateien, 2 Ordner')
    expect(breadcrumb('a\\b/c')).toBe('a › b › c')
  })

  test('read and look give pages typeset, or a Punkt; a look its place and its reading', () => {
    expect(
      text({ verb: 'read', status: 'ok', target: 'EG.pdf', pages: '2-3', counts: { hits: 2 } })
    ).toBe('Liest EG.pdf, S. 2–3: 2 Stellen')
    expect(text({ verb: 'read', status: 'ok', target: 'OIB-RL 2', pages: 'Pkt. 3.5' })).toBe(
      'Liest OIB-RL 2, Pkt. 3.5'
    )
    expect(
      text(
        { verb: 'look', status: 'ok', target: 'EG.pdf', pages: '2' },
        { where: 'oben rechts', reading: 'BA 2: 1.420 m²' }
      )
    ).toBe('Sieht sich an EG.pdf, S. 2, oben rechts: BA 2: 1.420 m²')
    // A long reading is no figure for the row's right edge.
    expect(
      workParts(t, { verb: 'look', status: 'ok', target: 'EG.pdf' }, { reading: 'x'.repeat(80) })
        .result
    ).toBe('')
    expect(pageRange('2-3')).toBe('2–3')
    expect(firstPage('Pkt. 3.5')).toBeNull()
    expect(firstPage('2-3')).toBe(2)
  })

  test('the other verbs', () => {
    expect(text({ verb: 'law', status: 'ok', query: 'Wiener Garagengesetz' })).toBe(
      'Sucht im RIS „Wiener Garagengesetz“'
    )
    expect(text({ verb: 'web', status: 'ok', query: 'ÖNORM B 3806', counts: { hits: 6 } })).toBe(
      'Sucht im Web „ÖNORM B 3806“: 6 Treffer'
    )
    expect(text({ verb: 'lookup', status: 'ok', query: 'Tiefgarage' })).toBe(
      'Sucht in anderen Projekten „Tiefgarage“'
    )
    expect(text({ verb: 'model', status: 'ok', query: 'Fläche' })).toBe(
      'Fragt das Gebäudemodell Fläche'
    )
    expect(text({ verb: 'workspace', status: 'ok', target: 'task-list' })).toBe(
      'Arbeitsbereich: task-list'
    )
    // Without a target, the fallback sentence stands alone.
    expect(workParts(t, { verb: 'read', status: 'ok' })).toMatchObject({
      verb: '',
      object: 'Liest ein Dokument',
    })
  })

  test('status is a word: running, no hit, nothing found, failed', () => {
    expect(
      workParts(t, { verb: 'search', status: 'running', query: 'x' }, { running: true })
    ).toMatchObject({
      result: 'läuft',
      tone: 'running',
    })
    expect(workParts(t, { verb: 'read', status: 'empty', target: 'a.pdf' })).toMatchObject({
      result: 'nichts gefunden',
      tone: 'empty',
    })
    expect(workParts(t, { verb: 'law', status: 'error', query: 'x' })).toMatchObject({
      result: 'fehlgeschlagen',
      tone: 'error',
    })
  })

  test('a folded row names how many, and sums what they found', () => {
    expect(
      text(
        { verb: 'read', status: 'ok', target: 'Plan 1.pdf' },
        { fold: { count: 7, counts: { hits: 18 } } }
      )
    ).toBe('Liest 7 Dokumente: 18 Stellen')
  })

  test('the English twin reads', () => {
    const tEn = createTranslator(en, 'chat')
    expect(
      workPartsText(
        workParts(tEn, {
          verb: 'search',
          status: 'ok',
          mode: 'exact',
          shelf: 'project',
          query: 'x',
          counts: { hits: 2, documents: 1 },
        })
      )
    ).toBe('Searches verbatim “x” in the project: 2 hits · 1 document')
  })
})
