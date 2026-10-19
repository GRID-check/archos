import { afterEach, describe, expect, test } from 'vitest'
import { backLandsOn, previousEntryIs } from './history-step'

const ORIGIN = 'https://app.example'
const at = (...paths: string[]) => paths.map((path) => ({ url: `${ORIGIN}${path}` }))

describe('previousEntryIs', () => {
  const FILES = '/app/projects/p1/files'
  const REVIEW = `${FILES}?doc=d1&review=1&mark=a1&back=${encodeURIComponent('/app/inbox?filter=unread')}`

  test('Dateien → Postfach → a row in the same project: the entry behind the review is the Postfach', () => {
    // The trail cut itself back to Dateien here (same path); the history did not.
    const entries = at(FILES, '/app/inbox?filter=unread', REVIEW)
    expect(previousEntryIs(entries, 2, '/app/inbox?filter=unread', ORIGIN)).toBe(true)
  })

  test('Dateien → Offene Punkte → a row: the entry behind is Offene Punkte with its filters', () => {
    const openPoints = `${FILES}/open-points?assignee=me&status=open`
    const entries = at(FILES, openPoints, `${FILES}?doc=d1&review=1&back=${encodeURIComponent(openPoints)}`)
    expect(previousEntryIs(entries, 2, openPoints, ORIGIN)).toBe(true)
  })

  test('Postfach → review → „Übernommen aus …“: the entry behind the second review is the first, not the Postfach', () => {
    const second = `${FILES}?doc=d2&review=1&mark=b1&back=${encodeURIComponent('/app/inbox?filter=unread')}`
    const entries = at('/app/inbox?filter=unread', REVIEW, second)
    expect(previousEntryIs(entries, 2, '/app/inbox?filter=unread', ORIGIN)).toBe(false)
  })

  test('the same filters in another order, or a hash, are the same page', () => {
    const entries = at('/app/inbox?status=open&filter=unread#row', FILES)
    expect(previousEntryIs(entries, 1, '/app/inbox?filter=unread&status=open', ORIGIN)).toBe(true)
  })

  test('another query on the same path is another page', () => {
    expect(previousEntryIs(at('/app/inbox?filter=all', FILES), 1, '/app/inbox?filter=unread', ORIGIN)).toBe(false)
    expect(previousEntryIs(at('/app/inbox', FILES), 1, '/app/inbox?filter=unread', ORIGIN)).toBe(false)
  })

  test('is false on the first entry, for a withheld URL and for another origin', () => {
    expect(previousEntryIs(at(FILES), 0, '/app/inbox', ORIGIN)).toBe(false)
    expect(previousEntryIs([{ url: null }, ...at(FILES)], 1, '/app/inbox', ORIGIN)).toBe(false)
    expect(previousEntryIs([{ url: 'https://other.example/app/inbox' }, ...at(FILES)], 1, '/app/inbox', ORIGIN)).toBe(false)
  })
})

describe('backLandsOn', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'navigation')
  })

  test('is false without the Navigation API (an older browser, this test runner)', () => {
    expect('navigation' in window).toBe(false)
    expect(backLandsOn('/app/inbox')).toBe(false)
  })

  test('reads the tab’s entries and the current index off window.navigation', () => {
    const origin = window.location.origin
    Object.defineProperty(window, 'navigation', {
      configurable: true,
      value: {
        entries: () => [{ url: `${origin}/app/inbox?filter=unread` }, { url: `${origin}/app/projects/p1/files` }],
        currentEntry: { index: 1 },
      },
    })
    expect(backLandsOn('/app/inbox?filter=unread')).toBe(true)
    expect(backLandsOn('/app/inbox')).toBe(false)
  })
})
