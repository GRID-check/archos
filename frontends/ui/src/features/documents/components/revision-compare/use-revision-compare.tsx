'use client'

import type { JSX } from 'react'
import { useCallback, useMemo, useRef, useState } from 'react'
import { RevisionCompare } from './revision-compare'
import type { CompareFile, CompareRegion, SourceLoader } from './types'

interface OpenState {
  older: CompareFile
  newer: CompareFile
  overlays: readonly CompareRegion[]
}

export interface RevisionCompareHandle {
  /** Open the comparison of two Fassungen. A second call replaces the first. */
  openRevisionCompare: (
    older: CompareFile,
    newer: CompareFile,
    overlays?: readonly CompareRegion[],
  ) => void
  /**
   * Shut the comparison of THIS pair, as its own close button does (a viewer
   * action's „Zurücknehmen“, ADR-0144). A comparison the person opened since,
   * of another pair, stays; the return says whether anything was shut.
   */
  closeRevisionCompare: (older: CompareFile, newer: CompareFile) => boolean
  /** Render this once, anywhere in the tree; it is nothing while the comparison is shut. */
  compareElement: JSX.Element | null
}

/**
 * The way a surface mounts the comparison: one hook, one element.
 *
 * ```tsx
 * const { openRevisionCompare, compareElement } = useRevisionCompare()
 * // …in the timeline row of an older Fassung:
 * <Button onClick={() => openRevisionCompare(olderRef, currentRef)}>Vergleichen</Button>
 * // …once, next to the panel's root:
 * {compareElement}
 * ```
 *
 * `older` and `newer` need only an id and a file name, which is what a
 * `RevisionRef` carries. Pass `overlays` when an AI comparison has found the
 * changed places. Pass `onOpenTextCompare` when the surface can show the text
 * comparison of the same pair; the not-comparable state then offers it.
 *
 * Focus goes back to whatever had it when the comparison opened (the row's
 * button, normally), because nothing here is a `DialogTrigger`.
 */
export function useRevisionCompare(
  loadSource?: SourceLoader,
  options: { onOpenTextCompare?: (older: CompareFile, newer: CompareFile) => void } = {},
): RevisionCompareHandle {
  const { onOpenTextCompare } = options
  const [open, setOpen] = useState<OpenState | null>(null)
  // What is open NOW, read by a close that must not shut somebody else's pair; the state lags a render.
  const current = useRef<OpenState | null>(null)

  const openRevisionCompare = useCallback<RevisionCompareHandle['openRevisionCompare']>(
    (older, newer, overlays = []) => {
      current.current = { older, newer, overlays }
      setOpen(current.current)
    },
    [],
  )
  const close = useCallback(() => {
    current.current = null
    setOpen(null)
  }, [])
  const closeRevisionCompare = useCallback<RevisionCompareHandle['closeRevisionCompare']>(
    (older, newer) => {
      const shown = current.current
      if (!shown || shown.older.id !== older.id || shown.newer.id !== newer.id) return false
      close()
      return true
    },
    [close],
  )

  const compareElement = useMemo(
    () =>
      open ? (
        <RevisionCompare
          // A new pair is a new comparison: pages, zoom and mode start over.
          key={`${open.older.id}:${open.newer.id}`}
          older={open.older}
          newer={open.newer}
          overlays={open.overlays}
          loadSource={loadSource}
          onClose={close}
          onOpenTextCompare={
            onOpenTextCompare
              ? () => {
                  close()
                  onOpenTextCompare(open.older, open.newer)
                }
              : undefined
          }
        />
      ) : null,
    [open, close, loadSource, onOpenTextCompare],
  )

  return { openRevisionCompare, closeRevisionCompare, compareElement }
}
