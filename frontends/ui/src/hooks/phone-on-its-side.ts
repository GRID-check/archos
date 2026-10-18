/**
 * A phone held sideways: a finger, at most 500px tall, narrower than `lg`.
 *
 * Its own module so a plain function (a store, a width default) can ask the
 * question without importing the React hook beside it. `use-is-mobile.ts`
 * re-exports it, and `breakpoints.spec.ts` holds it equal to the `phone` and
 * `md` variants in `globals.css`.
 */
export const PHONE_ON_ITS_SIDE_QUERY = '(pointer: coarse) and (height <= 31.25rem) and (width < 64rem)'
