#!/usr/bin/env node
/**
 * Write (or rewrite) the `// @disk-inputs:` line of the specs that read the
 * tree from disk, from what each one actually read in a recorded run.
 *
 *   node scripts/declare-disk-inputs.mjs                 # every tree-reading spec
 *   node scripts/declare-disk-inputs.mjs src/a.spec.ts   # just these
 *
 * The line is what `ci/pr_selection.py` selects on, and
 * `config/vitest/disk-inputs.ts` fails a spec that reads outside it. Run this
 * when that check names a path, then read the new line before committing it:
 * a walker that reads a whole directory is declared as `dir/**`, which is
 * correct and also the widest it can be.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const UI = path.resolve(import.meta.dirname, '..')
const OUT = path.join(UI, '.disk-inputs')
// The same test `ci/pr_selection.py` uses to find a spec that reads the tree.
export const READS_DISK =
  /from ['"](?:node:)?fs(?:\/promises)?['"]|require\(['"](?:node:)?fs|readdirSync|readFileSync|globSync/
// A spec that starts a process: what the child reads, the recorder never sees.
const SPAWNS = /['"](?:node:)?child_process['"]/
const SPEC = /\.(spec|test)\.(ts|tsx|mjs)$/
const LINE = /^\s*\/\/\s*@disk-inputs:.*\n/gm
// Past this many inputs a spec reads (nearly) the whole tree, from a file list
// rather than a directory walk, and a declaration would buy no selection: it
// keeps running on every selection, undeclared.
const MOST_INPUTS = 60

function specsReadingDisk() {
  const found = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (['node_modules', '.next', 'coverage', '.disk-inputs', 'mocks'].includes(name)) continue
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (SPEC.test(name) && READS_DISK.test(readFileSync(full, 'utf8'))) found.push(path.relative(UI, full))
    }
  }
  for (const root of ['src', 'tests', 'purger', 'scheduler', 'observability', 'workers', 'scripts', 'eslint-rules']) {
    if (existsSync(path.join(UI, root))) walk(path.join(UI, root))
  }
  return found.sort()
}

/** The fewest globs that cover every read: a directory that was read covers everything below it. */
export function globsFor(reads, isDirectory) {
  const directories = reads.filter(isDirectory).sort((a, b) => a.length - b.length)
  const kept = []
  for (const dir of directories) if (!kept.some((top) => dir === top || dir.startsWith(`${top}/`))) kept.push(dir)
  const under = (read) => kept.some((dir) => read === dir || read.startsWith(`${dir}/`))
  const files = reads.filter((read) => !under(read) && !/(^|\/)__snapshots__\//.test(read))
  return [...kept.map((dir) => `${dir}/**`), ...files].sort()
}

/** The spec's source with exactly one declaration, after any leading shebang or environment pragma. */
export function withDeclaration(source, globs) {
  const bare = source.replace(LINE, '')
  const line = `// @disk-inputs: ${globs.join(', ')}\n`
  const lines = bare.split('\n')
  let at = 0
  while (at < lines.length && /^(#!|\/\/\s*@vitest-environment|\/\*\*?\s*@vitest-environment.*\*\/\s*$)/.test(lines[at])) at++
  lines.splice(at, 0, line.trimEnd())
  return lines.join('\n')
}

function main(argv) {
  const specs = argv.length ? argv : specsReadingDisk()
  rmSync(OUT, { recursive: true, force: true })
  execFileSync('bunx', ['vitest', 'run', ...specs], {
    cwd: UI,
    stdio: 'inherit',
    env: { ...process.env, DISK_INPUTS: 'record' },
  })
  let written = 0
  for (const spec of specs) {
    const record = path.join(OUT, `${spec.replaceAll('/', '__')}.json`)
    if (!existsSync(record)) {
      console.warn(`no record for ${spec} (did it run?)`)
      continue
    }
    const { reads } = JSON.parse(readFileSync(record, 'utf8'))
    const isDirectory = (read) => existsSync(path.join(UI, read)) && statSync(path.join(UI, read)).isDirectory()
    const globs = globsFor(reads, isDirectory)
    const file = path.join(UI, spec)
    const spawns = SPAWNS.test(readFileSync(file, 'utf8'))
    if (spawns || !globs.length || globs.length > MOST_INPUTS) {
      const why = spawns
        ? 'starts a process'
        : globs.length
          ? `read ${globs.length} inputs`
          : 'read nothing from the tree'
      console.warn(`${spec} ${why}; it stays undeclared and runs on every selection`)
      writeFileSync(file, readFileSync(file, 'utf8').replace(LINE, ''))
      continue
    }
    writeFileSync(file, withDeclaration(readFileSync(file, 'utf8'), globs))
    written++
  }
  rmSync(OUT, { recursive: true, force: true })
  console.log(`declared the disk inputs of ${written} of ${specs.length} specs`)
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2))
