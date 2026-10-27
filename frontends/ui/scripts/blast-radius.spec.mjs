// @vitest-environment node
/**
 * The blast-radius ratchet's arithmetic: who reaches what, and what fails.
 *
 * The graph itself is esbuild's; what is ours is counting the specs above each
 * module and deciding when a count is a regression. A ratchet that cannot fail
 * is decoration, so the failing cases are the ones pinned here.
 */
import { describe, expect, it } from 'vitest'
import { THRESHOLD, baselineOf, specReach, violations } from './blast-radius.mjs'

const input = (...imports) => ({ imports: imports.map((path) => ({ path, kind: 'import-statement' })) })

describe('specReach', () => {
  it('counts every spec above a module, through any number of importers', () => {
    const reach = specReach({
      'src/a.spec.ts': input('src/feature.ts'),
      'src/b.spec.tsx': input('src/hub.ts'),
      'src/feature.ts': input('src/hub.ts'),
      'src/hub.ts': input(),
    })

    expect(reach).toEqual({ 'src/feature.ts': 1, 'src/hub.ts': 2 })
  })

  it('ignores a package, which no change in this tree can move', () => {
    const reach = specReach({
      'src/a.spec.ts': { imports: [{ path: 'react', kind: 'import-statement', external: true }] },
    })

    expect(reach).toEqual({})
  })
})

describe('violations', () => {
  it('fails a module that became a hub without being recorded', () => {
    expect(violations({ 'src/new.ts': THRESHOLD }, {})).toEqual([
      `src/new.ts: a new hub, reached by ${THRESHOLD} specs (threshold ${THRESHOLD})`,
    ])
  })

  it('lets a hub grow by its slack, as new specs arrive, and fails it past that', () => {
    expect(violations({ 'src/hub.ts': 550 }, { 'src/hub.ts': 500 })).toEqual([])
    expect(violations({ 'src/hub.ts': 551 }, { 'src/hub.ts': 500 })).toEqual([
      'src/hub.ts: reached by 551 specs, was 500 (ceiling 550)',
    ])
  })

  it('passes a module below the threshold that nothing recorded', () => {
    expect(violations({ 'src/leaf.ts': THRESHOLD - 1 }, {})).toEqual([])
  })
})

describe('baselineOf', () => {
  it('records the hubs and nothing else', () => {
    expect(baselineOf({ 'src/b.ts': THRESHOLD, 'src/a.ts': THRESHOLD + 1, 'src/leaf.ts': 3 })).toEqual({
      'src/a.ts': THRESHOLD + 1,
      'src/b.ts': THRESHOLD,
    })
  })
})
