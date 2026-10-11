/** `value` held to 0..100. */
export const clampPercent = (value: number): number =>
  Number.isFinite(value) ? Math.min(Math.max(value, 0), 100) : 50

/** Where a pointer is along a track, as a percentage of the track's width. */
export function percentAlong(clientX: number, track: { left: number; width: number }): number {
  if (track.width <= 0) return 50
  return clampPercent(((clientX - track.left) / track.width) * 100)
}

/** Arrow keys move the divider by 2%, Shift by 10%; Home and End go to the edges. */
export function swipeKeyTarget(current: number, key: string, shift: boolean): number | null {
  const step = shift ? 10 : 2
  if (key === 'ArrowLeft') return clampPercent(current - step)
  if (key === 'ArrowRight') return clampPercent(current + step)
  if (key === 'Home') return 0
  if (key === 'End') return 100
  return null
}
