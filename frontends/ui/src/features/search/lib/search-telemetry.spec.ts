import { describe, expect, it, vi } from 'vitest'

import { SEARCH_FIXTURE_DOCUMENTS, SEARCH_FIXTURE_RESPONSE } from '@/app/dev/_fixtures/search'
import type { SearchResponse } from '@/lib/search/search-wire'
import { hitHref } from './search-hrefs'
import {
  findHitByHref,
  filterDimensions,
  parseServerTiming,
  refinements,
  savedSearchProperties,
  searchIssuedProperties,
  SearchTracker,
  type IssuedSearch,
} from './search-telemetry'

const WORDS = 'Fluchtweg GK 4'

const issued = (overrides: Partial<IssuedSearch> = {}): IssuedSearch => ({
  scope: {},
  body: { text: WORDS, kinds: ['document', 'annotation'], filters: { documentTypes: ['fire_safety_concept'], currentOnly: true, cites: [] } },
  response: SEARCH_FIXTURE_RESPONSE,
  durationMs: 123.4,
  serverTiming: { sqlMs: 40.2, contentMs: 70.7 },
  view: 'list',
  ...overrides,
})

/** A tracker on a fake clock: timers run when the spec says. */
function tracked() {
  const capture = vi.fn()
  let now = 0
  const timers = new Map<number, () => void>()
  let next = 0
  const tracker = new SearchTracker('page', {
    capture,
    now: () => now,
    setTimer: (run) => {
      timers.set(++next, run)
      return next
    },
    clearTimer: (timer) => timers.delete(timer as number),
  })
  return {
    tracker,
    capture,
    advance: (ms: number) => {
      now += ms
    },
    settle: () => [...timers.values()].forEach((run) => run()),
  }
}

describe('search_issued', () => {
  it('describes the question by its shape and the answer by counts, never the words or an id', () => {
    const properties = searchIssuedProperties('page', issued())
    const total = Object.values(SEARCH_FIXTURE_RESPONSE.sections).reduce((sum, section) => sum + (section?.total ?? 0), 0)
    expect(properties).toEqual({
      surface: 'page',
      scope: 'office',
      has_text: true,
      text_tokens: 3,
      kinds: 'annotation,document',
      filter_dims: 'currentOnly,documentTypes',
      view: 'list',
      results_total: total,
      zero_results: total === 0,
      content_partial: SEARCH_FIXTURE_RESPONSE.contentPartial,
      building: SEARCH_FIXTURE_RESPONSE.building.length,
      duration_ms: 123,
      sql_ms: 40,
      content_ms: 71,
    })
    const serialized = JSON.stringify(properties)
    expect(serialized).not.toContain('Fluchtweg')
    for (const hit of SEARCH_FIXTURE_DOCUMENTS) expect(serialized).not.toContain(hit.id)
  })

  it('says zero results, and every kind when none was picked', () => {
    const empty: SearchResponse = { ...SEARCH_FIXTURE_RESPONSE, sections: { document: { hits: [], total: 0, totalIsLowerBound: false, nextCursor: null } } }
    const properties = searchIssuedProperties('palette', issued({ body: {}, response: empty, serverTiming: { sqlMs: null, contentMs: null } }))
    expect(properties).toMatchObject({ has_text: false, text_tokens: 0, kinds: 'all', filter_dims: '', zero_results: true, sql_ms: null })
  })
})

describe('SearchTracker', () => {
  it('sends one search_issued per settled question, not one per pause in typing', () => {
    const { tracker, capture, settle } = tracked()
    tracker.answered(issued({ body: { text: 'Flucht' } }))
    tracker.answered(issued({ body: { text: 'Fluchtweg' } }))
    tracker.answered(issued())
    settle()
    expect(capture).toHaveBeenCalledTimes(1)
    expect(capture).toHaveBeenCalledWith('search_issued', expect.objectContaining({ text_tokens: 3 }))
  })

  it('sends a held question at once when a hit is opened from it, then the open with its time since the answer', () => {
    const { tracker, capture, advance } = tracked()
    tracker.answered(issued())
    advance(2500)
    const hit = SEARCH_FIXTURE_DOCUMENTS[0]
    tracker.opened(hit, 2)
    expect(capture.mock.calls.map(([event]) => event)).toEqual(['search_issued', 'search_result_opened'])
    expect(capture.mock.calls[1][1]).toEqual({
      surface: 'page',
      kind: 'document',
      rank: 2,
      matched_on: [...hit.matchedOn].sort().join(','),
      has_passage: hit.passage !== null,
      ms_since_issued: 2500,
    })
  })

  it('sends a held question when the surface goes away, and nothing twice', () => {
    const { tracker, capture } = tracked()
    tracker.answered(issued())
    tracker.flush()
    tracker.flush()
    expect(capture).toHaveBeenCalledTimes(1)
  })
})

describe('the helpers', () => {
  it('reads the route’s Server-Timing', () => {
    expect(parseServerTiming('sql;dur=12.3, content;dur=80.1, total;dur=92.4')).toEqual({ sqlMs: 12.3, contentMs: 80.1 })
    expect(parseServerTiming(null)).toEqual({ sqlMs: null, contentMs: null })
    expect(parseServerTiming('cdn-cache;desc=HIT')).toEqual({ sqlMs: null, contentMs: null })
  })

  it('names filter dimensions, and what a change added and removed', () => {
    expect(filterDimensions({ filters: { tags: ['Plan'], incompleteRead: false } }, { kinds: true, project: true })).toEqual(['kind', 'project', 'tags'])
    expect(refinements(['tags', 'kind'], ['tags', 'cites'])).toEqual([
      { change: 'added', dimension: 'cites' },
      { change: 'removed', dimension: 'kind' },
    ])
  })

  it('finds the hit a link points at, with its place in its section', () => {
    const hit = SEARCH_FIXTURE_DOCUMENTS[1]
    const sections = { document: { hits: SEARCH_FIXTURE_DOCUMENTS } }
    expect(findHitByHref(sections, hitHref(hit), hitHref)).toEqual({ hit, rank: 2 })
    expect(findHitByHref(sections, '/app/elsewhere', hitHref)).toBeNull()
  })

  it('describes a saved search by whether it is shared and its scope', () => {
    expect(savedSearchProperties({ shared: true, scope: { scope: 'office_shelf' } })).toEqual({ shared: true, scope: 'office_shelf' })
    expect(savedSearchProperties({ shared: false, scope: {} })).toEqual({ shared: false, scope: 'office' })
  })
})
