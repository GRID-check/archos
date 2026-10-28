/**
 * @vitest-environment node
 */
/**
 * The answer an outside agent reads (ADR-0124): plain Markdown. Pinned with the
 * shapes live QA found raw in `agent-ask-get` (2026-10-27): the `:::check` and
 * `:::actions` fences, the verifier's German labels, a card marker, and a
 * `:project[…]` binding.
 */

import { describe, expect, it } from 'vitest'
import { answerTextForAgent, VERIFICATION_MARKERS } from './answer-text'

const STORED = [
  'Ob ein zweiter Fluchtweg nötig ist, hängt von der Treppenhausausführung ab.',
  '',
  ':::check',
  '| Anforderung | Ist | Soll | Status | Fundstelle |',
  '|---|---|---|---|---|',
  '| Wände | nicht vorliegend | REI 90 und A2 | offen | [2] |',
  ':::',
  '',
  '[[card:1]]',
  '',
  'Nicht gelesen habe ich „mach-tiefenrecherche.docx“ [nicht wörtlich in der Quelle belegt].',
  'Wien erklärt die Ausgabe für verbindlich [Beleg nicht verifiziert].',
  '',
  'Das Projekt liegt in Gebäudeklasse :project[building_class].',
  '',
  ':::actions',
  '| Wer | Was | bis | Fundstelle |',
  '|---|---|---|---|',
  '| Planverfasser | Grundrisse aller Geschoße | — | [1] |',
  ':::',
].join('\n')

describe('answerTextForAgent', () => {
  it('leaves no directive fence, card marker or binding syntax', () => {
    const text = answerTextForAgent(STORED, { projectValue: () => 'GK 5' })

    expect(text).not.toMatch(/^:{3,}/m)
    expect(text).not.toContain('[[card:')
    expect(text).not.toContain(':project[')
    expect(text).toContain('Gebäudeklasse GK 5.')
  })

  it('keeps the tables the fences wrapped', () => {
    const text = answerTextForAgent(STORED)

    expect(text).toContain('| Wände | nicht vorliegend | REI 90 und A2 | offen | [2] |')
    expect(text).toContain('| Planverfasser | Grundrisse aller Geschoße | — | [1] |')
  })

  it('says in English where a quote or a citation was not verified', () => {
    const text = answerTextForAgent(STORED)

    for (const [marker, plain] of Object.entries(VERIFICATION_MARKERS)) {
      expect(text).not.toContain(marker)
      expect(text).toContain(plain)
    }
  })

  it('prints a binding the profile lacks as its key, never an invented value', () => {
    expect(answerTextForAgent('Klasse :project[building_class].', { projectValue: () => null })).toBe(
      'Klasse building_class.'
    )
  })

  it('returns plain prose unchanged', () => {
    expect(answerTextForAgent('Das Vorhaben ist ein Zubau [1].')).toBe('Das Vorhaben ist ein Zubau [1].')
  })
})
