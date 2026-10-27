import { describe, expect, it } from 'vitest'

import { searchBodySchema } from '@/lib/search/search-wire'
import {
  activeFilterCount,
  EMPTY_SEARCH_STATE,
  fromSearchBody,
  hasSearchParams,
  parseFactParam,
  parsePartyParam,
  parseSearchParams,
  toSearchBody,
  withoutSearchParams,
  writeFactParam,
  writeSearchParams,
  withView,
  type SearchUrlState,
} from './search-url'

const PROJECT = '0b6f0c1e-3a55-4c0e-9a1d-7f2b5d0e1a01'

const EVERYTHING: SearchUrlState = {
  text: 'Fluchtweg GK 4',
  view: 'register',
  kinds: null,
  sort: 'plan_number',
  dir: 'asc',
  projectId: PROJECT,
  columns: ['planNumber', 'planIndex', 'title', 'folder', 'uploaded', 'pages'],
  filters: {
    documentTypes: ['submission_drawing', 'fire_safety_concept'],
    tags: ['Brandschutz'],
    planNumber: 'EP-0',
    planIndex: ['C', 'D'],
    planDate: { from: '2026-01-01', to: '2026-10-31' },
    scale: ['1:100'],
    currentOnly: true,
    parties: [{ role: 'architect' }, { role: 'authority', name: 'MA 37' }, { name: 'Huber' }],
    place: 'Wien',
    facts: [{ key: 'building_class', equals: 'GK 4' }, { key: 'gross_floor_area', min: 100.5, max: 2000 }, { key: 'escape_route_length', max: 40 }],
    cites: ['ÖNORM B 1600', 'plan:EP-05'],
    uploaded: { from: '2026-10-01' },
    uploadedBy: ['user_lena'],
    states: ['readable', 'reading'],
    incompleteRead: true,
    factsChanged: true,
    changedFacts: ['building_class', 'storeys_above_ground'],
    fileTypes: ['pdf', 'dwg'],
    pages: { min: 1, max: 40 },
    includeArchived: true,
  },
}

describe('the URL and the search state', () => {
  it('reads back every filter it writes', () => {
    const params = writeSearchParams(EVERYTHING)
    expect(parseSearchParams(params)).toEqual(EVERYTHING)
  })

  it('keeps the shelf’s own parameters and replaces only its own', () => {
    const base = new URLSearchParams('folder=f1&mode=search&q=alt&type=permit')
    const params = writeSearchParams({ ...EMPTY_SEARCH_STATE, text: 'neu' }, base)
    expect(params.get('folder')).toBe('f1')
    expect(params.get('mode')).toBe('search')
    expect(params.get('q')).toBe('neu')
    expect(params.getAll('type')).toEqual([])
  })

  it('writes nothing for the empty search, so the plain page is a plain URL', () => {
    expect(writeSearchParams(EMPTY_SEARCH_STATE).toString()).toBe('')
    expect(parseSearchParams(new URLSearchParams())).toEqual(EMPTY_SEARCH_STATE)
  })

  it('drops what a hand-edited link cannot name, instead of sending a body the route refuses', () => {
    const state = parseSearchParams(
      new URLSearchParams(
        'view=grid&sort=colour&dir=up&type=castle&tag=Unsinn&state=gone&ext=p.df&planFrom=gestern&fact=height=&fact=nonsense:1..2&party=wizard:&project=not-a-uuid&pagesMin=-3&kind=memo&changedFact=colour&changed=yes'
      )
    )
    expect(state).toEqual(EMPTY_SEARCH_STATE)
  })

  it('knows when a URL carries a search, and what leaving it keeps', () => {
    expect(hasSearchParams(new URLSearchParams('folder=f1'))).toBe(false)
    expect(hasSearchParams(new URLSearchParams('folder=f1&type=permit'))).toBe(true)
    expect(withoutSearchParams(new URLSearchParams('folder=f1&q=x&cites=EP-05')).toString()).toBe('folder=f1')
  })
})

describe('the register’s columns in the URL', () => {
  const register: SearchUrlState = { ...EMPTY_SEARCH_STATE, view: 'register', filters: { currentOnly: true } }

  it('writes nothing for the default columns, and reads the default back', () => {
    expect(writeSearchParams(register).has('cols')).toBe(false)
    expect(parseSearchParams(writeSearchParams(register)).columns).toBeNull()
  })

  it('round-trips a choice, in the register’s order whatever order the link names', () => {
    const chosen: SearchUrlState = { ...register, columns: ['planNumber', 'title', 'folder', 'pages'] }
    const params = writeSearchParams(chosen)
    expect(params.get('cols')).toBe('planNumber,title,folder,pages')
    expect(parseSearchParams(params)).toEqual(chosen)
    expect(parseSearchParams(new URLSearchParams('view=register&cols=pages,folder,planNumber')).columns).toEqual(['planNumber', 'title', 'folder', 'pages'])
  })

  it('keeps the title, drops what it cannot name, and reads a link naming the defaults as the default', () => {
    expect(parseSearchParams(new URLSearchParams('cols=planNumber,colour')).columns).toEqual(['planNumber', 'title'])
    expect(parseSearchParams(new URLSearchParams('cols=colour,,')).columns).toBeNull()
    const defaults = 'planNumber,planIndex,title,planDate,scale,documentType,author,project'
    expect(parseSearchParams(new URLSearchParams(`cols=${defaults}`)).columns).toBeNull()
  })

  it('is a search parameter: leaving search mode drops it', () => {
    expect(hasSearchParams(new URLSearchParams('cols=title'))).toBe(true)
    expect(withoutSearchParams(new URLSearchParams('folder=f1&cols=title')).toString()).toBe('folder=f1')
  })
})

describe('„Nur aktuelle Fassung“, each view’s own default', () => {
  it('is on in the register unless the link says current=0', () => {
    expect(parseSearchParams(new URLSearchParams('view=register')).filters.currentOnly).toBe(true)
    expect(parseSearchParams(new URLSearchParams('view=register&current=0')).filters.currentOnly).toBeUndefined()
    expect(writeSearchParams({ ...EMPTY_SEARCH_STATE, view: 'register', filters: { currentOnly: true } }).toString()).toBe('view=register')
    expect(writeSearchParams({ ...EMPTY_SEARCH_STATE, view: 'register' }).toString()).toBe('view=register&current=0')
  })

  it('is off in the list unless the link says current=1', () => {
    expect(parseSearchParams(new URLSearchParams('')).filters.currentOnly).toBeUndefined()
    expect(parseSearchParams(new URLSearchParams('current=1')).filters.currentOnly).toBe(true)
  })

  it('follows the new view’s default when the reader left it alone, and keeps a choice they made', () => {
    const list = EMPTY_SEARCH_STATE
    expect(withView(list, 'register').filters.currentOnly).toBe(true)
    expect(withView(withView(list, 'register'), 'list').filters.currentOnly).toBeUndefined()
    const listCurrent = { ...list, filters: { currentOnly: true } }
    expect(withView(listCurrent, 'register').filters.currentOnly).toBe(true)
    const registerAll = { ...list, view: 'register' as const }
    expect(withView(registerAll, 'list').filters.currentOnly).toBeUndefined()
  })
})

describe('the phone’s filter count', () => {
  it('leaves out „Nur aktuelle Fassung“ in the Planliste, where it is the switch above the table', () => {
    const filters: SearchUrlState['filters'] = { currentOnly: true, documentTypes: ['submission_drawing'] }
    expect(activeFilterCount({ ...EMPTY_SEARCH_STATE, view: 'register', filters })).toBe(1)
    expect(activeFilterCount({ ...EMPTY_SEARCH_STATE, view: 'list', filters })).toBe(2)
  })
})

describe('fact and party parameters', () => {
  it('reads equals and ranges, open at either end', () => {
    expect(parseFactParam('building_class=GK 4')).toEqual({ key: 'building_class', equals: 'GK 4' })
    expect(parseFactParam('floor_area_ratio:0.5..1.2')).toEqual({ key: 'floor_area_ratio', min: 0.5, max: 1.2 })
    expect(parseFactParam('escape_route_length:..40')).toEqual({ key: 'escape_route_length', max: 40 })
    expect(parseFactParam('units:12..')).toEqual({ key: 'units', min: 12 })
    expect(parseFactParam('units:..')).toBeNull()
    expect(writeFactParam({ key: 'units', min: 12 })).toBe('units:12..')
  })

  it('reads a role, a name or both', () => {
    expect(parsePartyParam('architect:')).toEqual({ role: 'architect' })
    expect(parsePartyParam(':Huber')).toEqual({ name: 'Huber' })
    expect(parsePartyParam('authority:MA 37: Baupolizei')).toEqual({ role: 'authority', name: 'MA 37: Baupolizei' })
    expect(parsePartyParam(':')).toBeNull()
  })
})

describe('the body a search state asks', () => {
  it('is a body the route’s own schema accepts', () => {
    const body = toSearchBody(EVERYTHING, { limit: 100, facets: true })
    expect(searchBodySchema.safeParse(body).success).toBe(true)
  })

  it('asks the register for documents alone, in its column order', () => {
    expect(toSearchBody({ ...EMPTY_SEARCH_STATE, view: 'register', sort: 'plan_number', dir: 'asc' })).toEqual({
      kinds: ['document'],
      sort: 'plan_number',
      dir: 'asc',
    })
  })

  it('asks the register by Plannummer when no column is chosen, and by relevance with words', () => {
    expect(toSearchBody({ ...EMPTY_SEARCH_STATE, view: 'register' })).toEqual({ kinds: ['document'], sort: 'plan_number', dir: 'asc' })
    expect(toSearchBody({ ...EMPTY_SEARCH_STATE, view: 'register', text: 'Schnitt' })).toEqual({ text: 'Schnitt', kinds: ['document'] })
  })

  it('never asks for relevance without words to be relevant to', () => {
    expect(toSearchBody({ ...EMPTY_SEARCH_STATE, sort: 'relevance', dir: 'desc' })).toEqual({})
    expect(toSearchBody({ ...EMPTY_SEARCH_STATE, text: ' Statik ', sort: 'relevance' })).toEqual({ text: 'Statik', sort: 'relevance' })
  })

  it('asks a section’s next page for that kind alone', () => {
    const body = toSearchBody({ ...EMPTY_SEARCH_STATE, text: 'EP-03' }, { kinds: ['annotation'], cursor: 'c2', facets: false })
    expect(body).toEqual({ text: 'EP-03', kinds: ['annotation'], cursor: 'c2', facets: false })
  })

  it('comes back from a saved question as the search it was', () => {
    const register = { ...EMPTY_SEARCH_STATE, view: 'register' as const, sort: 'plan_number' as const, dir: 'asc' as const, filters: { currentOnly: true } }
    expect(fromSearchBody(toSearchBody(register))).toEqual(register)
    const list = { ...EMPTY_SEARCH_STATE, text: 'Statik', kinds: ['document' as const] }
    expect(fromSearchBody(toSearchBody(list))).toEqual(list)
    expect(fromSearchBody({ text: 'x' }, PROJECT).projectId).toBe(PROJECT)
  })
})
