/**
 * The dictionaries an MCP Apps view carries (ADR-0142): the namespaces its
 * card reads (`chat` for the receipts, `common` and `nav` for the atoms), in
 * both languages, instead of all of Piloti's (~850 KB of the view's bundle).
 * `scripts/build-mcp-app-views.ts` resolves `src/i18n`'s `./dictionaries` to
 * this file for the views only; Piloti's own pages are unchanged.
 *
 * A key outside these namespaces would read as its own path in the card, never
 * as a wrong word: `proposal-card/vocabulary.spec.tsx` draws every card the
 * view draws with this module, in both languages, and fails on a key it does
 * not hold.
 */

import type { Locale } from '@/i18n/config'
import type { Dictionary } from '@/i18n/dictionaries'
import { chat as enChat } from '@/i18n/dictionaries/en/chat'
import { common as enCommon } from '@/i18n/dictionaries/en/common'
import { nav as enNav } from '@/i18n/dictionaries/en/nav'
import { chat as deChat } from '@/i18n/dictionaries/de/chat'
import { common as deCommon } from '@/i18n/dictionaries/de/common'
import { nav as deNav } from '@/i18n/dictionaries/de/nav'

/** The namespaces a view reads; `proposal-card/vocabulary.spec.tsx` holds the card to them. */
export const VIEW_NAMESPACES = ['chat', 'common', 'nav'] as const

export const en = { chat: enChat, common: enCommon, nav: enNav } as unknown as Dictionary
export const de = { chat: deChat, common: deCommon, nav: deNav } as unknown as Dictionary

export const dictionaries: Record<Locale, Dictionary> = { en, de }

export function getDictionary(locale: Locale): Dictionary {
  return dictionaries[locale] ?? en
}
