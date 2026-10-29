import identity from '@/shared/brand/identity.json'

/**
 * The user-facing product name, read from the brand's one file.
 *
 * `packages/brand/identity.json` is the source; `node packages/brand/sync.mjs`
 * copies it to `apps/workspace/shared/brand/identity.json`, which this reads, so a rename is
 * one edit there and nothing here (ADR-0148). Use this constant for every
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
 * The product's mark (the column) for every place that draws it inline: the app's
 * logo and the PDF exports. `path` is the master's, character for character
 * (`packages/brand/mark.svg`); `npm run check` in `apps/site` fails when
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
