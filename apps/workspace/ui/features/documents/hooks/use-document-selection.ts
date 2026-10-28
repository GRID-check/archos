'use client'

import { useCallback, useMemo, useState } from 'react'

/**
 * Picking several documents of a level: the state behind „Auswählen".
 *
 * A selection is a MODE, not a property of a row: while it is on, a tap on a
 * card or row toggles it instead of opening the preview, the ⋯ steps aside, and
 * a bar at the bottom of the screen carries what can be done to the lot. On a
 * phone, on site, this is how five photos reach the folder they belong in
 * without five trips through a menu.
 *
 * Ids, not rows, so a poll that replaces the rows does not drop the selection.
 */
export interface DocumentSelection {
  /** Whether the selection mode is on. Independent of the count: it is on at zero. */
  active: boolean
  selectedIds: ReadonlySet<string>
  /** Turn the mode on, optionally with one document already picked. */
  start: (documentId?: string) => void
  toggle: (documentId: string) => void
  /** Pick exactly these (the level's „Alle"). */
  set: (documentIds: readonly string[]) => void
  /** Turn the mode off and forget the picks. */
  exit: () => void
}

const NONE: ReadonlySet<string> = new Set()

export function useDocumentSelection(): DocumentSelection {
  const [active, setActive] = useState(false)
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(NONE)

  const start = useCallback((documentId?: string) => {
    setActive(true)
    setSelectedIds(documentId === undefined ? NONE : new Set([documentId]))
  }, [])
  const toggle = useCallback((documentId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (!next.delete(documentId)) next.add(documentId)
      return next
    })
  }, [])
  const set = useCallback(
    (documentIds: readonly string[]) => setSelectedIds(new Set(documentIds)),
    []
  )
  const exit = useCallback(() => {
    setActive(false)
    setSelectedIds(NONE)
  }, [])

  return useMemo(
    () => ({ active, selectedIds, start, toggle, set, exit }),
    [active, selectedIds, start, toggle, set, exit]
  )
}
