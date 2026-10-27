/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'

import moduleSeamsReporter, { cycleEdges, featureCycleFindings } from './module-seams-reporter.mjs'

/**
 * A dependency-cruiser module list from `from → to` pairs.
 * @param {Array<[string, string]>} pairs
 */
const graph = (pairs) => {
  /** @type {Map<string, string[]>} */
  const bySource = new Map()
  for (const [from, to] of pairs) bySource.set(from, [...(bySource.get(from) ?? []), to])
  return [...bySource].map(([source, targets]) => ({
    source,
    dependencies: targets.map((resolved) => ({ resolved })),
  }))
}

describe('cycleEdges', () => {
  it('collapses modules to features, so a cycle through different files of two features is one', () => {
    const modules = graph([
      ['src/features/chat/components/answer.tsx', 'src/features/documents/lib/names.ts'],
      ['src/features/documents/components/row.tsx', 'src/features/chat/index.ts'],
    ])
    expect([...cycleEdges(modules).keys()].sort()).toEqual(['chat → documents', 'documents → chat'])
  })

  it('finds a three-feature cycle with no mutual pair in it', () => {
    const modules = graph([
      ['src/features/a/x.ts', 'src/features/b/y.ts'],
      ['src/features/b/y.ts', 'src/features/c/z.ts'],
      ['src/features/c/z.ts', 'src/features/a/x.ts'],
    ])
    expect([...cycleEdges(modules).keys()].sort()).toEqual(['a → b', 'b → c', 'c → a'])
  })

  it('ignores a one-way edge, an edge inside one feature, and edges into lib/', () => {
    const modules = graph([
      ['src/features/a/x.ts', 'src/features/b/y.ts'],
      ['src/features/a/x.ts', 'src/features/a/lib/w.ts'],
      ['src/features/b/y.ts', 'src/lib/format.ts'],
      ['src/lib/format.ts', 'src/features/a/x.ts'],
    ])
    expect(cycleEdges(modules).size).toBe(0)
  })

  it('keeps one module edge as evidence for the feature edge', () => {
    const modules = graph([
      ['src/features/a/x.ts', 'src/features/b/y.ts'],
      ['src/features/b/y.ts', 'src/features/a/x.ts'],
    ])
    expect(cycleEdges(modules).get('a → b')).toBe('src/features/a/x.ts → src/features/b/y.ts')
  })
})

describe('featureCycleFindings', () => {
  const modules = graph([
    ['src/features/a/x.ts', 'src/features/b/y.ts'],
    ['src/features/b/y.ts', 'src/features/a/x.ts'],
  ])

  it('passes the edges the baseline lists', () => {
    const { added, stale } = featureCycleFindings(modules, ['a → b', 'b → a'])
    expect({ added, stale }).toEqual({ added: [], stale: [] })
  })

  it('fails a cycle edge the baseline does not list', () => {
    expect(featureCycleFindings(modules, ['a → b']).added).toEqual(['b → a'])
  })

  it('fails a baseline entry that no longer closes a cycle, so a fixed edge cannot come back', () => {
    expect(featureCycleFindings(modules, ['a → b', 'b → a', 'c → a']).stale).toEqual(['c → a'])
  })
})

describe('moduleSeamsReporter', () => {
  it("answers dependency-cruiser's plugin probe on an empty graph without reading the baseline", () => {
    const result = moduleSeamsReporter({
      modules: [],
      summary: { error: 0, info: 0, warn: 0, ignore: 0, totalCruised: 0, violations: [], optionsUsed: {} },
    })
    expect(result.exitCode).toBe(0)
  })
})
