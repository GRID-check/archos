'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useUndoableArchive } from '@/features/collaboration/hooks/use-undoable-archive'
import {
  SavedSearchError,
  createSavedSearch,
  deleteSavedSearch,
  listSavedSearches,
  updateSavedSearch,
  type SavedSearchDraft,
  type SavedSearchView,
} from '@/lib/search/saved-search-client'
import { captureSavedSearchCreated } from '../lib/search-telemetry'

/** How long „Rückgängig“ stays on offer after a delete: the toast's lifetime. */
export const SAVED_SEARCH_UNDO_MS = 6000

export interface SavedSearches {
  /** null while the list is read; a search waiting out its undo window is already left out. */
  items: SavedSearchView[] | null
  failed: boolean
  save: (draft: SavedSearchDraft) => Promise<SavedSearchView | null>
  toggleShare: (item: SavedSearchView) => Promise<boolean>
  /** Renames one's own; `taken` when another of one's own already has the name. */
  rename: (item: SavedSearchView, name: string) => Promise<SavedSearchRenameOutcome>
  /** Takes the search out of the list now; the server deletes it when the undo window closes. */
  remove: (item: SavedSearchView) => void
  /** Within the undo window: puts it back, and the server never hears of the delete. */
  undoRemove: (item: SavedSearchView) => void
}

export type SavedSearchRenameOutcome = 'renamed' | 'taken' | 'failed'

export interface SavedSearchesOptions {
  /** The server refused a delete after the window: the search is back in the list. */
  onRemoveFailed?: () => void
  /** The undo window; the toast that offers undo stays as long. */
  undoMs?: number
}

/**
 * The reader's saved searches, read once, and the changes to them written
 * through and reflected.
 *
 * A delete is held back rather than undone (`useUndoableArchive`): the row
 * leaves the list at once and the `DELETE` is sent when the undo window
 * closes, or when the page goes away. Undo inside the window therefore never
 * touches the server, and cannot half-succeed, which a re-create on undo
 * could: a new id, a new date, and a name a parallel save may have taken.
 */
export function useSavedSearches({ onRemoveFailed, undoMs = SAVED_SEARCH_UNDO_MS }: SavedSearchesOptions = {}): SavedSearches {
  const [items, setItems] = useState<SavedSearchView[] | null>(null)
  const [failed, setFailed] = useState(false)
  const failedRef = useRef(onRemoveFailed)
  useEffect(() => {
    failedRef.current = onRemoveFailed
  }, [onRemoveFailed])

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

  const commitDelete = useCallback(async (id: string): Promise<void> => {
    try {
      await deleteSavedSearch(id)
      setItems((list) => (list ?? []).filter((entry) => entry.id !== id))
    } catch {
      failedRef.current?.()
    }
  }, [])
  const deleting = useUndoableArchive(commitDelete, undoMs)

  const save = useCallback(async (draft: SavedSearchDraft) => {
    try {
      const created = await createSavedSearch(draft)
      captureSavedSearchCreated(created)
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

  const rename = useCallback(async (item: SavedSearchView, name: string): Promise<SavedSearchRenameOutcome> => {
    try {
      await updateSavedSearch(item.id, { name })
      setItems((list) => (list ?? []).map((entry) => (entry.id === item.id ? { ...entry, name } : entry)))
      return 'renamed'
    } catch (error) {
      return error instanceof SavedSearchError && error.status === 409 ? 'taken' : 'failed'
    }
  }, [])

  const { request, undo, pendingIds } = deleting
  const remove = useCallback((item: SavedSearchView) => request(item.id), [request])
  const undoRemove = useCallback((item: SavedSearchView) => undo(item.id), [undo])
  const visible = useMemo(() => (items === null ? null : items.filter((entry) => !pendingIds.has(entry.id))), [items, pendingIds])

  return { items: visible, failed, save, toggleShare, rename, remove, undoRemove }
}
