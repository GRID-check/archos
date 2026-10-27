'use client'

import { useCallback, useEffect, useState } from 'react'

import {
  createSavedSearch,
  deleteSavedSearch,
  listSavedSearches,
  updateSavedSearch,
  type SavedSearchDraft,
  type SavedSearchView,
} from '@/lib/search/saved-search-client'

export interface SavedSearches {
  items: SavedSearchView[] | null
  failed: boolean
  save: (draft: SavedSearchDraft) => Promise<SavedSearchView | null>
  toggleShare: (item: SavedSearchView) => Promise<boolean>
  remove: (item: SavedSearchView) => Promise<boolean>
}

/** The reader's saved searches, read once, and the changes to them written through and reflected. */
export function useSavedSearches(): SavedSearches {
  const [items, setItems] = useState<SavedSearchView[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    listSavedSearches()
      .then((list) => {
        if (!cancelled) setItems(list)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const save = useCallback(async (draft: SavedSearchDraft) => {
    try {
      const created = await createSavedSearch(draft)
      setItems((list) => [created, ...(list ?? [])])
      setFailed(false)
      return created
    } catch {
      return null
    }
  }, [])

  const toggleShare = useCallback(async (item: SavedSearchView) => {
    const shared = !item.shared
    setItems((list) => (list ?? []).map((entry) => (entry.id === item.id ? { ...entry, shared } : entry)))
    try {
      await updateSavedSearch(item.id, { shared })
      return true
    } catch {
      setItems((list) => (list ?? []).map((entry) => (entry.id === item.id ? { ...entry, shared: item.shared } : entry)))
      return false
    }
  }, [])

  const remove = useCallback(async (item: SavedSearchView) => {
    try {
      await deleteSavedSearch(item.id)
      setItems((list) => (list ?? []).filter((entry) => entry.id !== item.id))
      return true
    } catch {
      return false
    }
  }, [])

  return { items, failed, save, toggleShare, remove }
}
