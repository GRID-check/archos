// @disk-inputs: bff/**
/**
 * @vitest-environment node
 */
/**
 * A wire module is a contract, nothing else (ADR-0055, ADR-0122).
 *
 * `lib/**\/*-wire.ts` holds the zod schema a route parses and the MCP catalog
 * describes, so the route, the agent surface and the browser read one shape.
 * That only works while the module stays pure: one import of the database
 * layer or of `server-only` and the browser can no longer share it, and every
 * spec that mocks `@/lib/db/schema` breaks on a constant it never asked for.
 * A tuple a schema needs lives in a vocabulary module the drizzle table also
 * imports (`lib/projects/memory-vocabulary.ts` is the pattern).
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const LIB = join(dirname(fileURLToPath(import.meta.url)), '..')

function wireModules(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...wireModules(path))
    else if (entry.name.endsWith('-wire.ts')) found.push(path)
  }
  return found
}

const FORBIDDEN = [/from '@\/lib\/db'/, /from '@\/lib\/db\/schema'/, /import 'server-only'/, /from '[^']*\/(service|repository)'/]

describe('wire modules', () => {
  it('import no database layer, service or server-only module', () => {
    const offenders = wireModules(LIB).flatMap((file) => {
      const source = readFileSync(file, 'utf8')
      return FORBIDDEN.filter((pattern) => pattern.test(source)).map(
        (pattern) => `${relative(LIB, file)}: ${pattern.source}`,
      )
    })
    expect(offenders).toEqual([])
  })
})
