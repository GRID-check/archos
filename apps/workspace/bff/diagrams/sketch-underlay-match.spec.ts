/**
 * A Skizze's page is found again in the newer Fassung by a label that names one
 * page, chosen by the person when the label names two, and by its number, said
 * so, when the label is gone (S6, finding 7 of the review).
 */

import { describe, expect, it } from 'vitest'
import { matchUnderlayPage } from './sketch-underlay-match'

const of = (labels: (string | null)[], pageCount = labels.length) => ({ labels, pageCount })

describe('matchUnderlayPage', () => {
  it('follows a label that names one page', () => {
    expect(matchUnderlayPage(of(['A-100', 'A-101']), of(['A-099', 'A-100', 'A-101']), 2)).toEqual({ kind: 'page', page: 3, matchedBy: 'label', labelGone: false })
  })

  it('asks the person when the label names two pages of the newer Fassung', () => {
    expect(matchUnderlayPage(of(['A-100', 'A-101']), of(['A-101', 'A-100', 'A-101']), 2)).toEqual({ kind: 'ambiguous', label: 'A-101', pages: [1, 3] })
  })

  it('takes the page number and says the label is gone', () => {
    expect(matchUnderlayPage(of(['A-100', 'A-101']), of(['B-1', 'B-2']), 2)).toEqual({ kind: 'page', page: 2, matchedBy: 'index', labelGone: true })
  })

  it('takes the page number for a PDF without labels', () => {
    expect(matchUnderlayPage(of([null, null]), of([null, null, null]), 2)).toEqual({ kind: 'page', page: 2, matchedBy: 'index', labelGone: false })
  })

  it('finds a page past the backend’s label list by its number, and says a page past the end is gone', () => {
    expect(matchUnderlayPage(of([], 2500), of([], 2600), 2100)).toEqual({ kind: 'page', page: 2100, matchedBy: 'index', labelGone: false })
    expect(matchUnderlayPage(of([], 2500), of([], 2000), 2100)).toEqual({ kind: 'gone', pageCount: 2000 })
  })

  it('keeps the page the person chose, when the newer Fassung has it', () => {
    expect(matchUnderlayPage(of(['A-101']), of(['A-101', 'A-101']), 1, 2)).toEqual({ kind: 'page', page: 2, matchedBy: 'chosen', labelGone: false })
    expect(matchUnderlayPage(of(['A-101']), of(['A-101', 'A-101']), 1, 3)).toEqual({ kind: 'gone', pageCount: 2 })
  })
})
