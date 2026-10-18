'use client'

/**
 * Citation defects per day — stacked bar chart over the selected UTC window.
 *
 * Dataviz specs: thin bars with 2px surface gaps between columns AND between
 * stacked segments, rounded data end on the topmost segment only, recessive
 * baseline, a legend (>=2 series is never color-alone), and all text in text
 * tokens —
 * color only ever paints the marks. Series colors come from the validated
 * categorical palette in fixed slot order, so a kind keeps its hue even when
 * another kind disappears from the window.
 *
 * The per-day breakdown is a readout above the plot for the selected column
 * (newest until the reader picks another), moved by tap, drag, hover or arrow
 * keys (`useColumnSelection`): a tooltip needs a hover a finger does not have.
 * The columns shrink to the width they are given, so the newest day is on
 * screen on a phone without a swipe.
 */

import { type FC } from 'react'
import { useColumnSelection } from '@/components/charts/use-column-selection'
import { SectionLabel } from '@/components/ui/section-label'
import { SeriesPaletteStyle } from '@/components/charts/palette'
import { useLocale } from '@/i18n'

export interface CitationDefectPoint {
  day: string
  turns: number
  defectTurns: number
  byKind: Record<string, number>
}

interface CitationDefectChartProps {
  points: CitationDefectPoint[]
  /** Defect kinds to stack, in fixed palette-slot order. */
  kinds: readonly string[]
  kindLabel: (kind: string) => string
  turnsLabel: (count: number) => string
  /**
   * Label for a count of FINDINGS. The stack sums per-kind turn counts, and a
   * turn carrying three kinds contributes three segments — so the axis maximum
   * and each column describe findings, never turns. Labelling the stack as
   * turns made one flagged turn read as three.
   */
  findingsLabel: (count: number) => string
  /** Label for the turns that carried at least one finding, for the tooltip. */
  flaggedLabel: (count: number) => string
  emptyLabel: string
  /** Accessible name for the plot; the table-equivalent lives in the tooltips. */
  ariaLabel: string
}

/**
 * Palette slot for a kind — its INDEX in the caller's fixed `kinds` list, not
 * its rank in the current window. Filtering the window must never repaint the
 * surviving series.
 */
const seriesVar = (index: number): string => `var(--grid-series-${(index % 8) + 1})`

export const CitationDefectChart: FC<CitationDefectChartProps> = ({
  points,
  kinds,
  kindLabel,
  turnsLabel,
  findingsLabel,
  flaggedLabel,
  emptyLabel,
  ariaLabel,
}) => {
  const { locale } = useLocale()
  const { selected, plotRef, plotProps, columnProps } = useColumnSelection(points.length)
  const stackTotal = (point: CitationDefectPoint): number =>
    kinds.reduce((sum, kind) => sum + (point.byKind[kind] ?? 0), 0)
  const maxStack = Math.max(...points.map(stackTotal), 0)

  const dateLabel = (day: string): string =>
    new Date(`${day}T00:00:00Z`).toLocaleDateString(locale, {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    })

  if (points.length === 0 || maxStack <= 0) {
    return <p className="text-muted-foreground text-sm">{emptyLabel}</p>
  }

  // Only the kinds actually present get a legend entry, but each keeps the
  // color of its slot in the full `kinds` list.
  const presentKinds = kinds
    .map((kind, index) => ({ kind, index }))
    .filter(({ kind }) => points.some((point) => (point.byKind[kind] ?? 0) > 0))

  const current = points[selected]
  const currentKinds = presentKinds.filter(({ kind }) => (current.byKind[kind] ?? 0) > 0)

  return (
    // The palette scope wraps the plot AND the legend: the series variables
    // only resolve under `.grid-usage-viz`, and a legend outside it drew its
    // swatches in no colour at all, leaving the labels to stand alone.
    <div className="grid-usage-viz">
      <SeriesPaletteStyle />
      {/* The selected day. Turns observed, then how many of them carried a
          finding: the stack counts findings, and without both lines a
          3-segment column reads as three bad turns. */}
      <div className="min-h-[3.25rem] text-sm leading-5" aria-live="polite" data-testid="defect-readout">
        <p className="font-medium">{dateLabel(current.day)}</p>
        <p className="text-muted-foreground tabular-nums">
          {turnsLabel(current.turns)} · {flaggedLabel(current.defectTurns)}
        </p>
        {currentKinds.length > 0 && (
          <ul className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
            {currentKinds.map(({ kind, index }) => (
              <li key={kind} className="flex items-center gap-1.5">
                <span
                  // 2px on an 8px swatch: `rounded-sm` (6px) would round it to
                  // all but a circle, and a legend key must read as the same
                  // shape as the bar it names.
                  className="size-2 shrink-0 rounded-[2px]"
                  style={{ backgroundColor: seriesVar(index) }}
                  aria-hidden
                />
                <span>{kindLabel(kind)}</span>
                <span className="tabular-nums">{current.byKind[kind]}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex justify-end">
        <SectionLabel className="leading-4">{findingsLabel(maxStack)}</SectionLabel>
      </div>
      {/* Deliberately NOT role="img": that would collapse the whole plot into
          one opaque node and hide the per-day columns from assistive tech. The
          group keeps an accessible name; each column below is its own
          focusable, describable target. */}
      <div
        ref={plotRef}
        className="border-border flex h-24 touch-pan-y items-end gap-[2px] border-b"
        role="group"
        aria-label={ariaLabel}
        {...plotProps}
      >
        {points.map((point, index) => {
          const total = stackTotal(point)
          return (
            // Full-height column = hit target bigger than the mark.
            <button
              key={point.day}
              aria-label={`${dateLabel(point.day)}: ${findingsLabel(total)}`}
              className="focus-visible:ring-ring/60 data-[selected=true]:bg-muted flex h-full min-w-0 flex-1 cursor-default flex-col justify-end gap-[2px] rounded-sm outline-none focus-visible:ring-2"
              {...columnProps(index)}
            >
              {total > 0 ? (
                presentKinds
                  // Bottom-up stack: render in reverse so slot 1 sits on the
                  // baseline and the rounded end lands on top.
                  .filter(({ kind }) => (point.byKind[kind] ?? 0) > 0)
                  .reverse()
                  .map(({ kind, index: slot }, position) => (
                    <span
                      key={kind}
                      // 3px, not `rounded-t-sm` (6px): the bar is under 10px
                      // wide on a phone, and a 6px cap turns a mark into a
                      // lozenge. A data end's radius is bounded by its width.
                      className={position === 0 ? 'block w-full rounded-t-[3px]' : 'block w-full'}
                      style={{
                        backgroundColor: seriesVar(slot),
                        height: `${Math.max(((point.byKind[kind] ?? 0) / maxStack) * 100, 3)}%`,
                      }}
                    />
                  ))
              ) : (
                <span className="bg-border block h-px w-full" />
              )}
            </button>
          )
        })}
      </div>
      <SectionLabel as="div" className="mt-1 flex justify-between leading-4">
        <span>{dateLabel(points[0].day)}</span>
        <span>{dateLabel(points[points.length - 1].day)}</span>
      </SectionLabel>
      {/* Legend: identity is never color-alone. */}
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
        {presentKinds.map(({ kind, index }) => (
          <li key={kind} className="text-muted-foreground flex items-center gap-1.5 text-xs">
            <span
              // 2px on a 10px swatch — see the readout key above: the token
              // step would round the square into a dot.
              className="size-2.5 shrink-0 rounded-[2px]"
              style={{ backgroundColor: seriesVar(index) }}
              aria-hidden
            />
            {kindLabel(kind)}
          </li>
        ))}
      </ul>
    </div>
  )
}
