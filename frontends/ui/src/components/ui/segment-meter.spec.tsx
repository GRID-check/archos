import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'

import { SegmentMeter, segmentEnds } from './segment-meter'

describe('segmentEnds', () => {
  it('ends each segment at its cumulative share, the last at exactly the track end', () => {
    expect(segmentEnds([1, 1, 2])).toEqual([0.25, 0.5, 1])
  })

  it('keeps a tiny state visible as a sliver instead of letting it vanish', () => {
    const [first, second] = segmentEnds([1, 999])
    expect(first).toBeGreaterThan(0.025)
    expect(second).toBe(1)
  })

  it('draws nothing for an empty whole', () => {
    expect(segmentEnds([])).toEqual([])
    expect(segmentEnds([0, 0])).toEqual([])
  })
})

describe('SegmentMeter', () => {
  it('moves its segments by transform, never by a layout property', () => {
    const { container } = render(
      <SegmentMeter
        label="3 von 4 gelesen"
        segments={[
          { key: 'read', value: 3, tone: 'success' },
          { key: 'failed', value: 1, tone: 'destructive' },
          { key: 'pending', value: 0, tone: 'muted' },
        ]}
      />
    )
    const segments = container.querySelectorAll<HTMLElement>('[data-segment]')
    expect(segments).toHaveLength(2)
    expect(segments[0].style.transform).toBe('scaleX(0.75)')
    expect(segments[1].style.transform).toBe('scaleX(1)')
    expect(segments[0].className).toContain('transition-transform')
    expect(segments[0].style.flexGrow).toBe('')
    expect(container.querySelectorAll('[data-segment-gap]')).toHaveLength(1)
  })
})
