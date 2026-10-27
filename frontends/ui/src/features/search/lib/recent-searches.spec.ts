import { beforeEach, describe, expect, it, vi } from 'vitest'

import { RECENT_SEARCHES_KEY, RECENT_SEARCHES_MAX, readRecentSearches, rememberSearch, withRecentSearch } from './recent-searches'

describe('recent searches', () => {
  beforeEach(() => window.localStorage.removeItem(RECENT_SEARCHES_KEY))

  it('puts the latest first, once, and keeps five', () => {
    expect(withRecentSearch(['EP-03', 'Fluchtweg'], ' fluchtweg ')).toEqual(['fluchtweg', 'EP-03'])
    expect(withRecentSearch(['a'], '   ')).toEqual(['a'])
    const many = ['1', '2', '3', '4', '5']
    expect(withRecentSearch(many, '6')).toHaveLength(RECENT_SEARCHES_MAX)
  })

  it('remembers across reads and survives storage that is broken or blocked', () => {
    rememberSearch('EP-05')
    expect(readRecentSearches()).toEqual(['EP-05'])
    window.localStorage.setItem(RECENT_SEARCHES_KEY, '{not json')
    expect(readRecentSearches()).toEqual([])
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(rememberSearch('x')).toEqual(['x'])
    setItem.mockRestore()
  })
})
