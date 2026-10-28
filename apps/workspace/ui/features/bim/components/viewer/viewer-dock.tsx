'use client'

/**
 * The floating control bar at the bottom of the viewport.
 *
 * Bottom-centre, not top-right, and that is the whole argument of this
 * redesign in one component. Controls parked in a corner read as a toolbar
 * attached to a document; controls floating at the bottom edge read as the
 * tools of the thing you are looking at — the arrangement Figma, Miro and
 * every drawing app converged on, because it keeps the hand out of the middle
 * of the work and puts the controls where the eye already returns.
 *
 * Three parts, deliberately: a leading slot that is its OWN pill (for the one
 * control that is not a tool — Home), the tool group, and a trailing slot.
 * The gap between the pills is what separates "get me back" from "change what
 * I see", and it is why the bar does not read as one undifferentiated row of
 * nine icons.
 *
 * The dock never covers the model with a dead zone: the positioning wrapper AND
 * the scrolling row inside it are `pointer-events-none`, and only the pills
 * themselves take the pointer, so a drag that starts beside a button still
 * orbits the building.
 *
 * ## Three layouts, one stack
 *
 * `floating` is the desktop bar above. On a phone it was ~480 px of glyphs in a
 * 369 px row that scrolled sideways behind a hidden scrollbar, so the controls
 * that mattered most sat off-screen with nothing to say they existed. A phone
 * gets one of two arrangements instead, and in both the children are
 * `ViewerToolButton`s — a handful of labelled tools that FIT — and nothing is
 * left to scroll:
 *
 * - `bar` — portrait. One full-width pill along the bottom, tools sharing it
 *   equally. `lead` and `trail` do not exist here: the caller decides what is
 *   important enough to be a tool and puts the rest in a sheet.
 * - `side` — landscape. The same tools as a column on the left edge, because a
 *   393 px tall screen cannot spare a 70 px bar, and the width is free.
 *
 * `sheet` is the bottom sheet's seat. It lives in the SAME column as the bar and
 * the `above` rows, so the stack grows upward as things appear and nothing can
 * overlap by arithmetic — the legend, the cut slider and the sheet used to be
 * positioned by hand against each other, and "bottom-52" is a number that is
 * right until the next row is added.
 */

import type { JSX } from 'react'
import { type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { ViewerSurface } from './viewer-surface'

export interface ViewerDockProps {
  /** Its own pill, set apart from the tools. */
  lead?: ReactNode
  /** The tool group. */
  children: ReactNode
  /**
   * The way out to the advanced surfaces — inside the same pill as the tools,
   * behind a separator.
   *
   * It had its own pill once. Three floating bars two gaps apart read as three
   * competing objects rather than one control bar, and the screenshot made
   * that obvious in a way the markup did not: the bottom of the viewport was
   * busier than the building. One divider says "different kind of thing"
   * perfectly well.
   */
  trail?: ReactNode
  /**
   * Rendered above the bar, stacked: the section-height slider when a cut is
   * live, the measuring hint while that tool is. Both at once is a legitimate
   * state — a reviewer measures a clear height on a sectioned model — so this
   * is a column rather than a slot for one thing.
   */
  above?: ReactNode
  /** A bottom sheet, stacked between the `above` rows and the bar. */
  sheet?: ReactNode
  /** See the header: the desktop pill, or one of the two phone arrangements. */
  layout?: 'floating' | 'bar' | 'side'
  className?: string
}

export function ViewerDock({
  lead,
  children,
  trail,
  above,
  sheet,
  layout = 'floating',
  className,
}: ViewerDockProps): JSX.Element {
  if (layout !== 'floating') {
    const side = layout === 'side'
    return (
      <>
        <div
          className={cn(
            'pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col items-center gap-1.5 p-3',
            // The column of tools lives on the left; the stack keeps clear of it.
            side && 'pl-24',
            className
          )}
        >
          {above}
          {sheet}
          {!side && (
            <ViewerSurface
              data-slot="viewer-dock-bar"
              className="pointer-events-auto flex w-full max-w-lg items-stretch gap-0.5 p-1"
            >
              {children}
            </ViewerSurface>
          )}
        </div>
        {side && (
          <div
            className={cn(
              'pointer-events-none absolute inset-y-0 left-3 z-20 flex items-center',
              className
            )}
          >
            <ViewerSurface
              data-slot="viewer-dock-column"
              className="pointer-events-auto flex w-[4.5rem] flex-col items-stretch gap-0.5 p-1"
            >
              {children}
            </ViewerSurface>
          </div>
        )}
      </>
    )
  }

  return (
    <div
      className={cn(
        'pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col items-center gap-1.5 p-3 sm:p-4',
        className
      )}
    >
      {above}
      {sheet}
      {/*
        `w-full` rather than a shrink-to-fit row: at 390 px the pills are wider
        than the viewport, and a centred row that cannot scroll simply loses
        its ends. This way the bar scrolls, and the scrollbar itself is hidden
        because a visible one under a floating pill reads as a rendering
        artefact.

        `justify-center-safe`, not `justify-center`. A centred flex row that
        overflows a scroll container overflows in BOTH directions, and
        `scrollLeft` cannot go below zero — so the left end was unreachable by
        any gesture. On a phone that is the Home button, the one control the
        whole design calls "get me back". The safe alignment falls back to
        `start` exactly when the content does not fit.
      */}
      {/*
        The pointer is taken by the PILLS, not by this row. The row is
        `w-full` (see above), so `pointer-events-auto` here put a dead band the
        full width of the viewport across the bottom of the canvas — about
        68 px with a coarse pointer, which is 8 % of a portrait phone and 17 %
        of a landscape one where the building cannot be orbited at all, and
        where a horizontal drag scrolled the dock instead. Touch-scrolling the
        overflowing row still works: the scroll chain is walked up from
        whichever pill was hit, and does not care that this element declines
        the pointer itself.
      */}
      <div className="flex w-full max-w-full items-center justify-center-safe gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {lead && (
          <ViewerSurface className="pointer-events-auto flex shrink-0 items-center gap-1 p-1">
            {lead}
          </ViewerSurface>
        )}
        <ViewerSurface className="pointer-events-auto flex shrink-0 items-center gap-1 p-1">
          {children}
          {trail && (
            <>
              <ViewerDockSeparator />
              {trail}
            </>
          )}
        </ViewerSurface>
      </div>
    </div>
  )
}

/**
 * A hairline between two groups of tools inside one pill.
 *
 * `aria-hidden` because it is punctuation: a screen reader announcing
 * "separator" between every pair of buttons is noise, and the grouping it
 * expresses is already carried by each control's own name.
 */
export function ViewerDockSeparator(): JSX.Element {
  return <span aria-hidden="true" className="mx-0.5 h-6 w-px shrink-0 bg-border" />
}
