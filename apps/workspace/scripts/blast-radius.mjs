#!/usr/bin/env node
/**
 * How many specs each module invalidates, held to a recorded baseline.
 *
 * A pull request runs the specs whose import graph reaches a changed file
 * (`vitest related`, ci/pr_selection.py). So the number of specs that reach a
 * module is what a one-line change to it costs CI, and a new edge from a hub
 * into a subtree raises it for every module in that subtree at once. Measured
 * in October 2026: half of all modules reached 64 specs or more, and a
 * dictionary string reached 720 of 1,610 (docs/audit/blast-radius-2026-10.md).
 *
 * The graph is esbuild's: it resolves the tsconfig paths and drops type-only
 * imports the way vitest's transform does, and builds all ~4,000 modules in a
 * few seconds. It counts a module a spec replaces with `vi.mock` too, so it
 * reads a little above `vitest related`, never below.
 *
 * The check fails when a module not in the baseline grows past THRESHOLD and
 * its slack (a new hub), or a baseline module grows past its recorded count and
 * its slack. The baseline records every module from RECORD_FLOOR up, and both
 * limits scale with the number of specs: a suite that grows by a tenth lets
 * every count grow by a tenth, so specs other pull requests add do not fail
 * this one. A count that drops is tightened on `--update`, and only there.
 *
 * A leaf, a module that imports nothing of ours, is held by neither rule. It
 * is as wide as whatever imports it, and an edge that widens it shows up on
 * that importer, which is not a leaf; there is nothing to cut in the leaf
 * itself (`lib/api/zod-union.ts`, `lib/diagrams/sketch-fence.ts`).
 *
 *   node scripts/blast-radius.mjs            check against the baseline
 *   node scripts/blast-radius.mjs --update   rewrite the baseline
 *   node scripts/blast-radius.mjs --top 30   print the 30 widest modules
 */
import { readFileSync, writeFileSync, globSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { build } from 'esbuild'

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE = path.join(UI, 'scripts', 'blast-radius.baseline.json')
/** A module reaching this many specs is a hub the baseline must name. */
export const THRESHOLD = 300
/** The baseline records modules from here up, so a module just below THRESHOLD is held by its slack instead. */
export const RECORD_FLOOR = 240
/** How far a hub may grow before the check fails: new specs arrive every week. */
export const SLACK = { ratio: 1.1, specs: 10 }

const SPEC = /\.(spec|test)\.tsx?$/

/** Every spec file vitest collects from TypeScript, relative to the UI root. */
function specFiles() {
  return globSync(['{app,bff,ui,i18n,shared,types,utils}/**/*.{spec,test}.{ts,tsx}', '*.{spec,test}.{ts,tsx}', 'tests/**/*.{spec,test}.{ts,tsx}'], { cwd: UI }).sort()
}

/** esbuild's view of the import graph: each input with the inputs it imports. */
async function importGraph(entryPoints) {
  const result = await build({
    absWorkingDir: UI,
    entryPoints,
    bundle: true,
    write: false,
    metafile: true,
    outdir: 'out',
    platform: 'node',
    format: 'esm',
    splitting: true,
    packages: 'external',
    logLevel: 'error',
    tsconfig: 'tsconfig.json',
    loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty', '.woff2': 'empty', '.md': 'text' },
  })
  return result.metafile.inputs
}

/** The modules that import nothing of ours: neither specs nor anything with an in-tree import. */
export function leavesOf(inputs) {
  return new Set(
    Object.entries(inputs)
      .filter(([file, { imports }]) => !SPEC.test(file) && imports.every((edge) => edge.external))
      .map(([file]) => file)
  )
}

/** For each module that is not a spec, how many specs reach it. */
export function specReach(inputs) {
  const importers = new Map()
  for (const [file, { imports }] of Object.entries(inputs)) {
    for (const edge of imports) {
      if (edge.external) continue
      if (!importers.has(edge.path)) importers.set(edge.path, [])
      importers.get(edge.path).push(file)
    }
  }
  const reach = {}
  for (const file of Object.keys(inputs)) {
    if (SPEC.test(file)) continue
    const seen = new Set([file])
    const queue = [file]
    while (queue.length) {
      for (const importer of importers.get(queue.pop()) ?? []) {
        if (!seen.has(importer)) {
          seen.add(importer)
          queue.push(importer)
        }
      }
    }
    reach[file] = [...seen].filter((name) => SPEC.test(name)).length
  }
  return reach
}

/** The most a count expected at `expected` may reach before it fails. */
export function ceilingOf(expected) {
  return Math.max(Math.ceil(expected * SLACK.ratio), Math.ceil(expected) + SLACK.specs)
}

/**
 * What breaks the ratchet, one line each. `scale` is the number of specs now
 * over the number the baseline was recorded with.
 */
export function violations(reach, baseline, scale = 1) {
  const found = []
  const newHub = ceilingOf(THRESHOLD * scale)
  for (const [file, count] of Object.entries(reach)) {
    const recorded = baseline[file]
    if (recorded === undefined) {
      if (count > newHub)
        found.push(`${file}: a new hub, reached by ${count} specs (limit ${newHub})`)
      continue
    }
    const ceiling = ceilingOf(recorded * scale)
    if (count > ceiling)
      found.push(`${file}: reached by ${count} specs, was ${recorded} (ceiling ${ceiling})`)
  }
  return found
}

/** The baseline to record: every module from RECORD_FLOOR up, at its current count. */
export function baselineOf(reach) {
  return Object.fromEntries(
    Object.entries(reach)
      .filter(([, count]) => count >= RECORD_FLOOR)
      .sort(([a], [b]) => a.localeCompare(b))
  )
}

async function main(argv) {
  const specs = specFiles()
  const inputs = await importGraph(specs)
  const everyReach = specReach(inputs)
  const topIndex = argv.indexOf('--top')
  if (topIndex !== -1) {
    const widest = Object.entries(everyReach).sort(([, a], [, b]) => b - a)
    for (const [file, count] of widest.slice(0, Number(argv[topIndex + 1] ?? 30)))
      console.log(`${count}\t${file}`)
    return 0
  }
  const leaves = leavesOf(inputs)
  const reach = Object.fromEntries(Object.entries(everyReach).filter(([file]) => !leaves.has(file)))
  if (argv.includes('--update')) {
    const modules = baselineOf(reach)
    const description =
      'Specs that reach each module reached by at least `recordFloor` specs, out of `specs`, read by apps/workspace/scripts/blast-radius.mjs. A module outside it fails at `threshold`. Rewrite with `task workspace:blast-radius -- --update` and say in the pull request why a hub grew. docs/audit/blast-radius-2026-10.md'
    writeFileSync(
      BASELINE,
      `${JSON.stringify({ description, threshold: THRESHOLD, recordFloor: RECORD_FLOOR, specs: specs.length, modules }, null, 1)}\n`
    )
    console.log(`recorded ${Object.keys(modules).length} modules over ${specs.length} specs`)
    return 0
  }
  const recorded = JSON.parse(readFileSync(BASELINE, 'utf8'))
  const found = violations(reach, recorded.modules, specs.length / recorded.specs)
  if (found.length === 0) {
    console.log(
      `blast radius: ${Object.keys(recorded.modules).length} modules within their baseline (${specs.length} specs)`
    )
    return 0
  }
  console.error(`blast radius grew (${found.length}):\n  ${found.join('\n  ')}`)
  console.error(
    '\nA change made a module invalidate more specs. Cut the edge that did it (a hub importing a subtree, a barrel),' +
      '\nor, when the growth is the point, run `task workspace:blast-radius -- --update` and say why in the pull request.'
  )
  return 1
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exit(await main(process.argv.slice(2)))
