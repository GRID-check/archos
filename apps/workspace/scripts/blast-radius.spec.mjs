// @vitest-environment node
/**
 * The blast-radius ratchet's arithmetic: who reaches what, and what fails.
 *
 * The graph itself is esbuild's; what is ours is counting the specs above each
 * module and deciding when a count is a regression. A ratchet that cannot fail
 * is decoration, so the failing cases are the ones pinned here.
 */
import { describe, expect, it } from 'vitest'
import {
  RECORD_FLOOR,
  THRESHOLD,
  baselineOf,
  ceilingOf,
  leavesOf,
  specReach,
  violations,
} from './blast-radius.mjs'

const input = (...imports) => ({
  imports: imports.map((path) => ({ path, kind: 'import-statement' })),
})

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

describe('leavesOf', () => {
  it('names the modules that import nothing of ours, and no spec', () => {
    const leaves = leavesOf({
      'src/a.spec.ts': input('src/hub.ts'),
      'src/hub.ts': input('src/leaf.ts'),
      'src/leaf.ts': { imports: [{ path: 'zod', kind: 'import-statement', external: true }] },
      'src/data.json': input(),
    })

    expect([...leaves].sort()).toEqual(['src/data.json', 'src/leaf.ts'])
  })
})

describe('violations', () => {
  it('fails a module that became a hub without being recorded, past the same slack a hub has', () => {
    const limit = ceilingOf(THRESHOLD)

    // Crossing the threshold by the few specs another pull request added is not a new hub.
    expect(violations({ 'src/new.ts': limit }, {})).toEqual([])
    expect(violations({ 'src/new.ts': limit + 1 }, {})).toEqual([
      `src/new.ts: a new hub, reached by ${limit + 1} specs (limit ${limit})`,
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

  it('lets every count grow with the suite, and holds the growth beyond it', () => {
    // A tenth more specs: a hub recorded at 500 may reach 550, and 605 with its slack.
    expect(violations({ 'src/hub.ts': 605 }, { 'src/hub.ts': 500 }, 1.1)).toEqual([])
    expect(violations({ 'src/hub.ts': 606 }, { 'src/hub.ts': 500 }, 1.1)).toHaveLength(1)
    expect(violations({ 'src/new.ts': ceilingOf(THRESHOLD * 1.1) }, {}, 1.1)).toEqual([])
  })
})

describe('baselineOf', () => {
  it('records every module from the floor up, so one just under the threshold has its slack', () => {
    expect(
      baselineOf({
        'src/b.ts': RECORD_FLOOR,
        'src/a.ts': THRESHOLD + 1,
        'src/leaf.ts': RECORD_FLOOR - 1,
      })
    ).toEqual({
      'src/a.ts': THRESHOLD + 1,
      'src/b.ts': RECORD_FLOOR,
    })
  })

  it('holds a recorded module to its own count, below where a new hub would fail', () => {
    const baseline = baselineOf({ 'src/near.ts': RECORD_FLOOR })
    const ceiling = ceilingOf(RECORD_FLOOR)

    expect(violations({ 'src/near.ts': ceiling }, baseline)).toEqual([])
    expect(violations({ 'src/near.ts': ceiling + 1 }, baseline)).toHaveLength(1)
  })
})
