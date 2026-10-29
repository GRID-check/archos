#!/usr/bin/env node
/**
 * Accessibility gate for the built site: axe-core's WCAG 2.0, 2.1 and 2.2 A/AA
 * rules (contrast, names, labels, landmarks, target size, ...) on every page in
 * the sitemap plus the 404 page, German and English, at a desktop and a phone
 * width, and with the open states a visitor can reach (the mobile menu, a sent
 * form). Exits 1 on any violation.
 *
 * axe cannot judge text set on a photo (it reports "needs review"). For those
 * elements (`PHOTO_TEXT`) this script measures it itself: it hides the text,
 * captures the box behind it, and requires the text colour to reach 4.5:1
 * (3:1 at 24px and up) against every pixel there, the strictest reading of
 * WCAG 1.4.3.
 *
 *   bun run build && bun run check:a11y
 *
 * It serves `dist/` with the production server (`runtime/server.mjs`) on a free
 * port, so the pages are checked with the headers they ship with. Needs a
 * Chromium for Playwright: `bunx playwright install chromium` (CI adds
 * `--with-deps`).
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import AxeBuilder from '@axe-core/playwright'
import { chromium } from 'playwright'
import sharp from 'sharp'

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']
const WIDTHS = [1280, 390]
/** Text that sits on a photo: the duo cards on the home page, the note under the demo form. */
const PHOTO_TEXT = '.ui-duo-title, .ui-duo-body, .ui-split-note'

/** WCAG relative luminance of an sRGB colour. */
function luminance([r, g, b]) {
  const channel = (c) => {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function contrast(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (light + 0.05) / (dark + 0.05)
}

/** The lowest contrast of each photo text against the pixels behind it. */
async function photoText(page, label) {
  const found = []
  const elements = page.locator(PHOTO_TEXT)
  for (let i = 0; i < (await elements.count()); i += 1) {
    const element = elements.nth(i)
    await element.evaluate((node) => node.scrollIntoView({ block: 'center' }))
    // The photos are lazy: wait until every image in view has loaded, so the layout has
    // settled before the box is measured.
    await page.waitForFunction(() =>
      [...document.images].every((img) => {
        const rect = img.getBoundingClientRect()
        return rect.bottom < 0 || rect.top > innerHeight || (img.complete && img.naturalWidth > 0)
      }),
    )
    // Loaded is not yet painted: decode what is in view and let two frames pass.
    await page.evaluate(async () => {
      const inView = [...document.images].filter((img) => {
        const rect = img.getBoundingClientRect()
        return img.complete && rect.bottom >= 0 && rect.top <= innerHeight
      })
      await Promise.all(inView.map((img) => img.decode().catch(() => undefined)))
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    })
    const box = await element.evaluate((node) => {
      const rect = node.getBoundingClientRect()
      const style = getComputedStyle(node)
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, color: style.color, size: parseFloat(style.fontSize), text: node.textContent.trim().slice(0, 40) }
    })
    if (box.width < 1 || box.height < 1) continue
    await element.evaluate((node) => (node.style.visibility = 'hidden'))
    const png = await page.screenshot({ clip: { x: box.x, y: box.y, width: box.width, height: box.height } })
    await element.evaluate((node) => (node.style.visibility = ''))
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true })
    const ink = box.color.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number)
    let lowest = Infinity
    for (let p = 0; p < data.length; p += info.channels) lowest = Math.min(lowest, contrast(ink, [data[p], data[p + 1], data[p + 2]]))
    const required = box.size >= 24 ? 3 : 4.5
    if (lowest < required) found.push(`${label}: text on photo "${box.text}" reaches ${lowest.toFixed(2)}:1, needs ${required}:1`)
  }
  return found
}

/** A port nobody listens on. */
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

/** Runs axe on the page as it is now and returns readable findings. */
async function audit(page, label) {
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze()
  return result.violations.flatMap((violation) =>
    violation.nodes.map(
      (node) => `${label}: ${violation.id} (${violation.impact}) ${node.target.join(' ')}: ${node.failureSummary?.split('\n').slice(1).join(' ').trim()}`,
    ),
  )
}

const port = await freePort()
const base = `http://127.0.0.1:${port}`
const server = spawn(process.execPath, [fileURLToPath(new URL('../runtime/server.mjs', import.meta.url))], {
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), PUBLIC_POSTHOG_HOST: '', PUBLIC_POSTHOG_PROJECT_TOKEN: '' },
  stdio: 'ignore',
})

const findings = []
let pages = 0
try {
  await waitFor(`${base}/healthz`)
  const sitemap = await (await fetch(`${base}/sitemap-0.xml`)).text()
  const routes = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname)
  routes.push('/does-not-exist/', '/en/does-not-exist/')

  const browser = await chromium.launch()
  for (const width of WIDTHS) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' })
    for (const route of routes) {
      const page = await context.newPage()
      await page.goto(base + route, { waitUntil: 'load' })
      findings.push(...(await audit(page, `${route} @${width}`)))
      findings.push(...(await photoText(page, `${route} @${width}`)))
      pages += 1

      // The open states: the mobile menu on a phone, the hand-off panel of a form.
      if (width < 768 && (await page.locator('.ui-mnav summary').count())) {
        await page.locator('.ui-mnav summary').click()
        findings.push(...(await audit(page, `${route} @${width} menu open`)))
      }
      const form = page.locator('[data-mail-form] form')
      if (width >= 768 && (await form.count())) {
        await form.evaluate((el) => {
          el.hidden = true
          el.parentElement.querySelector('.mail-form-sent').hidden = false
        })
        findings.push(...(await audit(page, `${route} @${width} form sent`)))
      }
      await page.close()
    }
    await context.close()
  }
  await browser.close()
} finally {
  server.kill()
}

if (findings.length) {
  console.error(`Accessibility check FAILED: ${findings.length} finding(s) on ${pages} page views.`)
  for (const finding of findings) console.error(`  - ${finding}`)
  process.exit(1)
}
console.log(`Accessibility check passed: ${pages} page views, axe rules ${TAGS.join(', ')}, no violations.`)
