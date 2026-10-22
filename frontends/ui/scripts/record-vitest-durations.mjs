#!/usr/bin/env node
/**
 * Writes tests/vitest-durations.json, the per-file times `duration-sequencer.ts`
 * shards by, from a vitest JSON report: `node scripts/record-vitest-durations.mjs <report.json>`.
 * `task fe:test:durations` runs the suite and this. Rounded to 10 ms to keep the
 * file's churn down; the split needs proportions, not precision.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = join(import.meta.dirname, '..')
const report = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const durations = {}
for (const file of report.testResults) {
  const path = relative(root, file.name).replace(/\\/g, '/')
  durations[path] = Math.max(10, Math.round((file.endTime - file.startTime) / 10) * 10)
}
const sorted = Object.fromEntries(Object.entries(durations).sort(([a], [b]) => (a < b ? -1 : 1)))
writeFileSync(join(root, 'tests', 'vitest-durations.json'), `${JSON.stringify(sorted, null, 1)}\n`)
console.log(`${Object.keys(sorted).length} files`)
