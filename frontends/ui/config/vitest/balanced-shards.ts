/**
 * CI's four test shards, cut by measured cost instead of by file count.
 *
 * Vitest's own `--shard` sorts the files by a hash of their path and hands each
 * shard an equal NUMBER of them. The files are anything but equal: on
 * 2026-10-11 one spec took 193s and the median under 2s, and each shard's
 * test step ranged from 149s to 261s on the same commit, so the slowest shard
 * was the critical path of every pull request. Measured cost is what has to
 * balance, not the count.
 *
 * The cost of a file is everything its worker spent on it: the environment,
 * the setup files, importing it (the AST coverage specs parse all of `src`
 * there) and its tests. `shard-weights.json` holds that, from CI's own blob
 * reports; `task fe:test:weights` rewrites it. A file it does not name yet (new
 * since the last refresh) counts as the median, so a stale table degrades to
 * roughly what Vitest did before, never to a broken run. Every shard computes
 * the same cut from the same file list, so no file runs twice or never.
 */
import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { BaseSequencer, type TestSpecification } from 'vitest/node'

const WEIGHTS_FILE = new URL('./shard-weights.json', import.meta.url)

function readWeights(): Record<string, number> {
  try {
    return JSON.parse(readFileSync(WEIGHTS_FILE, 'utf8')) as Record<string, number>
  } catch {
    return {}
  }
}

function median(values: number[]): number {
  if (values.length === 0) return 1
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

/** The `root`-relative POSIX path a weight is keyed by. */
export function weightKey(root: string, moduleId: string): string {
  return relative(root, moduleId).replace(/\\/g, '/')
}

/**
 * Longest-processing-time first: heaviest file to the lightest shard. Ties
 * break on the path, so the cut is the same on every runner.
 */
export function cutShards<T>(items: readonly { item: T; key: string; weight: number }[], count: number): T[][] {
  const ordered = [...items].sort((a, b) => b.weight - a.weight || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  const shards = Array.from({ length: count }, () => ({ load: 0, items: [] as T[] }))
  for (const { item, weight } of ordered) {
    const lightest = shards.reduce((min, shard) => (shard.load < min.load ? shard : min))
    lightest.items.push(item)
    lightest.load += weight
  }
  return shards.map((shard) => shard.items)
}

export default class BalancedSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { config } = this.ctx
    const { index, count } = config.shard!
    const weights = readWeights()
    const fallback = median(Object.values(weights))
    const items = files.map((spec) => {
      const key = weightKey(config.root, spec.moduleId)
      return { item: spec, key, weight: weights[key] ?? fallback }
    })
    return cutShards(items, count)[index - 1]
  }
}
