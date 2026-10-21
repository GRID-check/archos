/**
 * The press — how a small control gives way under a click, written once.
 *
 * `Button` and `TabsTrigger` already dip to 0.98 on `--motion-snap` (the press
 * half of `springPress`, see the comment in `button.tsx`). The hand-rolled
 * controls around an answer had drifted to four scales (0.95, 0.98, 0.99,
 * 0.88) on two durations, so a citation chip, the copy link beside it and the
 * card row under it each answered the same click differently. This is that one
 * press for anything that is not a `Button`: the same scale, the same split of
 * durations (colour on `--motion-quick`, the transform on `--motion-snap`), and
 * the same reduced-motion escape.
 *
 * The transition list names `filter` and `border-color` as well as colour,
 * background and transform: a chip's hover is a brightness step and a card's
 * lifecycle accent is a border colour, and a property missing from the list
 * changes in one frame while its neighbours ease.
 *
 * Compose it with {@link FOCUS_RING} (`components/ui/focus-ring`), the one
 * keyboard ring, and `outline-none`.
 */
export const PRESSABLE =
  'transition-[color,background-color,border-color,filter,transform] ' +
  '[transition-duration:var(--motion-quick),var(--motion-quick),var(--motion-quick),var(--motion-quick),var(--motion-snap)] ' +
  'ease-out active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100'

/**
 * The press for a control under ~24px: a checkbox, a radio. Two differences
 * from {@link PRESSABLE}, both from its size.
 *
 * - **The dip is 0.95, not 0.98.** The press is budgeted in pixels like the
 *   springs are: 0.98 of a 36px button is ~0.7px of give, and 0.98 of a 16px
 *   box is a third of a pixel, which nobody sees. 0.95 gives the small box
 *   the same ~1px a Button gets.
 * - **Everything runs on `--motion-snap`.** A small control's colour change IS
 *   its state flipping (the design language puts a checkbox tick on snap), so
 *   it lands with the press rather than trailing it.
 *
 * `box-shadow` stays out of the list: the keyboard ring is a box-shadow, and a
 * ring snaps. Compose with {@link FOCUS_RING} and `outline-none`.
 */
export const PRESSABLE_SMALL =
  'transition-[color,background-color,border-color,opacity,transform] duration-snap ease-out ' +
  'active:scale-95 motion-reduce:transition-none motion-reduce:active:scale-100'
