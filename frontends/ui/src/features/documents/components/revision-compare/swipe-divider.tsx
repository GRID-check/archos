'use client'

import type { JSX, KeyboardEvent, PointerEvent, RefObject } from 'react'
import { ChevronsLeftRight } from 'lucide-react'
import { useTranslations } from '@/i18n'
import { filesCopy } from '@/i18n/namespaces/files'
import { percentAlong, swipeKeyTarget } from './lib/swipe'

export interface SwipeDividerProps {
  /** 0..100: how much of the width shows the older Fassung. */
  value: number
  onChange: (value: number) => void
  /** The box the divider travels in; the pointer is measured against it. */
  trackRef: RefObject<HTMLElement | null>
}

/**
 * The draggable line of the swipe mode.
 *
 * A `role="slider"` rather than a range input, because it has to sit ON the
 * drawing and be grabbed anywhere along its height; the keyboard works through
 * the arrows (Shift for a big step, Home and End for the edges). Pointer
 * capture keeps the drag alive when the pointer leaves the thin line, which it
 * does constantly.
 *
 * It is drawn ON the paper, so it does not follow the theme: a fixed
 * near-black line with a white halo and a dark handle, findable on white paper
 * and over black walls alike, in light mode and dark (a theme token went
 * near-white in dark mode and vanished on the sheet). The hit area is 24 px,
 * 44 px under a finger.
 */
export function SwipeDivider({ value, onChange, trackRef }: SwipeDividerProps): JSX.Element {
  const t = useTranslations(filesCopy)

  const move = (event: PointerEvent<HTMLElement>): void => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    const rect = trackRef.current?.getBoundingClientRect()
    if (rect) onChange(percentAlong(event.clientX, rect))
  }

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    const next = swipeKeyTarget(value, event.key, event.shiftKey)
    if (next === null) return
    event.preventDefault()
    onChange(next)
  }

  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label={t('compare.swipeDivider')}
      aria-orientation="horizontal"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value)}
      aria-valuetext={t('compare.swipeValue', { percent: Math.round(value) })}
      title={t('compare.swipeHint')}
      data-testid="swipe-divider"
      className="group absolute inset-y-0 z-10 w-6 -translate-x-1/2 cursor-ew-resize touch-none outline-none pointer-coarse:w-11"
      style={{ left: `${value}%` }}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId)
        move(event)
      }}
      onPointerMove={move}
      onDoubleClick={() => onChange(50)}
      onKeyDown={onKeyDown}
    >
      <span className="absolute inset-y-0 left-1/2 w-[3px] -translate-x-1/2 bg-[var(--compare-paper-ink)] shadow-[0_0_0_1px_var(--compare-paper)]" />
      <span
        aria-hidden
        className="absolute top-1/2 left-1/2 flex size-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-[var(--compare-paper-ink)] text-[var(--compare-paper)] shadow-[0_0_0_2px_var(--compare-paper),0_2px_6px_rgb(0_0_0/0.3)] group-focus-visible:shadow-[0_0_0_2px_var(--compare-paper),0_0_0_4px_var(--compare-paper-ink)]"
      >
        <ChevronsLeftRight className="size-4" />
      </span>
    </div>
  )
}
