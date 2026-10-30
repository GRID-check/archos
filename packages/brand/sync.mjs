#!/usr/bin/env node
/**
 * Copies the built brand files into each reader, because neither app's Docker build sees
 * packages/. Each target gets only the layer it reads:
 *
 *   website    tokens.css (shared tokens only), components.css, fonts/, identity.json
 *   workspace  tokens.vars.css (shared and app-scoped tokens as --ds-*), fonts/, identity.json
 *   agent      identity.json alone, which `agent.common.brand` reads the product's name from
 *
 * so the app's shadows and radius ladder never reach the website, and the website's
 * component CSS never sits unused in the app. Last, it writes the product's name into the
 * few files that must spell it as a literal (`name-copies.mjs`: the service worker's
 * fallback title, the icons' SVG <title>), so a rename is one edit to identity.json.
 *
 *   node packages/brand/sync.mjs          build dist/, then write every target (and delete
 *                                         files a brand-owned target no longer receives)
 *   node packages/brand/sync.mjs --check  write nothing; exit 1 listing each stale, missing
 *                                         or unexpected file
 *
 * The build runs in memory first, so --check also catches a dist/ or a target that
 * was not rebuilt after a source edit.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderDist, writeDist } from './build-tokens.mjs'
import { MARK_COPIES, NAME_COPIES, namedMark, withName } from './name-copies.mjs'

const BRAND = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(BRAND, '../..')

/**
 * What each reader receives. `fonts/` stands for every file under dist/fonts.
 * `shared: true` marks a directory the brand does not own (a Python package): the sync
 * writes its files there and never deletes anything else in it.
 */
export const TARGETS = [
  { dir: 'apps/website/src/styles/brand', files: ['tokens.css', 'components.css', 'fonts/', 'identity.json'] },
  { dir: 'apps/workspace/shared/brand', files: ['tokens.vars.css', 'fonts/', 'identity.json'] },
  { dir: 'packages/agent/src/agent/common', files: ['identity.json'], shared: true },
]

const toBuffer = (content) => (Buffer.isBuffer(content) ? content : Buffer.from(content))
const same = (a, b) => toBuffer(a).equals(toBuffer(b))

const dist = renderDist()
const identity = readFileSync(join(BRAND, 'identity.json'))
const all = new Map([...dist, ['identity.json', identity]])

/** The files one target receives, keyed by the path under the target directory. */
function shippedTo(target) {
  const wanted = (rel) => target.files.some((f) => (f.endsWith('/') ? rel.startsWith(f) : rel === f))
  return new Map([...all].filter(([rel]) => wanted(rel)))
}

function filesIn(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? filesIn(path) : [path]
  })
}

/** Files in a brand-owned target that it no longer receives (a layer it must not carry). */
function extras(target, shipped) {
  if (target.shared) return []
  const root = join(REPO, target.dir)
  return filesIn(root).filter((path) => !shipped.has(relative(root, path).split('\\').join('/')))
}

/** Each literal copy of the name as `[repo path, wanted content]`. A copy whose pattern is gone throws. */
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
  for (const target of TARGETS) {
    const shipped = shippedTo(target)
    for (const [rel, content] of shipped) {
      const path = join(REPO, target.dir, rel)
      if (!existsSync(path) || !same(readFileSync(path), content)) problems.push(`${target.dir}/${rel}`)
    }
    for (const path of extras(target, shipped)) problems.push(`${relative(REPO, path)} (not part of this target's layer)`)
  }
  const names = nameCopies()
  for (const [rel, content] of names) {
    const path = join(REPO, rel)
    if (!existsSync(path) || !same(readFileSync(path), content)) problems.push(`${rel} (the product's name)`)
  }
  if (problems.length > 0) {
    console.error('brand copies are stale, missing or unexpected (run: node packages/brand/sync.mjs):')
    for (const p of problems) console.error(`  ${p}`)
    process.exit(1)
  }
  const counts = TARGETS.map((t) => `${t.dir} ${shippedTo(t).size}`).join(', ')
  console.log(`brand copies in sync (${counts} files; ${names.length} name copies)`)
}

function sync() {
  writeDist(dist)
  for (const target of TARGETS) {
    const shipped = shippedTo(target)
    for (const [rel, content] of shipped) {
      const path = join(REPO, target.dir, rel)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content)
    }
    for (const path of extras(target, shipped)) {
      rmSync(path)
      console.log(`removed ${relative(REPO, path)}`)
    }
    console.log(`wrote ${target.dir}`)
  }
  for (const [rel, content] of nameCopies()) writeFileSync(join(REPO, rel), content)
  console.log('wrote the product name into its literal copies')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) check()
  else sync()
}
