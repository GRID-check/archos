import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SEARCH_FIXTURE_DOCUMENTS } from '@/app/dev/_fixtures/search'
import { hitHref } from '../lib/search-hrefs'
import { SearchTracker } from '../lib/search-telemetry'
import { useOpenedHitCapture } from './use-search-tracker'

const sections = { document: { hits: SEARCH_FIXTURE_DOCUMENTS } }

function mount() {
  const tracker = new SearchTracker('page', { capture: vi.fn() })
  const opened = vi.spyOn(tracker, 'opened')
  renderHook(() => useOpenedHitCapture(tracker, sections))
  return opened
}

/** A row as the list draws it: an option with an id, the hit's link inside. */
function row(id: string, href: string): HTMLAnchorElement {
  const option = document.createElement('div')
  option.id = id
  const link = document.createElement('a')
  link.setAttribute('href', href)
  link.addEventListener('click', (event) => event.preventDefault())
  option.append(link)
  document.body.append(option)
  return link
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('useOpenedHitCapture', () => {
  it('reports a click on a hit’s link with the hit and its place', () => {
    const opened = mount()
    const hit = SEARCH_FIXTURE_DOCUMENTS[2]
    row('opt-3', hitHref(hit)).click()
    expect(opened).toHaveBeenCalledWith(hit, 3)
  })

  it('reports Enter in the field on the row its active descendant names', () => {
    const opened = mount()
    const hit = SEARCH_FIXTURE_DOCUMENTS[0]
    row('opt-1', hitHref(hit))
    const field = document.createElement('input')
    field.setAttribute('aria-activedescendant', 'opt-1')
    document.body.append(field)
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(opened).toHaveBeenCalledWith(hit, 1)
  })

  it('ignores links that are no hit of the answer', () => {
    const opened = mount()
    row('elsewhere', '/app/projects').click()
    expect(opened).not.toHaveBeenCalled()
  })
})
