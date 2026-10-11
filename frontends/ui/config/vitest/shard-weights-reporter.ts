/**
 * Writes `shard-weights.json` (see `balanced-shards.ts`) from a run's per-file
 * diagnostics. Used by `task fe:test:weights` over CI's merged blob reports,
 * whose paths are the runner's: a path outside this root is keyed from the
 * root's last two directories on (`…/frontends/ui/src/a.spec.ts` →
 * `src/a.spec.ts`), so a `components/ui/` further down is not mistaken for it.
 */
import { writeFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import type { Reporter, TestModule } from 'vitest/node'
import { weightKey } from './balanced-shards'

const OUT = new URL('./shard-weights.json', import.meta.url)

export default class ShardWeightsReporter implements Reporter {
  onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
    const weights: Record<string, number> = {}
    for (const testModule of testModules) {
      const root = testModule.project.config.root
      let key = weightKey(root, testModule.moduleId)
      if (key.startsWith('../')) {
        const marker = `/${basename(dirname(root))}/${basename(root)}/`
        key = testModule.moduleId.slice(testModule.moduleId.indexOf(marker) + marker.length)
      }
      const d = testModule.diagnostic()
      const ms = d.environmentSetupDuration + d.prepareDuration + d.setupDuration + d.collectDuration + d.duration
      // Tenths of a second: precise enough to balance on, coarse enough that a
      // refresh does not rewrite every line for noise.
      weights[key] = Math.max(1, Math.round(ms / 100))
    }
    const sorted = Object.fromEntries(Object.entries(weights).sort(([a], [b]) => (a < b ? -1 : 1)))
    writeFileSync(OUT, `${JSON.stringify(sorted, null, 1)}\n`)
    console.log(`shard-weights.json: ${Object.keys(sorted).length} files`)
  }
}
