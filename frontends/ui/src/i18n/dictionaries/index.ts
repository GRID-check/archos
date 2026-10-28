/**
 * Dictionary registry.
 *
 * Both locales are bundled to the client (each is a few KB of plain strings),
 * which lets the language switcher swap copy instantly without a network
 * round-trip. `Dictionary` is derived from the English source so it is the
 * single source of truth for the message shape.
 *
 * The copy never spells the product's name: it says `{productName}`, and
 * `withProductName` (`lib/brand.ts`) puts `PRODUCT_NAME` in once, here,
 * so every reader of a dictionary gets the name.
 */

import { withProductName } from '@/lib/brand'
import { en as enSource } from './en'
import { de as deSource } from './de'
import type { Locale } from '../config'

const en = withProductName(enSource)
const de = withProductName(deSource)

/** The canonical message shape, derived from English. */
export type Dictionary = typeof en

export const dictionaries: Record<Locale, Dictionary> = { en, de }

export function getDictionary(locale: Locale): Dictionary {
  return dictionaries[locale] ?? en
}

export { en, de }
