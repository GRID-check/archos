/**
 * @vitest-environment node
 */

/**
 * Nothing outside `src/i18n` imports the whole dictionary.
 *
 * A pull request runs the specs whose import graph reaches a changed file. When
 * every component reached the aggregate (`dictionaries/index.ts`, `en/index.ts`,
 * `de/index.ts`), a one-word copy change re-ran about 590 specs; with each
 * caller importing its namespace from `@/i18n/namespaces/`, a change to
 * `en/chat.ts` re-runs the specs that render chat copy
 * (docs/audit/blast-radius-2026-10.md §7.1). One value import of the aggregate
 * in a widely imported module undoes that for every namespace at once. A type
 * import is free: the transform drops it.
 */

import { readFileSync, globSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** Files that read every namespace on purpose, and why. */
const ALLOWED: Record<string, string> = {
  'src/lib/navigation/describe-path.spec.ts':
    'checks that every label the path describer can return resolves, across the namespaces it names',
}

const AGGREGATE = /^import\s+(?!type\b)[^']*?from\s+'(?:@\/i18n|\.{1,2}(?:\/\.\.)*)\/dictionaries(?:\/(?:en|de))?'/m

describe('the aggregate dictionary', () => {
  it('is imported for its values only inside src/i18n', () => {
    const offenders = globSync('{src,tests}/**/*.{ts,tsx}')
      .filter((file) => !file.startsWith('src/i18n/') && !(file in ALLOWED))
      .filter((file) => AGGREGATE.test(readFileSync(file, 'utf8')))
    expect(
      offenders,
      "Import the namespace instead: `import { chatCopy } from '@/i18n/namespaces/chat'`, then " +
        "`useTranslations(chatCopy)`, `translatorFor(chatCopy, locale)` or `chatCopy.messages[locale]`.",
    ).toEqual([])
  })

  it('still catches a value import', () => {
    expect(AGGREGATE.test("import { en } from '@/i18n/dictionaries/en'")).toBe(true)
    expect(AGGREGATE.test("import { de, en } from '@/i18n/dictionaries'")).toBe(true)
    expect(AGGREGATE.test("import type { Dictionary } from '@/i18n/dictionaries'")).toBe(false)
    expect(AGGREGATE.test("import { chat } from '@/i18n/dictionaries/en/chat'")).toBe(false)
    expect(AGGREGATE.test("import { a } from './a'\nimport type { Dictionary } from '@/i18n/dictionaries'")).toBe(false)
  })
})
