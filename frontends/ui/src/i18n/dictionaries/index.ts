/**
 * The whole dictionary, every namespace in both locales.
 *
 * Only the checks that need every key at once read it (`key-coverage.spec.ts`
 * and the other specs in `src/i18n`). Product code imports the namespace it
 * translates from `@/i18n/namespaces/`, so a copy change re-runs the specs
 * that show that copy and no others (`aggregate-imports.spec.ts` holds the
 * line). `Dictionary` is derived from the English source, so it is the single
 * source of truth for the message shape; importing the type costs nothing.
 */

import { en } from './en'
import { de } from './de'
import type { Locale } from '../config'

/** The canonical message shape, derived from English. */
export type Dictionary = typeof en

export const dictionaries: Record<Locale, Dictionary> = { en, de }

export { en, de }
