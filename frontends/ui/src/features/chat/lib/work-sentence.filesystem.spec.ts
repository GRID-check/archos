/**
 * The Herleitung rows of Piloti's filesystem verbs (ADR-0132 × ADR-0133), as an
 * architect reads them: a place and its folder, never a path; a listing that
 * lists, a literal search that says where and how, a read that says which
 * pages; a search that could not search everything says so; a folder or file
 * that is not there is „nicht gefunden“, the same for a restricted one.
 */
import { describe, expect, test } from 'vitest'
import { createTranslator } from '@/i18n/translate'
import { de } from '@/i18n/dictionaries/de'
import { en } from '@/i18n/dictionaries/en'
import {
  legacyPlace,
  sanitizeThinkingSteps,
  type StoredAction,
} from '@/lib/conversations/message-provenance'
import {
  filesystemCitations,
  filesystemEdgesScene,
  filesystemScene,
  foldScene,
} from '@/test-utils/work-list-scenes'
import { openPoints } from './derivation-basis'
import { deriveExecutedSteps } from './executed-steps'
import { foldRows, workRounds, type WorkRow } from './work-list'
import { settledHead, workParts, workPartsText } from './work-sentence'

const t = createTranslator(de, 'chat')
const tEn = createTranslator(en, 'chat')
const NB = ' '

const sentence = (action: StoredAction, translator = t) =>
  workPartsText(workParts(translator, action))

describe('a filesystem row names a place, never a path', () => {
  test('a listing lists its folder, by its breadcrumb, with what the folder holds', () => {
    expect(
      sentence({
        verb: 'list',
        status: 'ok',
        mount: 'project',
        target: '03 Einreichung',
        counts: { files: 12, folders: 2 },
      })
    ).toBe(`Listet 03 Einreichung: 12${NB}Dateien, 2${NB}Ordner`)
    expect(
      sentence({ verb: 'list', status: 'ok', mount: 'project', counts: { files: 0, folders: 4 } })
    ).toBe(`Listet das Projekt: 4${NB}Ordner`)
  })

  test('the places themselves are counted as places', () => {
    expect(
      sentence({ verb: 'list', status: 'ok', mount: 'estate', counts: { files: 62, folders: 3 } })
    ).toBe(`Listet alle Ablagen: 3${NB}Ablagen, 62${NB}Dateien`)
  })

  test('a folder outside the project is named under its place', () => {
    expect(
      sentence({
        verb: 'list',
        status: 'ok',
        mount: 'office',
        target: 'Vorlagen/Bescheide',
        counts: { files: 3, folders: 0 },
      })
    ).toBe(`Listet Büroablage ›${NB}Vorlagen › Bescheide: 3${NB}Dateien`)
    expect(sentence({ verb: 'list', status: 'ok', mount: 'law' })).toBe('Listet die OIB-Richtlinien')
  })

  test('a literal search says where, how and what it found, in that order', () => {
    expect(
      sentence({
        verb: 'search',
        mode: 'exact',
        status: 'ok',
        query: 'Brandabschnitt',
        mount: 'project',
        target: '03 Einreichung',
        counts: { hits: 14, documents: 3, searched: 12 },
      })
    ).toBe(
      `Durchsucht 03 Einreichung wörtlich nach „Brandabschnitt“: 14${NB}Treffer in 3${NB}Dokumenten`
    )
    expect(
      sentence({ verb: 'search', mode: 'regex', status: 'ok', query: 'EI\\s?90', mount: 'estate' })
    ).toBe('Durchsucht alle Ablagen nach dem Muster „EI\\s?90“')
  })

  test('a search by file name quotes its pattern and says where', () => {
    expect(
      sentence({
        verb: 'list',
        status: 'ok',
        query: '*.pdf',
        mount: 'project',
        counts: { files: 7 },
      })
    ).toBe(`Sucht Dateien „*.pdf“ im Projekt: 7${NB}Dateien`)
    expect(
      sentence({ verb: 'list', status: 'empty', query: '*.dwg', mount: 'estate', counts: { files: 0 } })
    ).toBe('Sucht Dateien „*.dwg“ in allen Ablagen: keine Datei')
  })

  test('no row draws a mount word, a slash or a raw .md path', () => {
    const rows = [...workRounds(foldScene(filesystemScene())), ...workRounds(foldScene(filesystemEdgesScene()))]
      .flatMap((round) => [...round.rows, ...round.more])
      .map((row) => workPartsText(workParts(t, row.action)))
    for (const row of rows) {
      // What was looked for is the model's own words (a pattern may hold a slash); the rest is ours.
      expect(row.replace(/„[^“]*“/g, '„…“')).not.toMatch(/\/|\.md\b|\bproject\b|\boffice\b|\blaw\b|\bestate\b| : /)
    }
  })

  test('the English twin reads', () => {
    expect(
      sentence(
        {
          verb: 'search',
          mode: 'exact',
          status: 'ok',
          query: 'Fluchtweg',
          mount: 'estate',
          counts: { hits: 3, documents: 1 },
        },
        tEn
      )
    ).toBe(`Searches every place for the exact words “Fluchtweg”: 3${NB}hits in 1${NB}document`)
    expect(sentence({ verb: 'list', status: 'ok', query: '*.pdf', mount: 'project' }, tEn)).toBe(
      'Looks for files named “*.pdf” in the project'
    )
  })
})

describe('what a filesystem call found, or did not', () => {
  test('a literal search without a hit says how much it searched', () => {
    expect(
      workParts(t, {
        verb: 'search',
        mode: 'exact',
        status: 'empty',
        query: 'Sprinkler',
        mount: 'estate',
        counts: { hits: 0, documents: 0, searched: 41 },
      })
    ).toMatchObject({ result: `kein Treffer in 41${NB}Dokumenten`, tone: 'empty' })
  })

  test('an incomplete search is never drawn as complete: its hits are a floor, its no is no no', () => {
    const found = workParts(t, {
      verb: 'search',
      mode: 'exact',
      status: 'ok',
      query: 'Brandabschnitt',
      mount: 'estate',
      incomplete: true,
      counts: { hits: 3, documents: 1, searched: 9 },
    })
    expect(found).toMatchObject({
      result: `3${NB}Treffer in 1${NB}Dokument, unvollständig`,
      tone: 'incomplete',
      note: 'nicht alles durchsucht – es kann weitere Treffer geben',
    })
    const none = workParts(t, {
      verb: 'search',
      mode: 'exact',
      status: 'empty',
      query: 'Sprinkler',
      mount: 'estate',
      incomplete: true,
      counts: { hits: 0, documents: 0, searched: 9 },
    })
    expect(none).toMatchObject({
      result: `kein Treffer in 9${NB}Dokumenten, unvollständig`,
      tone: 'incomplete',
      note: 'nicht alles durchsucht – das ist kein Nein',
    })
    // A screen reader hears what „unvollständig“ means, not the word alone.
    expect(workPartsText(none)).toContain('das ist kein Nein')
  })

  test('a folder or document that is not there is „nicht gefunden“, by the name asked for', () => {
    expect(
      workParts(t, { verb: 'list', status: 'empty', mount: 'project', target: 'Personal' })
    ).toMatchObject({ verb: 'Listet', object: 'Personal', result: 'nicht gefunden', tone: 'empty' })
    expect(workParts(t, { verb: 'read', status: 'empty', target: 'Vertrag.pdf' })).toMatchObject({
      verb: 'Liest',
      object: 'Vertrag.pdf',
      result: 'nicht gefunden',
    })
  })

  test('a read says the pages it served', () => {
    expect(
      sentence({
        verb: 'read',
        status: 'ok',
        target: 'Baubeschreibung.pdf',
        pages: '4-6',
        counts: { hits: 3, documents: 1 },
      })
    ).toBe(`Liest Baubeschreibung.pdf, S.${NB}4–6: 3${NB}Stellen`)
  })

  test('incomplete rows never fold into a sum', () => {
    const row = (id: string, incomplete: boolean): WorkRow => ({
      id,
      running: false,
      callIds: [id],
      looks: [],
      action: {
        verb: 'search',
        mode: 'exact',
        status: 'ok',
        query: id,
        mount: 'estate',
        ...(incomplete ? { incomplete } : {}),
        counts: { hits: 1 },
      },
    })
    const folded = foldRows([row('a', true), row('b', true), row('c', true)])
    expect(folded).toHaveLength(3)
    expect(folded.every((each) => !each.fold)).toBe(true)
  })

  test('a single call heads the turn in the past', () => {
    expect(
      settledHead(t, {
        verb: 'search',
        mode: 'exact',
        status: 'ok',
        query: 'Fluchtweg',
        mount: 'project',
        counts: { hits: 3 },
      })
    ).toBe('Durchsucht: das Projekt wörtlich nach „Fluchtweg“')
  })
})

describe('„Offen“ for the filesystem', () => {
  test('an incomplete no, a literal no and a miss each say what they are', () => {
    const open = openPoints(t, workRounds(foldScene(filesystemEdgesScene())))
    expect(open).toContain(
      'Nicht beurteilbar, weil die wörtliche Suche in allen Ablagen nach „Sprinkler“ keine Fundstelle ergab.'
    )
    expect(open).toContain(
      'Nicht beurteilbar, weil die wörtliche Suche in Büroablage › Vorlagen nach „EI\\s?90“ nicht alles durchsuchen konnte.'
    )
    expect(open).toContain('Nicht beurteilbar, weil der Ordner „Personal“ nicht gefunden wurde.')
    expect(open).toContain(
      'Nicht beurteilbar, weil das Dokument „Vertrag.pdf“ nicht gefunden wurde.'
    )
    expect(open).toContain('Nicht beurteilbar, weil im Projekt keine Datei auf „*.dwg“ passt.')
    expect(open.join(' ')).not.toMatch(/fehlgeschlagen/)
  })

  test('the happy turn has nothing open', () => {
    expect(openPoints(t, workRounds(foldScene(filesystemScene())), [])).toEqual([])
    expect(filesystemCitations()).toHaveLength(2)
  })
})

describe('a row stored before the wire carried `mount`', () => {
  test('its estate path is read back as a place, its glob pattern as the query', () => {
    expect(legacyPlace({ verb: 'list', status: 'ok', target: '/project/03 Einreichung/' })).toEqual({
      mount: 'project',
      target: '03 Einreichung',
    })
    expect(legacyPlace({ verb: 'search', status: 'ok', mode: 'exact', target: '/' })).toEqual({
      mount: 'estate',
    })
    expect(legacyPlace({ verb: 'list', status: 'ok', target: '/project/ · *.pdf' })).toEqual({
      mount: 'project',
      query: '*.pdf',
    })
    expect(legacyPlace({ verb: 'list', status: 'ok', target: '/law/oib/' })).toEqual({ mount: 'law' })
    // A knowledge_search folder, a read's document, a name without a slash: untouched.
    expect(legacyPlace({ verb: 'search', status: 'ok', target: '03 Einreichung/Pläne' })).toBeNull()
    expect(legacyPlace({ verb: 'read', status: 'ok', target: '/project/a.pdf.md' })).toBeNull()
  })

  test('a reload draws it as the wire draws it now', () => {
    const [step] = sanitizeThinkingSteps([
      {
        id: 'action:old',
        userMessageId: 'm',
        timestamp: '2026-10-26T10:00:00Z',
        isComplete: true,
        kind: 'action',
        action: { verb: 'list', status: 'ok', target: '/project/03 Einreichung/', counts: { files: 2, folders: 0 } },
      },
    ])!
    expect(sentence(step.action!)).toBe(`Listet 03 Einreichung: 2${NB}Dateien`)
  })
})

describe('chips', () => {
  const step = (tool: string, mount: string) => ({
    kind: 'tool' as const,
    tool,
    detail: { mount },
    isComplete: true,
  })
  const key = (value: string) => value

  test('a skill read is no draft, and a draft grep is one', () => {
    expect(deriveExecutedSteps([step('read_file', 'skills')], key)).toEqual([])
    expect(deriveExecutedSteps([step('grep', 'drafts')], key).map((chip) => chip.label)).toEqual([
      'thinking.stepName.draft',
    ])
  })
})
