#!/usr/bin/env node
/**
 * Accessibility audit of the /dev preview routes: axe-core with the WCAG 2.0,
 * 2.1 and 2.2 level A and AA rule sets, light and dark, desktop and phone.
 *
 *   task workspace:a11y            starts nothing: needs `bun run dev` on A11Y_BASE_URL
 *   A11Y_BASE_URL=http://localhost:3001 node scripts/a11y-audit.mjs [route ...]
 *   A11Y_CHROME=/path/to/chrome     a Chrome or Chromium binary (default: Playwright's own)
 *
 * Exits 1 on any violation not listed in `scripts/a11y-baseline.json`, and on a
 * baseline entry that no longer occurs, so the list only shrinks. Disabled
 * controls are exempt, as WCAG 2.2 SC 1.4.3 says ("inactive user interface
 * components"): axe skips them in `color-contrast` itself.
 *
 * The preview routes render real components from fixtures, so the audit needs
 * no backend. `--write-baseline` records the current violations instead of failing.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { chromium } from 'playwright-core'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8')
const BASE = process.env.A11Y_BASE_URL ?? 'http://localhost:3001'
const BASELINE = join(here, 'a11y-baseline.json')

const DEFAULT_ROUTES = [
  '/dev/atoms',
  '/dev/chat-turn',
  '/dev/chat-welcome',
  '/dev/composer',
  '/dev/file-browser',
  '/dev/file-preview',
  '/dev/projects-home',
  '/dev/project-chrome',
  '/dev/app-shell-scopes',
  '/dev/global-error',
  '/dev/inbox',
  '/dev/settings',
]
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']
const VIEWPORTS = [
  { name: '1440', width: 1440, height: 900 },
  { name: '390', width: 390, height: 844 },
]

const args = process.argv.slice(2)
const writeBaseline = args.includes('--write-baseline')
const routes = args.filter((a) => a.startsWith('/')).length ? args.filter((a) => a.startsWith('/')) : DEFAULT_ROUTES

const browser = await chromium.launch({ executablePath: process.env.A11Y_CHROME || undefined })
const found = new Map()
for (const route of routes) {
  for (const viewport of VIEWPORTS) {
    for (const scheme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport, colorScheme: scheme })
      const page = await context.newPage()
      try {
        await page.goto(BASE + route, { waitUntil: 'load', timeout: 180000 })
        await page.waitForTimeout(2500)
        await page.evaluate((dark) => {
          document.documentElement.classList.toggle('dark', dark)
          // The dev overlay is not the product.
          document.querySelectorAll('nextjs-portal').forEach((node) => node.remove())
        }, scheme === 'dark')
        await page.waitForTimeout(400)
        await page.evaluate(axeSource)
        const result = await page.evaluate((tags) => globalThis.axe.run(document, { runOnly: { type: 'tag', values: tags } }), TAGS)
        for (const violation of result.violations) {
          const key = `${route} ${scheme} ${viewport.name} ${violation.id}`
          found.set(key, { count: violation.nodes.length, sample: violation.nodes[0]?.target?.join(' ') ?? '', help: violation.help })
        }
      } catch (error) {
        found.set(`${route} ${scheme} ${viewport.name} load-failed`, { count: 1, sample: String(error.message).slice(0, 120), help: 'route did not render' })
      }
      await context.close()
    }
  }
}
await browser.close()

if (writeBaseline) {
  writeFileSync(BASELINE, `${JSON.stringify([...found.keys()].sort(), null, 2)}\n`)
  console.log(`baseline: ${found.size} entries`)
  process.exit(0)
}
const known = new Set(existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : [])
const fresh = [...found.keys()].filter((key) => !known.has(key))
const gone = args.some((a) => a.startsWith('/')) ? [] : [...known].filter((key) => !found.has(key))
for (const key of fresh) {
  const v = found.get(key)
  console.log(`NEW   ${key}  x${v.count}  ${v.help}\n      ${v.sample}`)
}
for (const key of gone) console.log(`FIXED ${key} (remove it from scripts/a11y-baseline.json)`)
console.log(`${found.size} violation groups, ${fresh.length} new, ${gone.length} fixed`)
process.exit(fresh.length || gone.length ? 1 : 0)
