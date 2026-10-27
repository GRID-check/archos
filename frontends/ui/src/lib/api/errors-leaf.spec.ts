/**
 * @vitest-environment node
 */

/**
 * `errors.ts` stays a leaf.
 *
 * Nearly every service throws its errors, so about 850 specs reach it, and
 * every module it imports for a value is re-run with all of them: the request
 * body limit was, for one constant (docs/audit/blast-radius-2026-10.md §7.3).
 * A type import costs nothing; the transform drops it.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BYTES_PER_MB } from '@/shared/config/request-body-limit'
import { formatMegabytes } from './errors'

/** The modules a file in this directory imports for a value. */
function valueImports(file: string): string[] {
  const source = readFileSync(join(__dirname, file), 'utf8')
  return [...new Set([...source.matchAll(/^(?:import|export)\s+(?!type\b)[^']*?from\s+'([^']+)'/gm)].map((match) => match[1]))]
}

describe('lib/api/errors.ts', () => {
  it('imports nothing but types and its import-free base', () => {
    expect(valueImports('errors.ts'), 'Move the code that needs the import out of errors.ts, or redeclare the constant').toEqual([
      './api-error',
    ])
    expect(valueImports('api-error.ts')).toEqual([])
  })

  it('counts a megabyte the way the request body limit does', () => {
    expect(formatMegabytes(BYTES_PER_MB)).toBe('1')
  })
})
