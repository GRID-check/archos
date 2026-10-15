'use client'

/**
 * Which column of a bar chart is "the one being read".
 *
 * A column chart with a value per day cannot keep those values behind a hover:
 * a finger has no hover, and a Radix tooltip on a plain `div` never opens on a
 * tap. So the chart keeps ONE selected column and prints its value in a
 * readout line above the plot. The selection moves four ways, all landing on
 * the same state:
 *
 * - tap or click a column,
 * - drag a finger (or pen) across the plot, which scrubs through the days,
 * - hover with a mouse,
 * - focus, so arrow keys, Home and End walk the days with the keyboard.
 *
 * Until the reader picks one, the newest column is selected: "today" is what an
 * office lead opens a spend chart for, and it is the one that used to sit
 * off-screen on a phone.
 *
 * Columns are a roving tab stop (only the selected one is tabbable) so a
 * 30-column plot costs one Tab, not thirty.
 */

import {
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  useCallback,
  useRef,
  useState,
} from 'react'

export interface ColumnSelection {
  /** Index of the selected column, always in range. */
  selected: number
  plotRef: RefObject<HTMLDivElement | null>
  /** Spread on the element that holds the columns. */
  plotProps: {
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => void
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => void
  }
  /** Spread on the button that is column `index`. */
  columnProps: (index: number) => {
    type: 'button'
    tabIndex: 0 | -1
    'aria-pressed': boolean
    'data-selected': boolean
    onClick: () => void
    onFocus: () => void
    onPointerEnter: (event: PointerEvent<HTMLButtonElement>) => void
  }
}

export function useColumnSelection(count: number): ColumnSelection {
  const [picked, setPicked] = useState<number | null>(null)
  const plotRef = useRef<HTMLDivElement>(null)
  const selected = picked !== null && picked < count ? picked : Math.max(count - 1, 0)

  const columnAt = useCallback(
    (clientX: number): number | null => {
      const rect = plotRef.current?.getBoundingClientRect()
      if (!rect || rect.width <= 0 || count === 0) return null
      const ratio = (clientX - rect.left) / rect.width
      return Math.min(count - 1, Math.max(0, Math.floor(ratio * count)))
    },
    [count]
  )

  const scrub = (event: PointerEvent<HTMLDivElement>): void => {
    const index = columnAt(event.clientX)
    if (index !== null) setPicked(index)
  }

  const plotProps: ColumnSelection['plotProps'] = {
    onPointerDown: (event) => {
      if (event.pointerType !== 'mouse') scrub(event)
    },
    // Only a finger or pen that is down scrubs. A mouse already selects by
    // hovering a column, and a touch pointer that is not down never moves.
    onPointerMove: (event) => {
      if (event.pointerType !== 'mouse' && event.buttons > 0) scrub(event)
    },
    onKeyDown: (event) => {
      const next = (() => {
        switch (event.key) {
          case 'ArrowLeft':
            return Math.max(selected - 1, 0)
          case 'ArrowRight':
            return Math.min(selected + 1, count - 1)
          case 'Home':
            return 0
          case 'End':
            return count - 1
          default:
            return null
        }
      })()
      if (next === null) return
      event.preventDefault()
      setPicked(next)
      plotRef.current?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus()
    },
  }

  const columnProps: ColumnSelection['columnProps'] = (index) => ({
    type: 'button',
    tabIndex: index === selected ? 0 : -1,
    'aria-pressed': index === selected,
    'data-selected': index === selected,
    onClick: () => setPicked(index),
    onFocus: () => setPicked(index),
    onPointerEnter: (event) => {
      if (event.pointerType === 'mouse') setPicked(index)
    },
  })

  return { selected, plotRef, plotProps, columnProps }
}
