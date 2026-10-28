/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'

import { fitColumns, headerRem, minimumRem, NAME_MIN_REM, valuesRem, withoutLegalForm, type ColumnFit } from './register-fit'

describe('fitColumns', () => {
  const name: ColumnFit = { min: 4, want: 14, rest: true }

  it('serves the name first, then each column up to its longest value, and leaves the rest to the name', () => {
    const author: ColumnFit = { min: 6, want: 11 }
    const project: ColumnFit = { min: 5, want: 15 }
    // 40 rem: minimums 12 + 6 + 5 = 23; the name to 14 (+2), the author to 11 (+5), the project to 15 (+10).
    expect(fitColumns([name, author, project], 40)).toEqual([null, 11, 15])
  })

  it('gives a column no more than its values need, so the name keeps the slack', () => {
    const index: ColumnFit = { min: 4.5, want: 2 }
    expect(fitColumns([name, index], 60)).toEqual([null, 4.5])
  })

  it('shares what is left in reading order when not every want fits', () => {
    const author: ColumnFit = { min: 6, want: 11 }
    const project: ColumnFit = { min: 5, want: 15 }
    // 30 rem: 23 of minimums, 2 to the name, the remaining 5 to the author.
    expect(fitColumns([name, author, project], 30)).toEqual([null, 11, 5])
  })

  it('holds every column at its minimum when even those do not fit, and the caller scrolls', () => {
    const columns: ColumnFit[] = [name, { min: 6, want: 11 }]
    expect(fitColumns(columns, 10)).toEqual([null, 6])
    expect(minimumRem(columns)).toBe(NAME_MIN_REM + 6)
  })
})

describe('the estimates', () => {
  it('sizes a header for its word and its sort arrow', () => {
    expect(headerRem('Plannummer')).toBeGreaterThan(headerRem('Index'))
  })

  it('wants nothing for a column with no value on the page', () => {
    expect(valuesRem([null, '', undefined], 'text')).toBe(0)
  })

  it('wants more for a where-chip than for the same words as text', () => {
    expect(valuesRem(['Wohnhaus Seestadt'], 'mark')).toBeGreaterThan(valuesRem(['Wohnhaus Seestadt'], 'text'))
  })
})

describe('withoutLegalForm', () => {
  it.each([
    ['Atelier Lindner ZT GmbH', 'Atelier Lindner'],
    ['Haas Tragwerksplanung ZT-GmbH', 'Haas Tragwerksplanung'],
    ['Bau Holding GmbH & Co KG', 'Bau Holding'],
    ['Huber AG', 'Huber'],
    ['Maria Gruber', 'Maria Gruber'],
    ['GmbH', 'GmbH'],
  ])('%s reads as %s', (name, short) => {
    expect(withoutLegalForm(name)).toBe(short)
  })
})
