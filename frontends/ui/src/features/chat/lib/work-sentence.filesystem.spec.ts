/**
 * The Herleitung rows of Piloti's filesystem verbs (ADR-0132 × ADR-0133), as an
 * architect reads them: a place and its folder, never a path; a folder Piloti
 * opens, a literal search that says where and how, a name search in words, a
 * read that says which pages; every count counts files; a search that could not
 * search everything says so; a folder or file that is not there is „nicht
 * gefunden“ (the same for a restricted one), and one that is there and empty is
 * „leer“.
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
import { foldRows, workRounds, type WorkRound, type WorkRow } from './work-list'
import { namePattern, regexWords, settledHead, workParts, workPartsText } from './work-sentence'

const t = createTranslator(de, 'chat')
const tEn = createTranslator(en, 'chat')
const NB = ' '

const sentence = (action: StoredAction, translator = t) =>
  workPartsText(workParts(translator, action))

/** „Offen“ of a turn of this one settled call. */
const open = (action: StoredAction): string[] => {
  const row: WorkRow = { id: 'r', running: false, callIds: ['r'], looks: [], action }
  const round: WorkRound = { round: 1, rows: [row], more: [], strayLooks: [], running: false }
  return openPoints(t, [round])
}

describe('a filesystem row names a place, never a path', () => {
  test('Piloti opens a folder, by its breadcrumb, with what the folder holds', () => {
    expect(
      sentence({
        verb: 'list',
        status: 'ok',
        mount: 'project',
        target: '03 Einreichung',
        counts: { files: 12, folders: 2 },
      })
    ).toBe(`Öffnet 03 Einreichung: 12${NB}Dateien, 2${NB}Ordner`)
    expect(
      sentence({ verb: 'list', status: 'ok', mount: 'project', counts: { files: 7, folders: 4 } })
    ).toBe(`Öffnet das Projekt: 7${NB}Dateien, 4${NB}Ordner`)
  })

  test('the places themselves are counted as places, in files', () => {
    expect(
      sentence({ verb: 'list', status: 'ok', mount: 'estate', counts: { files: 41, folders: 3 } })
    ).toBe(`Öffnet alle Ablagen: 3${NB}Ablagen, 41${NB}Dateien`)
  })

  test('a folder outside the project is named under its place, with its article', () => {
    expect(
      sentence({
        verb: 'list',
        status: 'ok',
        mount: 'office',
        target: 'Vorlagen/Bescheide',
        counts: { files: 3, folders: 0 },
      })
    ).toBe(`Öffnet die Büroablage ›${NB}Vorlagen › Bescheide: 3${NB}Dateien`)
    expect(
      sentence({ verb: 'search', mode: 'exact', status: 'ok', query: 'x', mount: 'office', target: 'Vorlagen' })
    ).toBe(`Durchsucht die Büroablage ›${NB}Vorlagen wörtlich nach „x“`)
    expect(
      sentence({ verb: 'list', status: 'ok', query: '*.pdf', mount: 'chat', target: 'Pläne' })
    ).toBe(`Sucht im Chat ›${NB}Pläne nach PDF-Dateien`)
    expect(sentence({ verb: 'list', status: 'ok', mount: 'law' })).toBe('Öffnet die OIB-Richtlinien')
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
      `Durchsucht 03 Einreichung wörtlich nach „Brandabschnitt“: 14${NB}Treffer in 3${NB}Dateien`
    )
    expect(
      sentence({ verb: 'search', mode: 'regex', status: 'ok', query: 'EI\\s?90', mount: 'estate' })
    ).toBe('Durchsucht alle Ablagen nach dem Muster „EI\\s?90“')
  })

  test('a regex of plain words reads as the words, a real pattern as the pattern', () => {
    expect(regexWords('EI 90|REI 90')).toEqual(['EI 90', 'REI 90'])
    expect(regexWords('Fluchtweg')).toEqual(['Fluchtweg'])
    expect(regexWords('EI\\s?90')).toBeNull()
    expect(regexWords('Brand.*abschnitt')).toBeNull()
    const words = { verb: 'search', mode: 'regex', status: 'ok', mount: 'project' } as const
    expect(sentence({ ...words, query: 'EI 90|REI 90|EI 60' })).toBe(
      'Durchsucht das Projekt wörtlich nach „EI 90“, „REI 90“ oder „EI 60“'
    )
    expect(sentence({ ...words, query: 'Fluchtweg' })).toBe(
      'Durchsucht das Projekt wörtlich nach „Fluchtweg“'
    )
  })

  test('a search by file name says what it looks for in words where the pattern is simple', () => {
    expect(namePattern(t, '*.pdf')).toBe('PDF-Dateien')
    expect(namePattern(t, '**/*.dwg')).toBe('DWG-Dateien')
    expect(namePattern(t, '*Brandschutz*')).toBe('Dateien mit „Brandschutz“ im Namen')
    expect(namePattern(t, '**/*Plan*.pdf')).toBe('PDF-Dateien mit „Plan“ im Namen')
    expect(namePattern(t, 'EP-0?_*.pdf')).toBe('Dateien „EP-0?_*.pdf“')
    expect(
      sentence({ verb: 'list', status: 'ok', query: '*.pdf', mount: 'project', counts: { files: 7 } })
    ).toBe(`Sucht im Projekt nach PDF-Dateien: 7${NB}Dateien`)
    expect(
      sentence({ verb: 'list', status: 'empty', query: '*.dwg', mount: 'estate', counts: { files: 0 } })
    ).toBe('Sucht in allen Ablagen nach DWG-Dateien: keine Datei')
  })

  test('no row draws a mount word, a slash or a raw .md path', () => {
    const rows = [...workRounds(foldScene(filesystemScene())), ...workRounds(foldScene(filesystemEdgesScene()))]
      .flatMap((round) => [...round.rows, ...round.more])
      .map((row) => workPartsText(workParts(t, row.action)))
    for (const row of rows) {
      // What was looked for is the model's own words (a pattern may hold a slash); the rest is ours.
      expect(row.replace(/„[^“]*“/g, '„…“')).not.toMatch(
        /\/|\.md\b|\bproject\b|\boffice\b|\blaw\b|\bestate\b| : |Listet/
      )
    }
  })

  test('a path that names no place gives a row with no folder at all', () => {
    expect(sentence({ verb: 'list', status: 'error' })).toBe(
      'Öffnet einen Ordner: fehlgeschlagen'
    )
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
    ).toBe(`Searches every place for the exact words “Fluchtweg”: 3${NB}hits in 1${NB}file`)
    expect(sentence({ verb: 'list', status: 'ok', query: '*.pdf', mount: 'project' }, tEn)).toBe(
      'Looks for PDF files in the project'
    )
    expect(sentence({ verb: 'list', status: 'ok', mount: 'office', target: 'Vorlagen' }, tEn)).toBe(
      `Lists the office filing ›${NB}Vorlagen`
    )
  })
})

describe('what a filesystem call found, or did not', () => {
  test('a literal search without a hit says how many files it searched', () => {
    expect(
      workParts(t, {
        verb: 'search',
        mode: 'exact',
        status: 'empty',
        query: 'Sprinkler',
        mount: 'estate',
        counts: { hits: 0, documents: 0, searched: 41 },
      })
    ).toMatchObject({ result: `kein Treffer in 41${NB}Dateien`, tone: 'empty' })
  })

  test('an incomplete search is never drawn as complete: its hits are a floor, its no is no no', () => {
    const found = workParts(t, {
      verb: 'search',
      mode: 'exact',
      status: 'ok',
      query: 'Brandabschnitt',
      mount: 'estate',
      incomplete: true,
      counts: { hits: 3, documents: 1, searched: 32 },
    })
    expect(found).toMatchObject({
      result: `3${NB}Treffer in 1${NB}Datei`,
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
      result: `kein Treffer in 9${NB}Dateien`,
      tone: 'incomplete',
      note: 'nicht alles durchsucht – das ist kein Nein',
    })
    // A screen reader hears what the dashed shape means.
    expect(workPartsText(none)).toContain('das ist kein Nein')
    // Without a count there is only the word.
    expect(
      workParts(t, { verb: 'search', mode: 'exact', status: 'ok', query: 'x', mount: 'estate', incomplete: true })
        .result
    ).toBe('unvollständig')
  })

  test('a folder or file that is not there is „nicht gefunden“, by the name asked for', () => {
    expect(
      workParts(t, { verb: 'list', status: 'empty', missing: true, mount: 'project', target: 'Personal' })
    ).toMatchObject({ verb: 'Öffnet', object: 'Personal', result: 'nicht gefunden', tone: 'empty' })
    expect(
      workParts(t, { verb: 'read', status: 'empty', missing: true, target: 'Vertrag.pdf' })
    ).toMatchObject({ verb: 'Liest', object: 'Vertrag.pdf', result: 'nicht gefunden' })
  })

  test('an empty project and a chat without uploads are there: „leer“, never „nicht gefunden“', () => {
    const empty = { verb: 'list', status: 'ok', counts: { files: 0, folders: 0 } } as const
    expect(sentence({ ...empty, mount: 'project' })).toBe('Öffnet das Projekt: leer')
    expect(sentence({ ...empty, mount: 'chat' })).toBe('Öffnet die Dateien dieses Chats: leer')
    expect(open({ ...empty, mount: 'project' })).toEqual([])
    expect(open({ ...empty, mount: 'chat' })).toEqual([])
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
    expect(
      settledHead(t, { verb: 'list', status: 'ok', mount: 'project', target: '03 Einreichung' })
    ).toBe('Geöffnet: 03 Einreichung')
    expect(settledHead(t, { verb: 'list', status: 'ok', query: '*.pdf', mount: 'project' })).toBe(
      'Gesucht: im Projekt nach PDF-Dateien'
    )
  })
})

describe('„Offen“ for the filesystem', () => {
  test('an incomplete no, a literal no, a pattern no and a miss each say what they are', () => {
    const points = openPoints(t, workRounds(foldScene(filesystemEdgesScene())))
    expect(points).toContain(
      'Nicht beurteilbar, weil die wörtliche Suche in allen Ablagen nach „Sprinkler“ keine Fundstelle ergab.'
    )
    expect(points).toContain(
      `Nicht beurteilbar, weil die Suche in der Büroablage ›${NB}Vorlagen nach dem Muster „EI\\s?90“ nicht alles durchsuchen konnte.`
    )
    expect(points).toContain('Nicht beurteilbar, weil der Ordner „Personal“ nicht gefunden wurde.')
    expect(points).toContain('Nicht beurteilbar, weil die Datei „Vertrag.pdf“ nicht gefunden wurde.')
    expect(points).toContain('Nicht beurteilbar, weil im Projekt keine DWG-Dateien gefunden wurden.')
    expect(points.join(' ')).not.toMatch(/fehlgeschlagen|Dateien dieses Chats/)
  })

  test('a regex without a hit is no „wörtliche Suche“', () => {
    expect(
      open({
        verb: 'search',
        mode: 'regex',
        status: 'empty',
        query: 'EI\\s?90',
        mount: 'project',
        target: '03 Einreichung',
      })
    ).toEqual([
      'Nicht beurteilbar, weil die Suche in 03 Einreichung nach dem Muster „EI\\s?90“ keine Fundstelle ergab.',
    ])
  })

  test('a missing folder of the Büroablage is named as one, without an article inside the quotes', () => {
    expect(
      open({ verb: 'list', status: 'empty', missing: true, mount: 'office', target: 'Vorlagen/Alt' })
    ).toEqual([
      `Nicht beurteilbar, weil der Ordner „Büroablage ›${NB}Vorlagen › Alt“ nicht gefunden wurde.`,
    ])
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
    // A knowledge_search folder and a name without a slash: untouched.
    expect(legacyPlace({ verb: 'search', status: 'ok', target: '03 Einreichung/Pläne' })).toBeNull()
    expect(legacyPlace({ verb: 'read', status: 'ok', target: 'Plan.pdf' })).toBeNull()
  })

  test('a read names its file, and a folder card is the listing of its folder', () => {
    expect(legacyPlace({ verb: 'read', status: 'ok', target: '/project/Pläne/EG.pdf.md' })).toEqual({
      target: 'EG.pdf',
    })
    expect(
      legacyPlace({ verb: 'read', status: 'ok', target: '/project/03 Einreichung/README.md' })
    ).toEqual({ verb: 'list', mount: 'project', target: '03 Einreichung' })
  })

  test('a reload draws it as the wire draws it now', () => {
    const [listing, card] = sanitizeThinkingSteps([
      {
        id: 'action:old',
        userMessageId: 'm',
        timestamp: '2026-10-26T10:00:00Z',
        isComplete: true,
        kind: 'action',
        action: { verb: 'list', status: 'ok', target: '/project/03 Einreichung/', counts: { files: 2, folders: 0 } },
      },
      {
        id: 'action:card',
        userMessageId: 'm',
        timestamp: '2026-10-26T10:00:01Z',
        isComplete: true,
        kind: 'action',
        action: { verb: 'read', status: 'ok', target: '/office/Vorlagen/README.md' },
      },
    ])!
    expect(sentence(listing.action!)).toBe(`Öffnet 03 Einreichung: 2${NB}Dateien`)
    expect(sentence(card.action!)).toBe(`Öffnet die Büroablage ›${NB}Vorlagen`)
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
