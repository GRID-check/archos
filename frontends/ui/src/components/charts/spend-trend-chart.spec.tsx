import { act, fireEvent, render, screen } from '@/test-utils'
import { describe, expect, test, vi } from 'vitest'
import { SpendTrendChart, type SpendTrendPoint } from './spend-trend-chart'

/**
 * The per-day value used to live in a hover tooltip on a non-focusable div, so
 * on a phone no day's amount could be read, and the newest day started off
 * screen inside a 420px scroll box. These pin the replacement: a readout that
 * a tap, a drag, a focus or an arrow key moves, defaulting to the newest day.
 */

const POINTS: SpendTrendPoint[] = [
  { day: '2026-07-26', value: 10, events: 1 },
  { day: '2026-07-27', value: 40, events: 4 },
  { day: '2026-07-28', value: 25, events: 2 },
  { day: '2026-07-29', value: 5, events: 1 },
]

const renderChart = () =>
  render(
    <SpendTrendChart
      points={POINTS}
      formatValue={(value) => `${value} credits`}
      requestsLabel={(count) => `${count} requests`}
      emptyLabel="Nothing yet"
      label="Last 30 days"
    />
  )

const readout = (): string => screen.getByTestId('spend-trend-readout').textContent ?? ''

describe('SpendTrendChart', () => {
  test('reads the newest day first, without any interaction', () => {
    renderChart()
    expect(readout()).toBe('Jul 29: 5 credits · 1 requests')
  })

  test('a tap on a column puts that day in the readout', () => {
    renderChart()
    fireEvent.click(screen.getByRole('button', { name: /Jul 27/ }))
    expect(readout()).toBe('Jul 27: 40 credits · 4 requests')
    expect(screen.getByRole('button', { name: /Jul 27/ })).toHaveAttribute('aria-pressed', 'true')
  })

  test('focus selects too, and the arrow keys walk the days', () => {
    renderChart()
    const group = screen.getByRole('group', { name: 'Last 30 days' })
    act(() => screen.getByRole('button', { name: /Jul 28/ }).focus())
    expect(readout()).toBe('Jul 28: 25 credits · 2 requests')
    fireEvent.keyDown(group, { key: 'ArrowLeft' })
    expect(readout()).toBe('Jul 27: 40 credits · 4 requests')
    fireEvent.keyDown(group, { key: 'Home' })
    expect(readout()).toBe('Jul 26: 10 credits · 1 requests')
    fireEvent.keyDown(group, { key: 'End' })
    expect(readout()).toBe('Jul 29: 5 credits · 1 requests')
  })

  test('only the selected column is a tab stop', () => {
    renderChart()
    const stops = screen.getAllByRole('button').filter((button) => button.tabIndex === 0)
    expect(stops).toHaveLength(1)
    expect(stops[0]).toHaveAccessibleName(/Jul 29/)
  })

  test('dragging a finger across the plot scrubs through the days', () => {
    renderChart()
    const group = screen.getByRole('group', { name: 'Last 30 days' })
    vi.spyOn(group, 'getBoundingClientRect').mockReturnValue({
      left: 0, right: 400, width: 400, top: 0, bottom: 96, height: 96, x: 0, y: 0, toJSON: () => ({}),
    })
    fireEvent.pointerDown(group, { pointerType: 'touch', clientX: 150, buttons: 1 })
    expect(readout()).toBe('Jul 27: 40 credits · 4 requests')
    fireEvent.pointerMove(group, { pointerType: 'touch', clientX: 20, buttons: 1 })
    expect(readout()).toBe('Jul 26: 10 credits · 1 requests')
    // A finger that is up does not move the selection.
    fireEvent.pointerMove(group, { pointerType: 'touch', clientX: 390, buttons: 0 })
    expect(readout()).toBe('Jul 26: 10 credits · 1 requests')
  })

  test('shrinks to its container instead of scrolling inside a width floor', () => {
    const { container } = renderChart()
    expect(container.querySelector('[class*="min-w-["]')).toBeNull()
    expect(container.querySelector('.overflow-x-auto')).toBeNull()
  })

  test('renders the empty label when nothing was spent', () => {
    render(
      <SpendTrendChart
        points={[{ day: '2026-07-29', value: 0, events: 0 }]}
        formatValue={String}
        emptyLabel="Nothing yet"
      />
    )
    expect(screen.getByText('Nothing yet')).toBeDefined()
  })
})
