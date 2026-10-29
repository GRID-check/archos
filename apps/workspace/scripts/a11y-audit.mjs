#!/usr/bin/env node
/**
 * Accessibility audit of the /dev preview routes: axe-core with the WCAG 2.0,
 * 2.1 and 2.2 level A and AA rule sets, light and dark, desktop and phone.
 *
 *   bun run a11y                     every /dev route; starts its own `next dev`
 *   bun run a11y -- /dev/atoms       only the routes named
 *   bun run a11y -- --shard 2/4      the second quarter of the routes (CI runs four)
 *   A11Y_BASE_URL=http://localhost:3001 bun run a11y   use a dev server that is already running
 *   A11Y_CHROME=/path/to/chrome      a Chrome or Chromium binary (default: Playwright's own,
 *                                    `bunx playwright-core install chromium`)
 *   A11Y_CONCURRENCY=3               routes audited at once
 *
 * The routes are every `app/dev/**\/page.tsx`, so a new preview is audited
 * without an edit here: an optional catch-all segment is left out and a dynamic
 * one takes `DYNAMIC_SEGMENT_SAMPLE`. The previews render real components from
 * fixtures, so the audit needs no backend; the dev server it starts gets
 * placeholder WorkOS settings (AuthKit's middleware refuses to boot without
 * them) and never signs anyone in. The /dev layout 404s outside development,
 * which is why this runs against `next dev` and not a production build.
 *
 * Exits 1 on any violation not listed in `scripts/a11y-baseline.json`, and on a
 * baseline entry that no longer occurs, so the list only shrinks. Disabled
 * controls are exempt, as WCAG 2.2 SC 1.4.3 says ("inactive user interface
 * components"): axe skips them in `color-contrast` itself.
 * `--write-baseline` records the current violations instead of failing.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { chromium } from 'playwright-core'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = join(here, '..')
const require = createRequire(import.meta.url)
const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8')
const BASELINE = join(here, 'a11y-baseline.json')
const DEV_DIR = join(appRoot, 'app', 'dev')

/** What a dynamic `[segment]` of a preview route is filled with. */
const DYNAMIC_SEGMENT_SAMPLE = 'overview'
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']
const VIEWPORTS = [
  { name: '1440', width: 1440, height: 900 },
  { name: '390', width: 390, height: 844 },
]
const CONCURRENCY = Math.max(1, Number(process.env.A11Y_CONCURRENCY ?? 3))

/** Every /dev preview route, from the pages on disk. */
function previewRoutes() {
  const routes = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name))
      else if (entry.name === 'page.tsx') {
        const segments = relative(join(appRoot, 'app'), dir)
          .split(sep)
          .filter((segment) => !/^\[\[\.\.\..+\]\]$/.test(segment) && !/^\(.+\)$/.test(segment))
          .map((segment) => (/^\[.+\]$/.test(segment) ? DYNAMIC_SEGMENT_SAMPLE : segment))
        routes.push(`/${segments.join('/')}`)
      }
    }
  }
  walk(DEV_DIR)
  return [...new Set(routes)].sort()
}

function parseArgs(argv) {
  const named = argv.filter((a) => a.startsWith('/'))
  const shardAt = argv.indexOf('--shard')
  const shard = shardAt >= 0 ? argv[shardAt + 1] : undefined
  const match = shard ? /^(\d+)\/(\d+)$/.exec(shard) : null
  if (shard && (!match || Number(match[1]) < 1 || Number(match[1]) > Number(match[2]))) {
    throw new Error(`--shard takes i/n with 1 <= i <= n, got ${shard}`)
  }
  return {
    named,
    shard: match ? { index: Number(match[1]), total: Number(match[2]) } : undefined,
    writeBaseline: argv.includes('--write-baseline'),
  }
}

/** Routes `i` of `n`: every n-th, so slow and fast directories spread over the shards. */
const inShard = (routes, shard) => (shard ? routes.filter((_, i) => i % shard.total === shard.index - 1) : routes)

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })

/** `next dev` on a free port, with placeholder WorkOS settings where none are set. */
async function startDevServer() {
  const port = await freePort()
  const origin = `http://localhost:${port}`
  const placeholder = {
    WORKOS_CLIENT_ID: 'client_a11y_audit',
    WORKOS_API_KEY: 'a11y-audit-placeholder',
    WORKOS_REDIRECT_URI: `${origin}/api/auth/callback`,
    NEXT_PUBLIC_WORKOS_REDIRECT_URI: `${origin}/api/auth/callback`,
    WORKOS_COOKIE_PASSWORD: 'a11y-audit-placeholder-cookie-password-32+',
  }
  const env = { ...placeholder, ...process.env, NEXT_TELEMETRY_DISABLED: '1' }
  for (const step of ['scripts/copy-pdfjs-assets.mjs', 'scripts/copy-excalidraw-assets.mjs']) {
    await run(process.execPath, [step], env)
  }
  const next = require.resolve('next/dist/bin/next')
  const child = spawn(process.execPath, [next, 'dev', '--turbopack', '-p', String(port)], {
    cwd: appRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  const ready = new Promise((resolve, reject) => {
    const onData = (chunk) => {
      log += chunk
      if (/Ready in/.test(log)) resolve()
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', (code) => reject(new Error(`next dev exited (${code}) before it was ready:\n${log.slice(-2000)}`)))
  })
  await ready
  return { origin, stop: () => child.kill('SIGTERM') }
}

const run = (command, args, env) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: appRoot, env, stdio: 'inherit' })
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${args.join(' ')} exited ${code}`))))
  })

/**
 * One load per viewport: light is audited first, then the same page is switched
 * to dark (the media feature and the `dark` class, as the app's theme does) and
 * audited again, which halves the page loads a dev server has to serve.
 */
async function auditRoute(browser, base, route, found) {
  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({ viewport, colorScheme: 'light' })
    const page = await context.newPage()
    let scheme = 'light'
    try {
      await page.goto(base + route, { waitUntil: 'load', timeout: 300000 })
      await page.waitForTimeout(2500)
      await page.evaluate(axeSource)
      for (scheme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme: scheme })
        await page.evaluate((dark) => {
          document.documentElement.classList.toggle('dark', dark)
          // The dev overlay is not the product.
          document.querySelectorAll('nextjs-portal').forEach((node) => node.remove())
        }, scheme === 'dark')
        await page.waitForTimeout(400)
        const result = await page.evaluate((tags) => globalThis.axe.run(document, { runOnly: { type: 'tag', values: tags } }), TAGS)
        for (const violation of result.violations) {
          const key = `${route} ${scheme} ${viewport.name} ${violation.id}`
          found.set(key, { count: violation.nodes.length, sample: violation.nodes[0]?.target?.join(' ') ?? '', help: violation.help })
        }
      }
    } catch (error) {
      found.set(`${route} ${scheme} ${viewport.name} load-failed`, { count: 1, sample: String(error.message).slice(0, 120), help: 'route did not render' })
    }
    await context.close()
  }
}

const args = parseArgs(process.argv.slice(2))
const all = args.named.length ? args.named : previewRoutes()
const routes = inShard(all, args.shard)
const server = process.env.A11Y_BASE_URL ? undefined : await startDevServer()
const base = process.env.A11Y_BASE_URL ?? server.origin
console.log(`auditing ${routes.length} of ${all.length} routes against ${base}`)

const browser = await chromium.launch({ executablePath: process.env.A11Y_CHROME || undefined })
const found = new Map()
const queue = [...routes]
const started = Date.now()
try {
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (let route = queue.shift(); route; route = queue.shift()) {
        await auditRoute(browser, base, route, found)
        console.log(`  ${route} (${Math.round((Date.now() - started) / 1000)}s)`)
      }
    }),
  )
} finally {
  await browser.close()
  server?.stop()
}

// The baseline is for the whole route set; a shard or a named subset checks its own part of it.
const audited = new Set(routes)
const inScope = (key) => audited.has(key.split(' ')[0])
if (args.writeBaseline) {
  const kept = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')).filter((key) => !inScope(key)) : []
  writeFileSync(BASELINE, `${JSON.stringify([...kept, ...found.keys()].sort(), null, 2)}\n`)
  console.log(`baseline: ${kept.length + found.size} entries`)
  process.exit(0)
}
const known = new Set(existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : [])
const fresh = [...found.keys()].filter((key) => !known.has(key))
// An entry for a route that no longer exists is reported once, by the full run or the first shard.
const reportsOrphans = !args.named.length && (!args.shard || args.shard.index === 1)
const orphan = (key) => reportsOrphans && !all.includes(key.split(' ')[0])
const gone = [...known].filter((key) => (inScope(key) && !found.has(key)) || orphan(key))
for (const key of fresh) {
  const v = found.get(key)
  console.log(`NEW   ${key}  x${v.count}  ${v.help}\n      ${v.sample}`)
}
for (const key of gone) console.log(`FIXED ${key} (remove it from scripts/a11y-baseline.json)`)
console.log(`${found.size} violation groups, ${fresh.length} new, ${gone.length} fixed`)
process.exit(fresh.length || gone.length ? 1 : 0)
