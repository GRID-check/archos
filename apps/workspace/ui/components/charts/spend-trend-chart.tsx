/**
 * Daily spend trend — single-series bar chart (30 UTC days, zero-filled by
 * the service). Dataviz specs: thin bars with 2px surface gaps and rounded
 * data ends, recessive baseline, no legend for a single series (the card
 * title names it), and all text in text tokens (color only ever paints the
 * marks).
 *
 * The per-day value is never behind a hover: one column is selected (the
 * newest until the reader picks another) and its date, value and request
 * count are printed in a readout above the plot. Tap, drag across the plot,
 * hover or arrow-key to move it (`useColumnSelection`). The 30 columns shrink
 * to the width they are given rather than panning in a scroll box, so on a
 * phone today's bar is on screen without a swipe.
 *
 * Unit-agnostic on purpose (ADR-0053): the tenant's card feeds it credits,
 * the platform's overview feeds it USD cost. The caller names the value and
 * formats it; the chart only draws.
 */

import { type FC } from 'react'
import { SeriesPaletteStyle } from '@/components/charts/palette'
import { useColumnSelection } from '@/components/charts/use-column-selection'
import { SectionLabel } from '@/components/ui/section-label'
import { useLocale } from '@/i18n'

export interface SpendTrendPoint {
  day: string
  value: number
  events: number
}

interface SpendTrendChartProps {
  points: SpendTrendPoint[]
  /** The unit is the caller's: credits for a tenant, USD for the platform. */
  formatValue: (value: number) => string
  /** The second half of a column's readout; omit when the value already is the count. */
  requestsLabel?: (count: number) => string
  emptyLabel: string
  /** Accessible name of the plot (usually the card's title for it). */
  label?: string
}

export const SpendTrendChart: FC<SpendTrendChartProps> = ({
  points,
  formatValue,
  requestsLabel,
  emptyLabel,
  label,
}) => {
  const { locale } = useLocale()
  const { selected, plotRef, plotProps, columnProps } = useColumnSelection(points.length)
  const maxValue = Math.max(...points.map((point) => point.value), 0)
  const dateLabel = (day: string): string =>
    new Date(`${day}T00:00:00Z`).toLocaleDateString(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' })
  const readout = (point: SpendTrendPoint): string =>
    `${dateLabel(point.day)}: ${formatValue(point.value)}${requestsLabel ? ` · ${requestsLabel(point.events)}` : ''}`

  if (points.length === 0 || maxValue <= 0) {
    return <p className="text-sm text-muted-foreground">{emptyLabel}</p>
  }

  return (
    <div className="usage-viz">
      <SeriesPaletteStyle />
      {/* The selected day. `aria-live` so a keyboard walk announces each one;
          the min-height keeps the plot from jumping when the text wraps. */}
      <p
        className="min-h-5 text-sm leading-5 tabular-nums"
        aria-live="polite"
        data-testid="spend-trend-readout"
      >
        {readout(points[selected])}
      </p>
      <div className="flex justify-end">
        <SectionLabel className="leading-4">{formatValue(maxValue)}</SectionLabel>
      </div>
      <div
        ref={plotRef}
        role="group"
        aria-label={label}
        // `pan-y`: a vertical swipe still scrolls the page, a horizontal one
        // scrubs through the days instead of being claimed by the browser.
        className="flex h-24 touch-pan-y items-end gap-[2px] border-b border-border"
        {...plotProps}
      >
        {points.map((point, index) => (
          // Full-height column = hit target bigger than the mark.
          <button
            key={point.day}
            aria-label={readout(point)}
            className="flex h-full min-w-0 flex-1 cursor-default items-end rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/60 data-[selected=true]:bg-muted"
            {...columnProps(index)}
          >
            {point.value > 0 ? (
              <span
                // 3px, not `rounded-t-sm` (6px): the bar is under 10px wide on
                // a phone, and a 6px cap turns a mark into a lozenge. A data
                // end's radius is bounded by the mark's width.
                className="block w-full rounded-t-[3px]"
                style={{
                  backgroundColor: 'var(--chart-series-1)',
                  height: `${Math.max((point.value / maxValue) * 100, 3)}%`,
                }}
              />
            ) : (
              <span className="block h-px w-full bg-border" />
            )}
          </button>
        ))}
      </div>
      <SectionLabel as="div" className="mt-1 flex justify-between leading-4">
        <span>{dateLabel(points[0].day)}</span>
        <span>{dateLabel(points[points.length - 1].day)}</span>
      </SectionLabel>
    </div>
  )
}
