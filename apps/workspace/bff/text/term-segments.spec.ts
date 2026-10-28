/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'

import { stemOf, termSegments } from './term-segments'

describe('termSegments', () => {
  it('cuts the text where each word of the query occurs, any case', () => {
    expect(termSegments('Die Fluchtweglänge beträgt max. 40 m (GK 4)', 'fluchtweg gk 4')).toEqual([
      { text: 'Die ', match: false },
      { text: 'Fluchtweg', match: true },
      { text: 'länge beträgt max. 40 m (', match: false },
      { text: 'GK', match: true },
      { text: ' 4)', match: false },
    ])
  })

  it('joins back to the text, and lets the longer word win', () => {
    const text = 'ÖNORM B 1600 und ÖNORM B 1600-1'
    const segments = termSegments(text, 'ÖN ÖNORM')
    expect(segments.map((segment) => segment.text).join('')).toBe(text)
    expect(segments.filter((segment) => segment.match).map((segment) => segment.text)).toEqual(['ÖNORM', 'ÖNORM'])
  })

  it('takes a regular-expression character as itself', () => {
    expect(termSegments('Pkt. 5.1.1 (a)', '(a) 5.1')).toEqual([
      { text: 'Pkt. ', match: false },
      { text: '5.1', match: true },
      { text: '.1 ', match: false },
      { text: '(a)', match: true },
    ])
  })

  it('leaves the text whole without words to find', () => {
    expect(termSegments('S. 7', '')).toEqual([{ text: 'S. 7', match: false }])
    expect(termSegments('', 'x')).toEqual([])
  })

  it('sets apart only the matched part of a compound, with nothing between it and the rest of the word', () => {
    const segments = termSegments('Fluchtwege im Dachgeschoss', 'Fluchtweg')
    expect(segments).toEqual([
      { text: 'Fluchtweg', match: true },
      { text: 'e im Dachgeschoss', match: false },
    ])
  })

  it('makes one segment of two words that meet inside a compound', () => {
    expect(termSegments('Das Brandschutzkonzept', 'brand schutz')).toEqual([
      { text: 'Das ', match: false },
      { text: 'Brandschutz', match: true },
      { text: 'konzept', match: false },
    ])
  })

  it('finds an inflected word by its stem, as the content search does, and prefers the whole word', () => {
    expect(termSegments('Der Fluchtweg ist 38 m lang', 'Fluchtwege')).toEqual([
      { text: 'Der ', match: false },
      { text: 'Fluchtweg', match: true },
      { text: ' ist 38 m lang', match: false },
    ])
    expect(termSegments('Fluchtwege', 'Fluchtwege')).toEqual([{ text: 'Fluchtwege', match: true }])
  })

  it('reads across a soft hyphen a PDF left inside a word', () => {
    const segments = termSegments('Flucht­weglänge', 'Fluchtweg')
    expect(segments).toEqual([
      { text: 'Flucht­weg', match: true },
      { text: 'länge', match: false },
    ])
  })

  it('takes a decomposed umlaut as the same letter, and joins back to the text in NFC', () => {
    const decomposed = 'Türen und Fenster'
    const segments = termSegments(decomposed, 'Türen')
    expect(segments[0]).toEqual({ text: 'Türen', match: true })
    expect(segments.map((segment) => segment.text).join('')).toBe(decomposed.normalize('NFC'))
  })
})

describe('stemOf', () => {
  it('takes one inflection ending off, and leaves a short word whole', () => {
    expect(stemOf('Fluchtwege')).toBe('Fluchtweg')
    expect(stemOf('Geschossen')).toBe('Geschoss')
    expect(stemOf('Haus')).toBe(null)
    expect(stemOf('Fluchtweg')).toBe(null)
  })
})
