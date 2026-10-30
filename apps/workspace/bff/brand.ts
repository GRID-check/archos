import identity from '@/shared/brand/identity.json'

/**
 * The user-facing product name, read from the brand's one file.
 *
 * `packages/brand/identity.json` is the source; `node packages/brand/sync.mjs`
 * copies it to `apps/workspace/shared/brand/identity.json`, which this reads, so a rename is
 * one edit there and nothing here (ADR-0149). Use this constant for every
 * user-visible brand mention (wordmark, tab titles, aria labels); the
 * dictionaries say `{productName}` and get it from here (`withProductName`
 * below), and the agent's prompts read the same file (`agent.common.brand`).
 * `tests/test_product_name_parity.py` holds them equal and runs the rename drill.
 * No internal identifier carries a product name at all
 * (env vars, headers, CSS variables, storage keys, DB identifiers): the
 * `brand-names` ratchet holds that (docs/contributing/code-conventions.md#no-brand-names).
 */
export const PRODUCT_NAME: string = identity.name

const PRODUCT_NAME_TOKEN = /\{productName\}/g

/**
 * `dictionary` with `{productName}` replaced by the product's name in every
 * string. The copy never spells the name: the dictionary registry
 * (`i18n/dictionaries/index.ts`) applies this to both locales once, and a
 * module that carries only some namespaces (the MCP Apps view) applies it
 * itself. Here, beside the constant, so the module stays a leaf.
 */
export function withProductName<T>(dictionary: T): T {
  if (typeof dictionary === 'string') return dictionary.replace(PRODUCT_NAME_TOKEN, PRODUCT_NAME) as T
  if (Array.isArray(dictionary)) return dictionary.map(withProductName) as T
  if (dictionary && typeof dictionary === 'object') {
    return Object.fromEntries(
      Object.entries(dictionary).map(([key, value]) => [key, withProductName(value)]),
    ) as T
  }
  return dictionary
}

/**
 * The app icon's glyph for every place that draws it inline: the app's icon
 * rail and the PDF exports. The design system's logo is the wordmark alone, so
 * the icon is typographic: the product name's initial in Switzer Semibold,
 * outlined. `path` is the master's, character for character
 * (`packages/brand/mark.svg`, written by `packages/brand/build-brand-assets.mjs`
 * from `identity.json` and the font), which also writes the three lines below;
 * its `--check` fails when they drift. Do not edit them. `viewBox` crops the
 * master's 96-unit tile to the letter's ink box, so it sits flush in its box.
 * Plain data, no DOM: the PDF renderer imports it too.
 */
export const BRAND_MARK = {
  viewBox: '18.4 18 59.21 60',
  /** Width over height of the cropped glyph. */
  aspect: 59.21 / 60,
  path: 'M65.07 78L77.6 78L55.01 18L40.99 18L18.4 78L30.31 78L34.9 65.56L60.49 65.56ZM45.93 35.82L47.69 29.65L49.46 35.82L57.04 56.38L38.34 56.38Z',
} as const
