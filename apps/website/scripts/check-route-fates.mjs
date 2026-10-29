#!/usr/bin/env node
/**
 * Every old address answers its route fate on the built server.
 *
 *   bun run build && bun run check:routes
 *
 * Serves `dist/` with the production server (`runtime/server.mjs`) on a free port and asks
 * it for every row of `redirects.mjs` (`ROUTE_FATES`), each with and without its trailing
 * slash, plus old aliases the rows do not spell out (`/de/...`, `/en/<German segment>/...`):
 *   - a 301 row must answer 301 with the row's target, and the target must answer 200
 *     (one hop: the target is a page, never another redirect);
 *   - a Gone row must answer 410 with the not-found view's "no longer exists" heading.
 * A target that other work adds (`PENDING_TARGETS`, empty now) is reported, not failed,
 * while it still answers 404. Fails on anything else.
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { PENDING_TARGETS, ROUTE_FATES, fateOf } from '../redirects.mjs'

/** Aliases resolved by `fateOf` at request time, with the fate each must reach. */
const ALIAS_SAMPLES = [
  ['/de/kontakt/', '/kontakt/'],
  ['/de/datensicherheit/', '/datensicherheit/'],
  ['/de/blog/chatgpt-baurecht/', '/blog/chatgpt-baurecht/'],
  ['/de/glossar/ris/', '/baurecht/'],
  ['/de/bildmaterial/alle.zip', 'gone'],
  ['/bildmaterial/feld.zip', 'gone'],
  ['/en/bildmaterial/', 'gone'],
]

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

async function waitFor(url, attempts = 50) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      if ((await fetch(url)).ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`${url} did not answer`)
}

const port = await freePort()
const base = `http://127.0.0.1:${port}`
const server = spawn(process.execPath, [fileURLToPath(new URL('../runtime/server.mjs', import.meta.url))], {
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), PUBLIC_POSTHOG_HOST: '', PUBLIC_POSTHOG_PROJECT_TOKEN: '' },
  stdio: 'ignore',
})

const problems = []
const pending = new Set()
const targetStatus = new Map()
let checked = 0

async function statusOf(path) {
  if (!targetStatus.has(path)) targetStatus.set(path, (await fetch(`${base}${path}`, { redirect: 'manual' })).status)
  return targetStatus.get(path)
}

async function expect(path, fate) {
  checked += 1
  const response = await fetch(`${base}${path}`, { redirect: 'manual' })
  if (fate === 'gone') {
    const body = await response.text()
    if (response.status !== 410) problems.push(`${path}: ${response.status}, expected 410`)
    else if (!/gibt es nicht mehr|no longer exists/.test(body)) problems.push(`${path}: 410 without the gone page`)
    return
  }
  const location = response.headers.get('location')
  const target = location && new URL(location, base).pathname
  if (response.status !== 301) return problems.push(`${path}: ${response.status}, expected 301 to ${fate}`)
  if (target !== fate) return problems.push(`${path}: 301 to ${target}, expected ${fate}`)
  const status = await statusOf(target)
  if (status === 200) return
  if (status === 404 && PENDING_TARGETS.has(target)) return pending.add(target)
  problems.push(`${path}: target ${target} answers ${status}, expected 200 (one hop)`)
}

try {
  await waitFor(`${base}/healthz`)
  for (const [from, to] of ROUTE_FATES) {
    await expect(from, to)
    await expect(`${from}/`, to)
  }
  for (const [path, fate] of ALIAS_SAMPLES) {
    const expected = fateOf(path)
    const want = fate === 'gone' ? { status: 410 } : { status: 301, location: fate }
    if (JSON.stringify(expected) !== JSON.stringify(want)) problems.push(`fateOf(${path}) is ${JSON.stringify(expected)}, expected ${JSON.stringify(want)}`)
    await expect(path, fate)
  }
} finally {
  server.kill()
}

for (const target of pending) console.warn(`pending: ${target} answers 404 until the work that adds it is merged`)
if (problems.length > 0) {
  console.error(`route fates: ${problems.length} problem(s) of ${checked} requests`)
  for (const p of problems) console.error(`  ${p}`)
  process.exit(1)
}
console.log(`route fates hold: ${checked} old addresses answer 301 in one hop to a page, or 410`)
