import { describe, expect, it } from 'vitest'

import { termSegments } from './term-segments'

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
})
