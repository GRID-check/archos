/**
 * The work list's data (ADR-0131): action steps folded from the wire, grouped
 * by round, with bars on the round's shared axis; the stored form surviving
 * the sanitizer a reload goes through; and one sentence per verb.
 */
import { describe, expect, test } from 'vitest'
import { createTranslator } from '@/i18n/translate'
import { de } from '@/i18n/dictionaries/de'
import { en } from '@/i18n/dictionaries/en'
import { sanitizeThinkingSteps, type StoredAction } from '@/lib/conversations/message-provenance'
import { foldScene, northStarLiveScene, northStarScene } from '@/test-utils/work-list-scenes'
import { storedSteps } from '@/test-utils/wire-v2-steps'
import { formatWorkDuration, hasActions, workRounds } from './work-list'
import { breadcrumb, firstPage, workSentence, workSentenceText } from './work-sentence'

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
})

describe('workRounds', () => {
  const rounds = workRounds(foldScene(northStarScene()))

  test('groups calls into rounds, numbered from 1, with the wall time of the round', () => {
    expect(rounds.map((round) => [round.ordinal, round.rows.length])).toEqual([
      [1, 3],
      [2, 2],
    ])
    // 150 + 2250 = 2400 ms is the last end of round 1
    expect(rounds[0].durationMs).toBe(2400)
    expect(rounds[1].durationMs).toBe(1620)
    expect(rounds.every((round) => !round.running)).toBe(true)
  })

  test('bars sit on the shared axis: left is the start offset, width the duration', () => {
    const [search, list, meaning] = rounds[0].rows
    expect(search.leftPercent).toBe(0)
    expect(search.widthPercent).toBeCloseTo((1800 / 2400) * 100)
    expect(list.leftPercent).toBeCloseTo((100 / 2400) * 100)
    expect(list.widthPercent).toBeCloseTo((600 / 2400) * 100)
    expect(meaning.leftPercent).toBeCloseTo((150 / 2400) * 100)
    expect(meaning.leftPercent + meaning.widthPercent).toBeCloseTo(100)
    // they overlap: that is the point
    expect(list.leftPercent).toBeLessThan(search.leftPercent + search.widthPercent)
  })

  test('the look step joins the look row of its round; none is left over', () => {
    const look = rounds[1].rows.find((row) => row.action.verb === 'look')!
    expect(look.looks).toHaveLength(1)
    expect(rounds[1].strayLooks).toEqual([])
  })

  test('a live round has running rows, no duration, and bars that run to the axis end', () => {
    const live = workRounds(foldScene(northStarLiveScene()))
    expect(live[0].running).toBe(false)
    expect(live[1]).toMatchObject({ running: true, durationMs: null })
    for (const row of live[1].rows) {
      expect(row.running).toBe(true)
      expect(row.leftPercent + row.widthPercent).toBeCloseTo(100)
    }
  })

  test('a turn without actions has no work list', () => {
    expect(
      hasActions(storedSteps([{ id: 't', kind: 'tool', tool: 'list_files', status: 'ok' }]))
    ).toBe(false)
    expect(hasActions(foldScene(northStarScene()))).toBe(true)
  })
})

describe('formatWorkDuration', () => {
  test('reads like 2,4 s', () => {
    expect(formatWorkDuration(2400, 'de')).toBe('2,4 s')
    expect(formatWorkDuration(2400, 'en')).toBe('2.4 s')
    expect(formatWorkDuration(65_000, 'de')).toBe('1:05 min')
  })
})

describe('workSentence', () => {
  const t = createTranslator(de, 'chat')
  const text = (action: StoredAction) => workSentenceText(workSentence(t, action))

  test('a meaning search names the shelf, the query and the hits', () => {
    expect(
      text({
        verb: 'search',
        status: 'ok',
        mode: 'meaning',
        shelf: 'project',
        query: 'Fluchtweg',
        counts: { hits: 6, documents: 2 },
      })
    ).toBe('Sucht im Projekt „Fluchtweg“ · 6 Treffer in 2 Dokumenten')
    expect(
      text({
        verb: 'search',
        status: 'ok',
        mode: 'meaning',
        query: 'Fluchtweg',
        counts: { hits: 1, documents: 1 },
      })
    ).toBe('Sucht „Fluchtweg“ · 1 Treffer in 1 Dokument')
  })

  test('a literal search says how many documents it searched, and adapts without counts', () => {
    expect(
      text({
        verb: 'search',
        status: 'ok',
        mode: 'exact',
        query: 'GK4',
        counts: { hits: 14, documents: 3, searched: 212 },
      })
    ).toBe('Sucht wörtlich „GK4“ · 14 Treffer in 3 von 212 Dokumenten')
    expect(
      text({
        verb: 'search',
        status: 'ok',
        mode: 'exact',
        query: 'GK4',
        counts: { hits: 14, documents: 3 },
      })
    ).toBe('Sucht wörtlich „GK4“ · 14 Treffer in 3 Dokumenten')
    expect(
      text({ verb: 'search', status: 'ok', mode: 'regex', query: 'GK\\d', counts: { hits: 2 } })
    ).toBe('Sucht nach Muster „GK\\d“ · 2 Treffer')
  })

  test('a listing is a breadcrumb with its counts', () => {
    expect(breadcrumb('03 Einreichung/Pläne')).toBe('03 Einreichung › Pläne')
    expect(
      text({
        verb: 'list',
        status: 'ok',
        target: '03 Einreichung/Pläne',
        counts: { files: 12, folders: 2 },
      })
    ).toBe('Öffnet 03 Einreichung › Pläne · 12 Dateien, 2 Ordner')
    expect(
      text({ verb: 'list', status: 'ok', target: 'A', counts: { files: 1, folders: 0 } })
    ).toBe('Öffnet A · 1 Datei, 0 Ordner')
  })

  test('read and look give pages, or a Punkt', () => {
    expect(text({ verb: 'read', status: 'ok', target: 'EG.pdf', pages: '2-3' })).toBe(
      'Liest EG.pdf, S. 2-3'
    )
    expect(text({ verb: 'read', status: 'ok', target: 'OIB 2', pages: 'Pkt. 3.5' })).toBe(
      'Liest OIB 2, Pkt. 3.5'
    )
    expect(text({ verb: 'look', status: 'ok', target: 'EG.pdf', pages: '2' })).toBe(
      'Sieht sich EG.pdf, S. 2 an'
    )
    expect(firstPage('2-3')).toBe(2)
    expect(firstPage('Pkt. 3.5')).toBeNull()
  })

  test('the other verbs', () => {
    expect(
      text({
        verb: 'lookup',
        status: 'ok',
        query: 'Stiegenhaus',
        counts: { hits: 3, documents: 2 },
      })
    ).toBe('Sucht in anderen Projekten „Stiegenhaus“ · 3 Treffer in 2 Dokumenten')
    expect(text({ verb: 'law', status: 'ok', target: 'BO für Wien § 108' })).toBe(
      'Ruft BO für Wien § 108 im RIS ab'
    )
    expect(text({ verb: 'web', status: 'ok', query: 'Brandschutz', counts: { hits: 6 } })).toBe(
      'Sucht im Web „Brandschutz“ · 6 Treffer'
    )
    expect(text({ verb: 'model', status: 'ok', query: 'Flächen je Geschoss' })).toBe(
      'Fragt das Modell ab: Flächen je Geschoss'
    )
    expect(text({ verb: 'workspace', status: 'ok', target: 'Projekte auflisten' })).toBe(
      'Arbeitsbereich: Projekte auflisten'
    )
  })

  test('empty and error finish the sentence, and error takes the error tone', () => {
    const empty = workSentence(t, { verb: 'search', status: 'empty', mode: 'exact', query: 'XYZ' })
    expect(workSentenceText(empty)).toBe('Sucht wörtlich „XYZ“ · nichts gefunden')
    expect(empty.tone).toBe('empty')
    const failed = workSentence(t, { verb: 'read', status: 'error', target: 'EG.pdf' })
    expect(workSentenceText(failed)).toBe('Liest EG.pdf · fehlgeschlagen')
    expect(failed.tone).toBe('error')
  })

  test('running has no outcome; the English twin reads', () => {
    expect(
      workSentence(t, { verb: 'list', status: 'running', target: 'A' }).outcome
    ).toBeUndefined()
    const english = createTranslator(en, 'chat')
    expect(
      workSentenceText(
        workSentence(english, {
          verb: 'search',
          status: 'ok',
          mode: 'meaning',
          shelf: 'base',
          query: 'egress',
          counts: { hits: 2, documents: 1 },
        })
      )
    ).toBe('Searches in the knowledge base “egress” · 2 hits in 1 document')
  })
})
