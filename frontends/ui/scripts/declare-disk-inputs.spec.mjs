// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { globMatcher, uncovered } from '../config/vitest/disk-inputs'
import { globsFor, withDeclaration } from './declare-disk-inputs.mjs'

describe('declare-disk-inputs', () => {
  it('declares a read directory as everything below it, and the loose files as themselves', () => {
    const reads = ['src/app', 'src/app/api/route.ts', 'src/app/x', 'drizzle/0001.sql', 'src/a/__snapshots__/s.snap']
    const directories = new Set(['src/app', 'src/app/x'])

    expect(globsFor(reads, (read) => directories.has(read))).toEqual(['drizzle/0001.sql', 'src/app/**'])
  })

  it('writes exactly one declaration, below an environment pragma', () => {
    const source = '// @vitest-environment node\n// @disk-inputs: old\nimport x from "y"\n'

    expect(withDeclaration(source, ['a/**', 'b.ts'])).toBe(
      '// @vitest-environment node\n// @disk-inputs: a/**, b.ts\nimport x from "y"\n',
    )
  })
})

describe('the disk-inputs check', () => {
  it('lets ** cross directories, dot-directories included, and * stay in one', () => {
    expect(globMatcher('src/**')('src/app/.well-known/route.ts')).toBe(true)
    expect(globMatcher('src/*.ts')('src/a/b.ts')).toBe(false)
    expect(globMatcher('src/app/(shell)/**')('src/app/(shell)/x.tsx')).toBe(true)
    expect(globMatcher('../../shared/wire/v2/**')('../../shared/wire/v2/turn.json')).toBe(true)
    expect(globMatcher('src/app/api/v1/[...path]/route.ts')('src/app/api/v1/[...path]/route.ts')).toBe(true)
    expect(globMatcher('src/app/api/v1/[...path]/route.ts')('src/app/api/v1/p/route.ts')).toBe(false)
    expect(globMatcher('drizzle/*.sql')('drizzle/0001_init.sql')).toBe(true)
    expect(globMatcher('src/**/route.ts')('src/route.ts')).toBe(true)
  })

  it('names every read outside the declaration, and counts a directory read covered by a glob inside it', () => {
    expect(uncovered(['src/a.ts', 'src/app', 'docs/x.md'], ['src/a.ts', 'src/app/**'])).toEqual(['docs/x.md'])
  })
})
