/**
 * The German detector the English checks share, read from `ci/german_stems.json`
 * (the Python checks read the same file).
 *
 * - {@link germanIdentifierWords}: the words of an identifier that carry a German
 *   stem, for `english-names.spec.ts` (every name in code is English).
 * - {@link germanProseWords}: the German words in a sentence, for
 *   `lib/agent-api/english-only.spec.ts` (everything an agent reads is English).
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

const REPO_ROOT = path.resolve(__dirname, '../../../..')

interface GermanStems {
  stems: string[]
  prose_words: string[]
}

const LIST = JSON.parse(readFileSync(path.join(REPO_ROOT, 'ci', 'german_stems.json'), 'utf8')) as GermanStems

export const GERMAN_STEMS: readonly string[] = LIST.stems
const STEM = new RegExp(LIST.stems.join('|'))
const PROSE_WORDS = new Set(LIST.prose_words)
const UMLAUT = /[äöüÄÖÜß]/
const IDENTIFIER_WORDS = /[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+/g

/** The words of `identifier` that carry a German stem (`federalState` → [], `bundeslandId` → ['bundesland']). */
export function germanIdentifierWords(identifier: string): string[] {
  const words = identifier.split('_').flatMap((part) => part.match(IDENTIFIER_WORDS) ?? [])
  return words.map((word) => word.toLowerCase()).filter((word) => STEM.test(word))
}

/**
 * The German words of `text`: a word with an umlaut or ß, a word carrying a stem,
 * or a word of the prose list (`und`, `Aufgabe`, `Anmerkung`, …). Case-insensitive.
 */
export function germanProseWords(text: string): string[] {
  const words = text.match(/\p{L}+/gu) ?? []
  return words.filter((word) => {
    const lower = word.toLowerCase()
    return UMLAUT.test(word) || STEM.test(lower) || PROSE_WORDS.has(lower)
  })
}
