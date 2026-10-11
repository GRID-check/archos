'use client'

import { useCallback, useEffect, useState } from 'react'

const BRIEF_STORAGE_KEY = 'grid.files.brief.collapsed'

/**
 * Whether the folder brief is folded to its one-line summary, remembered per
 * browser like the card/list choice. Folded by default: what Piloti has read is
 * something a person checks now and then, not what they open a folder for, and
 * open on every level the card pushed the listing below the fold.
 */
export function useBriefCollapsed(): readonly [boolean, (next: boolean) => void] {
  const [collapsed, setCollapsed] = useState(true)
  useEffect(() => {
    try {
      if (window.localStorage.getItem(BRIEF_STORAGE_KEY) === '0') setCollapsed(false)
    } catch {
      // Storage unavailable — the choice holds for this visit.
    }
  }, [])
  const select = useCallback((next: boolean) => {
    setCollapsed(next)
    try {
      window.localStorage.setItem(BRIEF_STORAGE_KEY, next ? '1' : '0')
    } catch {
      // As above.
    }
  }, [])
  return [collapsed, select] as const
}
