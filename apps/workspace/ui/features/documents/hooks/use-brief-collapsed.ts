'use client'

import { useCallback, useEffect, useState } from 'react'

const BRIEF_STORAGE_KEY = 'files.brief.collapsed'

/**
 * Whether the folder brief is folded to its one-line summary, remembered per
 * browser like the card/list choice. Folded by default: what Piloti has read is
 * something a person checks now and then, not what they open a folder for, and
 * open on every level the card pushed the listing below the fold.
 */
export function useBriefCollapsed(phone = false): readonly [boolean, (next: boolean) => void] {
  const [collapsed, setCollapsed] = useState(true)
  useEffect(() => {
    // A phone stays folded whatever the desk chose: the choice was made on a
    // screen with room for the card, and here it would push the folders and
    // files off the first screen. Opening it on the phone is for this visit.
    if (phone) {
      setCollapsed(true)
      return
    }
    try {
      if (window.localStorage.getItem(BRIEF_STORAGE_KEY) === '0') setCollapsed(false)
    } catch {
      // Storage unavailable — the choice holds for this visit.
    }
  }, [phone])
  const select = useCallback(
    (next: boolean) => {
      setCollapsed(next)
      if (phone) return
      try {
        window.localStorage.setItem(BRIEF_STORAGE_KEY, next ? '1' : '0')
      } catch {
        // As above.
      }
    },
    [phone]
  )
  return [collapsed, select] as const
}
