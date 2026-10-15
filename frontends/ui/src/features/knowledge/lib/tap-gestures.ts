/**
 * Telling a tap from a scroll, and a double tap from two taps. Pure, so the
 * thresholds are held by a spec rather than by somebody's thumb.
 */

/** One press on the glass: when and where it started, with how many fingers, and whether it travelled. */
export interface TapRecord {
  time: number
  x: number
  y: number
  fingers: number
  moved: boolean
}

/** Longer than this on the glass, a press was a hold, not a tap. */
export const TAP_MAX_MS = 300
/** The gap a second tap has to land in, from the first one's release. */
export const DOUBLE_TAP_MS = 300
/** How far apart two taps may land and still be one double tap, in CSS pixels. */
export const DOUBLE_TAP_SLOP = 32

export type TapKind = 'none' | 'single' | 'double' | 'two-finger'

/**
 * What a press that just ended was.
 *
 * `previous` is the last single tap, with its RELEASE time; `releasedAt` is
 * this press's release. A press that moved, or stayed down too long, is none
 * of them: it was a scroll or a hold, and the finger that made it meant that.
 */
export function classifyTap(
  press: TapRecord,
  previous: TapRecord | null,
  releasedAt: number
): { kind: TapKind } {
  if (press.moved || releasedAt - press.time > TAP_MAX_MS) return { kind: 'none' }
  if (press.fingers === 2) return { kind: 'two-finger' }
  if (press.fingers !== 1) return { kind: 'none' }
  if (
    previous &&
    press.time - previous.time <= DOUBLE_TAP_MS &&
    Math.hypot(press.x - previous.x, press.y - previous.y) <= DOUBLE_TAP_SLOP
  ) {
    return { kind: 'double' }
  }
  return { kind: 'single' }
}
