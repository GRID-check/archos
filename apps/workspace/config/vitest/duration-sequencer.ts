/**
 * Shards the suite by recorded time, not by file count.
 *
 * Vitest's own `--shard` hashes the paths and cuts the list into equal
 * counts, so one shard drew 214 s of specs and another 115 s from the same
 * 259 files (CI, 2026-10-22), and the slowest shard is the frontend's time on
 * every pull request. This gives each file its time from
 * `tests/vitest-durations.json` (a file not in it counts at the median), takes
 * them longest first and hands each to the shard with the least time so far.
 * Every shard computes the same split from the same list, as pytest-split
 * does for the backend. Refresh the file with `task fe:test:durations`; a
 * stale one only unbalances the shards, it never drops a spec.
 */
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { BaseSequencer, type TestSpecification } from 'vitest/node'

function recorded(root: string): Record<string, number> {
  try {
    return JSON.parse(readFileSync(join(root, 'tests', 'vitest-durations.json'), 'utf8')) as Record<string, number>
  } catch {
    return {}
  }
}

function median(values: number[]): number {
  if (values.length === 0) return 1
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

export default class DurationSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { config } = this.ctx
    const { index, count } = config.shard!
    const times = recorded(config.root)
    const fallback = median(Object.values(times))
    const keyed = files.map((spec) => {
      const path = relative(config.root, spec.moduleId).replace(/\\/g, '/')
      return { spec, path, time: times[path] ?? fallback }
    })
    keyed.sort((a, b) => b.time - a.time || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    const loads = new Array<number>(count).fill(0)
    const mine: TestSpecification[] = []
    for (const { spec, time } of keyed) {
      let target = 0
      for (let shard = 1; shard < count; shard++) if (loads[shard] < loads[target]) target = shard
      loads[target] += time
      if (target === index - 1) mine.push(spec)
    }
    return mine
  }
}
