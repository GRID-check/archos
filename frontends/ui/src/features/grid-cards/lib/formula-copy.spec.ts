/**
 * @vitest-environment node
 */

/**
 * Every key the formula card reads through a map resolves to a string in both
 * dictionaries. `i18n/key-coverage.spec.ts` checks literal `t('…')` calls
 * only, so this is the same guarantee for the keys `formula-copy.ts` holds.
 */

import { describe, expect, it } from 'vitest'
import { de } from '@/i18n/dictionaries/de'
import { en } from '@/i18n/dictionaries/en'
import { getByPath } from '@/i18n/translate'
import { FORMULA_KEY_MAPS } from './formula-copy'

const keys = Object.entries(FORMULA_KEY_MAPS).flatMap(([map, entries]) =>
  Object.values(entries).map((key) => [map, key] as const)
)

describe('the formula card’s key maps', () => {
  it.each(keys)('%s → %s resolves in en and de', (_map, key) => {
    expect(typeof getByPath(en.chat, key), `en.chat.${key}`).toBe('string')
    expect(typeof getByPath(de.chat, key), `de.chat.${key}`).toBe('string')
  })
})
