#!/usr/bin/env node
/**
 * Copies the built brand files into each app, because neither app's Docker build sees
 * packages/. Each app target gets tokens.css, tokens.vars.css, components.css, fonts/ and
 * identity.json. The agent's package gets identity.json alone: `agent.common.brand` reads
 * the product's name from it. Last, it writes the name into the few files that must spell
 * it as a literal (`name-copies.mjs`), so a rename is one edit to identity.json.
 *
 *   node packages/brand/sync.mjs          build dist/, then write every target
 *   node packages/brand/sync.mjs --check  write nothing; exit 1 listing each stale or missing file
 *
 * The build runs in memory first, so --check also catches a dist/ or a target that
 * was not rebuilt after a source edit.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderDist, writeDist } from './build-tokens.mjs'
import { MARK_COPIES, NAME_COPIES, namedMark, withName } from './name-copies.mjs'

const BRAND = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(BRAND, '../..')
const TARGETS = ['apps/website/src/styles/brand', 'apps/workspace/shared/brand']
/** Targets that need the brand strings only: the Python agent ships no CSS or fonts. */
const IDENTITY_TARGETS = ['packages/agent/src/agent/common']

const toBuffer = (content) => (Buffer.isBuffer(content) ? content : Buffer.from(content))
const same = (a, b) => toBuffer(a).equals(toBuffer(b))

const dist = renderDist()
const identity = readFileSync(join(BRAND, 'identity.json'))
const shipped = new Map([...dist, ['identity.json', identity]])
/** Every copied file, as `[repo-relative path, content]`. */
const copies = [
  ...TARGETS.flatMap((target) => [...shipped].map(([rel, content]) => [`${target}/${rel}`, content])),
  ...IDENTITY_TARGETS.map((target) => [`${target}/identity.json`, identity]),
]

/** Each literal copy of the name as `[path, wanted content]`. A copy whose pattern is gone throws. */
function nameCopies() {
  const { name } = JSON.parse(identity.toString('utf8'))
  const mark = namedMark(readFileSync(join(BRAND, 'mark.svg'), 'utf8'), name)
  const present = (path) => existsSync(join(REPO, path))
  const literals = NAME_COPIES.filter(({ path }) => present(path)).map(({ path, pattern }) => {
    const wanted = withName(readFileSync(join(REPO, path), 'utf8'), pattern, name)
    if (wanted === null) throw new Error(`${path} no longer matches ${pattern} (packages/brand/name-copies.mjs)`)
    return [path, wanted]
  })
  return [...MARK_COPIES.filter(present).map((path) => [path, mark]), ...literals]
}

function check() {
  const problems = []
  for (const [rel, content] of dist) {
    const path = join(BRAND, 'dist', rel)
    if (!existsSync(path) || !same(readFileSync(path), content)) {
      problems.push(`packages/brand/dist/${rel} (run: node packages/brand/build-tokens.mjs)`)
    }
  }
  for (const [rel, content] of [...copies, ...nameCopies()]) {
    const path = join(REPO, rel)
    if (!existsSync(path) || !same(readFileSync(path), content)) problems.push(rel)
  }
  if (problems.length > 0) {
    console.error('brand copies are stale or missing (run: node packages/brand/sync.mjs):')
    for (const p of problems) console.error(`  ${p}`)
    process.exit(1)
  }
  console.log(`brand copies in sync (${copies.length} files, ${nameCopies().length} name copies)`)
}

function sync() {
  writeDist(dist)
  for (const [rel, content] of [...copies, ...nameCopies()]) {
    const path = join(REPO, rel)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  console.log(`wrote ${copies.length} brand files and the name into its literal copies`)
}

if (process.argv.includes('--check')) check()
else sync()
