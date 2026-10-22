import { describe, expect, test } from 'vitest'
import { createTranslator } from '@/i18n/translate'
import { en } from '@/i18n/dictionaries/en'
import { mockupCitations } from '@/test-utils/work-list-scenes'
import { buildCitationModel } from './citations'
import { basisLines } from './derivation-basis'

describe('basisLines', () => {
  const t = createTranslator(en, 'chat')

  test('a line keeps its numbers apart from its text, so the card draws the marker', () => {
    const basis = basisLines(t, buildCitationModel({ citations: mockupCitations() }))
    expect(basis.law[0]).toEqual({
      numbers: [1],
      text: 'OIB-Richtlinie 2, Ausgabe Mai 2023, Sec. 3.1.1',
    })
    expect(basis.evidence[0]).toEqual({ numbers: [2], text: 'Einreichplan EG, p. 2' })
    // No „[N]“ is baked into the text any more.
    for (const line of [...basis.law, ...basis.evidence]) expect(line.text).not.toMatch(/\[\d+\]/)
  })
})
