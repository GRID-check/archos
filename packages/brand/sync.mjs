#!/usr/bin/env node
/**
 * Copies the built brand files into each app, because neither app's Docker build sees
 * packages/. Each target gets only the layer it reads:
 *
 *   website    tokens.css (shared tokens only), components.css, fonts/, identity.json
 *   workspace  tokens.vars.css (shared and app-scoped tokens as --ds-*), fonts/, identity.json
 *
 * so the app's shadows and radius ladder never reach the website, and the website's
 * component CSS never sits unused in the app.
 *
 *   node packages/brand/sync.mjs          build dist/, then write every target (and delete
 *                                         files a target no longer receives)
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

const BRAND = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(BRAND, '../..')

/** What each app receives. `fonts/` stands for every file under dist/fonts. */
export const TARGETS = [
  { dir: 'apps/website/src/styles/brand', files: ['tokens.css', 'components.css', 'fonts/', 'identity.json'] },
  { dir: 'apps/workspace/shared/brand', files: ['tokens.vars.css', 'fonts/', 'identity.json'] },
]

const toBuffer = (content) => (Buffer.isBuffer(content) ? content : Buffer.from(content))
const same = (a, b) => toBuffer(a).equals(toBuffer(b))

const dist = renderDist()
const all = new Map([...dist, ['identity.json', readFileSync(join(BRAND, 'identity.json'))]])

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

/** Files in a target that it no longer receives (a layer it must not carry). */
function extras(target, shipped) {
  const root = join(REPO, target.dir)
  return filesIn(root).filter((path) => !shipped.has(relative(root, path).split('\\').join('/')))
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
  if (problems.length > 0) {
    console.error('brand copies are stale, missing or unexpected (run: node packages/brand/sync.mjs):')
    for (const p of problems) console.error(`  ${p}`)
    process.exit(1)
  }
  const counts = TARGETS.map((t) => `${t.dir} ${shippedTo(t).size}`).join(', ')
  console.log(`brand copies in sync (${counts} files)`)
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
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) check()
  else sync()
}
