#!/usr/bin/env node
/**
 * Copies the built brand files into each app, because neither app's Docker build sees
 * packages/. Each target gets tokens.css, tokens.vars.css, components.css, fonts/ and identity.json.
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

const BRAND = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(BRAND, '../..')
const TARGETS = ['apps/website/src/styles/brand', 'apps/workspace/shared/brand']

const toBuffer = (content) => (Buffer.isBuffer(content) ? content : Buffer.from(content))
const same = (a, b) => toBuffer(a).equals(toBuffer(b))

const dist = renderDist()
const shipped = new Map([...dist, ['identity.json', readFileSync(join(BRAND, 'identity.json'))]])

function check() {
  const problems = []
  for (const [rel, content] of dist) {
    const path = join(BRAND, 'dist', rel)
    if (!existsSync(path) || !same(readFileSync(path), content)) {
      problems.push(`packages/brand/dist/${rel} (run: node packages/brand/build-tokens.mjs)`)
    }
  }
  for (const target of TARGETS) {
    for (const [rel, content] of shipped) {
      const path = join(REPO, target, rel)
      if (!existsSync(path) || !same(readFileSync(path), content)) {
        problems.push(`${target}/${rel}`)
      }
    }
  }
  if (problems.length > 0) {
    console.error('brand copies are stale or missing (run: node packages/brand/sync.mjs):')
    for (const p of problems) console.error(`  ${p}`)
    process.exit(1)
  }
  console.log(`brand copies in sync (${TARGETS.length} targets, ${shipped.size} files each)`)
}

function sync() {
  writeDist(dist)
  for (const target of TARGETS) {
    for (const [rel, content] of shipped) {
      const path = join(REPO, target, rel)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content)
    }
    console.log(`wrote ${target}`)
  }
}

if (process.argv.includes('--check')) check()
else sync()
