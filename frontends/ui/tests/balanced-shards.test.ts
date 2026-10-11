/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cutShards, weightKey } from '../config/vitest/balanced-shards'

const item = (key: string, weight: number) => ({ item: key, key, weight })

describe('balanced shards', () => {
  it('hands every file to exactly one shard', () => {
    const items = Array.from({ length: 101 }, (_, i) => item(`f${i}.spec.ts`, (i * 37) % 23))
    const shards = cutShards(items, 4)
    const all = shards.flat()
    expect(all.sort()).toEqual(items.map((i) => i.key).sort())
    expect(new Set(all).size).toBe(items.length)
  })

  it('cuts the same shards whatever order the files arrive in, as every runner must', () => {
    const items = [item('a', 5), item('b', 5), item('c', 3), item('d', 9), item('e', 1)]
    expect(cutShards([...items].reverse(), 2)).toEqual(cutShards(items, 2))
  })

  it('gives a heavy file a shard to itself rather than an equal count of files', () => {
    const items = [item('heavy', 100), ...Array.from({ length: 9 }, (_, i) => item(`light${i}`, 10))]
    const [first, second] = cutShards(items, 2)
    expect(first).toEqual(['heavy'])
    expect(second).toHaveLength(9)
  })

  it('keys a weight by the path under the root', () => {
    expect(weightKey('/repo/frontends/ui', '/repo/frontends/ui/src/a/b.spec.ts')).toBe('src/a/b.spec.ts')
  })

  // A path that no longer exists is ignored, not an error: deleting a spec must
  // not mean refreshing the table in the same commit.
  it('has a weight table of positive whole numbers', () => {
    const root = join(__dirname, '..')
    const weights = JSON.parse(readFileSync(join(root, 'config/vitest/shard-weights.json'), 'utf8')) as Record<string, number>
    expect(Object.keys(weights).length).toBeGreaterThan(0)
    for (const value of Object.values(weights)) expect(Number.isInteger(value) && value > 0).toBe(true)
  })
})
