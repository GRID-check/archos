/**
 * Single source of truth for the user-facing product brand.
 *
 * The product ships user-facing as **Piloti**, and the name will change again.
 * Use this constant for every user-visible brand mention (wordmark, tab
 * titles, aria labels). No internal identifier carries a product name at all
 * (env vars, headers, CSS variables, storage keys, DB identifiers): the
 * `brand-names` ratchet holds that (docs/contributing/code-conventions.md#no-brand-names).
 */
export const PRODUCT_NAME = 'Piloti'

/**
 * The Piloti mark (the column) for every place that draws it inline: the app's
 * logo and the PDF exports. `path` is the master's, character for character
 * (`shared/brand/piloti-mark.svg`); `npm run check` in `frontends/web` fails when
 * it drifts. `viewBox` crops the master's 32-unit tile to the column itself, so
 * the mark sits flush against a wordmark. Plain data, no DOM: the PDF renderer
 * imports it too.
 */
export const BRAND_MARK = {
  viewBox: '6 4 20 24',
  /** Width over height of the cropped mark. */
  aspect: 20 / 24,
  path: 'M16 4H10A4 4 0 0 0 6 8A4 4 0 0 0 10 12V10A2 2 0 0 1 8 8A2 2 0 0 1 10 6A2 2 0 0 1 12 8V24H20V8A2 2 0 0 1 22 6A2 2 0 0 1 24 8A2 2 0 0 1 22 10V12A4 4 0 0 0 26 8A4 4 0 0 0 22 4ZM8 26H24V28H8Z',
} as const
