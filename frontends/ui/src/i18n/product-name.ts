/**
 * The copy never spells the product's name: a dictionary string says
 * `{productName}`, and `withProductName` puts `PRODUCT_NAME` in. The registry
 * (`dictionaries/index.ts`) applies it to both locales once, so every reader
 * of a dictionary gets the name and a rename is one constant. A module that
 * imports a locale's namespace file directly, to carry less than the whole
 * dictionary, applies it itself.
 */

import { PRODUCT_NAME } from '@/lib/brand'

const PRODUCT_NAME_TOKEN = /\{productName\}/g

/** `dictionary` with `{productName}` replaced by the product's name in every string. */
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
