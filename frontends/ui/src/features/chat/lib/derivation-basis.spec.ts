import { describe, expect, test } from 'vitest'
import { createTranslator } from '@/i18n/translate'
import { en } from '@/i18n/dictionaries/en'
import { foldScene, mockupCitations, mockupScene } from '@/test-utils/work-list-scenes'
import { buildCitationModel, type CitedDocument } from './citations'
import { basisLines, cardForTarget, cardName, openPoints } from './derivation-basis'
import { workRounds } from './work-list'

describe('basisLines', () => {
  const t = createTranslator(en, 'chat')

  test('a line keeps its numbers apart from its text, so the card draws the marker', () => {
    const basis = basisLines(t, buildCitationModel({ citations: mockupCitations() }))
    expect(basis.law[0]).toEqual({
      numbers: [1],
      // The Punkt as the dictionary typesets it (a no-break space after „Sec.“).
      text: `OIB-Richtlinie 2, Ausgabe Mai 2023, ${t('thinking.node.basis.clause', { clause: '3.1.1' })}`,
    })
    expect(basis.evidence[0]).toEqual({
      numbers: [2],
      text: `Einreichplan EG, ${t('thinking.node.basis.page', { page: 2 })}`,
    })
    // No „[N]“ is baked into the text any more.
    for (const line of [...basis.law, ...basis.evidence]) expect(line.text).not.toMatch(/\[\d+\]/)
  })
})

describe('openPoints name a document as its card does', () => {
  const t = createTranslator(en, 'chat')
  const cards = buildCitationModel({ citations: mockupCitations() })
  const oib = cards.find((doc) => /oib-rl_2_ausgabe/i.test(doc.fileName ?? ''))!

  test('the call said „OIB-RL 2, Ausgabe 2023“; the open point says the card name and edition', () => {
    const open = openPoints(t, workRounds(foldScene(mockupScene())), cards)
    expect(open).toHaveLength(1)
    expect(open[0]).toContain(cardName(oib))
    expect(cardName(oib)).toBe('OIB-Richtlinie 2, Ausgabe Mai 2023')
    expect(open[0]).not.toMatch(/OIB.RL 2/)
  })

  test('without the citation model the call keeps its own words', () => {
    const open = openPoints(t, workRounds(foldScene(mockupScene())))
    expect(open[0]).toMatch(/OIB.RL 2, Ausgabe 2023/)
  })

  test('a card is found by its file name, by the path the call wrote, or by the Richtlinie it is', () => {
    const plan = cards.find((doc) => doc.fileName === 'Einreichplan EG.pdf')!
    expect(cardForTarget('Einreichplan EG.pdf', cards)).toBe(plan)
    expect(cardForTarget('03 Einreichung/Pläne/Einreichplan EG.pdf', cards)).toBe(plan)
    expect(cardForTarget('OIB-RL 2', cards)).toBe(oib)
    expect(cardForTarget('Statik.pdf', cards)).toBeUndefined()
  })

  test('a Richtlinie of another edition is another document, never renamed to the card', () => {
    expect(cardForTarget('OIB-RL 2, Ausgabe 2019', cards)).toBeUndefined()
    // The explanatory notes to the same Richtlinie are not the Richtlinie.
    const notesOnly: CitedDocument[] = cards.filter((doc) => doc !== oib)
    expect(cardForTarget('OIB-RL 2, Ausgabe 2023', notesOnly)).toBeUndefined()
  })
})
