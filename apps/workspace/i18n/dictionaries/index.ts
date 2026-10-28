/**
 * The whole dictionary, every namespace in both locales.
 *
 * Only the checks that need every key at once read it (`key-coverage.spec.ts`
 * and the other specs in `i18n`). Product code imports the namespace it
 * translates from `@/i18n/namespaces/`, so a copy change re-runs the specs
 * that show that copy and no others (`aggregate-imports.spec.ts` holds the
 * line). `Dictionary` is derived from the English source, so it is the single
 * source of truth for the message shape; importing the type costs nothing.
 */

import { withProductName } from '@/lib/brand'
import { en as enSource } from './en'
import { de as deSource } from './de'
import type { Locale } from '../config'

// The copy says `{productName}`; the name goes in here, and in `defineNamespace` for each namespace.
const en = withProductName(enSource)
const de = withProductName(deSource)

/** The canonical message shape, derived from English. */
export type Dictionary = typeof en

export const dictionaries: Record<Locale, Dictionary> = { en, de }

export { en, de }
