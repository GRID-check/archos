'use client'

import type { JSX } from 'react'
import { useCallback, useMemo, useState } from 'react'
import { FassungCompare } from './fassung-compare'
import type { CompareFile, CompareRegion, SourceLoader } from './types'

interface OpenState {
  older: CompareFile
  newer: CompareFile
  overlays: readonly CompareRegion[]
}

export interface FassungCompareHandle {
  /** Open the comparison of two Fassungen. A second call replaces the first. */
  openFassungCompare: (
    older: CompareFile,
    newer: CompareFile,
    overlays?: readonly CompareRegion[],
  ) => void
  /** Render this once, anywhere in the tree; it is nothing while the comparison is shut. */
  compareElement: JSX.Element | null
}

/**
 * The way a surface mounts the comparison: one hook, one element.
 *
 * ```tsx
 * const { openFassungCompare, compareElement } = useFassungCompare()
 * // …in the timeline row of an older Fassung:
 * <Button onClick={() => openFassungCompare(olderRef, currentRef)}>Vergleichen</Button>
 * // …once, next to the panel's root:
 * {compareElement}
 * ```
 *
 * `older` and `newer` need only an id and a file name, which is what a
 * `FassungRef` carries. Pass `overlays` when an AI comparison has found the
 * changed places. Pass `onOpenTextCompare` when the surface can show the text
 * comparison of the same pair; the not-comparable state then offers it.
 *
 * Focus goes back to whatever had it when the comparison opened (the row's
 * button, normally), because nothing here is a `DialogTrigger`.
 */
export function useFassungCompare(
  loadSource?: SourceLoader,
  options: { onOpenTextCompare?: (older: CompareFile, newer: CompareFile) => void } = {},
): FassungCompareHandle {
  const { onOpenTextCompare } = options
  const [open, setOpen] = useState<OpenState | null>(null)

  const openFassungCompare = useCallback<FassungCompareHandle['openFassungCompare']>(
    (older, newer, overlays = []) => setOpen({ older, newer, overlays }),
    [],
  )
  const close = useCallback(() => setOpen(null), [])

  const compareElement = useMemo(
    () =>
      open ? (
        <FassungCompare
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

  return { openFassungCompare, compareElement }
}
