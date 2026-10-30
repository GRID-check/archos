#!/usr/bin/env node
/**
 * Draws the app icon and the share card from the brand, and renders every
 * raster of them, for both apps.
 *
 *   node packages/brand/build-brand-assets.mjs          write everything below
 *   node packages/brand/build-brand-assets.mjs --check  fail if the master or a copy drifted
 *
 * The icon is typographic (packages/brand/docs/brand-basis.md, "App icon"): the
 * design system's logo is the wordmark alone, with no pictorial mark, so the
 * icon is the wordmark's first letter, the product name's initial, in Switzer
 * Semibold, outlined, in ink on the warm white; the launcher icons keep the
 * wordmark's clear space (its cap height X on every side). A rename changes the initial: run this
 * script after `sync.mjs`, and `--check` fails until you do.
 *
 * `mark.svg` beside this file is the master this script writes; its <title> is
 * the token `{productName}`, filled in from `identity.json` in each copy
 * (name-copies.mjs). Each app gets a committed copy, because neither Docker
 * build can see `packages/` (each builds from its own directory). The website's
 * `bun run check` runs `--check`, so a hand-edited copy or master, or a master
 * not redrawn after a rename, fails CI instead of shipping. The same check holds
 * the inline `currentColor` copy of the glyph (INLINE_COPIES) to the master;
 * writing rewrites that copy's `viewBox`, `aspect` and `path` too.
 *
 * The share card (1200 x 630, every page's og:image) is the wordmark and the
 * tagline, outlined the same way, so a rename or a new tagline redraws it here.
 *
 * The rasters are not compared: sharp's anti-aliasing moves between versions.
 * sharp and fontkit are the website's (apps/website/node_modules,
 * devDependencies); this directory carries no install of its own.
 *
 * Output
 *   packages/brand/mark.svg   the icon master
 *   apps/website/public/      favicon.svg, favicon.ico, apple-touch-icon.png,
 *                             icons/icon-{192,512}.png, icons/icon-maskable-512.png,
 *                             media/share-card.png
 *   apps/workspace/app/       icon.svg, favicon.ico, apple-icon.png (Next file conventions)
 *   apps/workspace/public/    icons/icon-{192,512}.png, icons/icon-maskable-512.png
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MARK_COPIES, namedMark } from './name-copies.mjs'
import { loadFontkit, outline } from './outline.mjs'

const brandRoot = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(brandRoot, '../..')
const siteRoot = resolve(repoRoot, 'apps/website')
const uiRoot = resolve(repoRoot, 'apps/workspace')
const MASTER = resolve(brandRoot, 'mark.svg')
const LOGO_FONT = resolve(brandRoot, 'fonts/Switzer-Semibold.woff2')

/** A light-theme colour token's value, by name. */
const tokens = JSON.parse(readFileSync(resolve(brandRoot, 'tokens.json'), 'utf8'))
const colour = (name) => {
  const token = tokens.color.tokens.find((t) => t.name === name)
  if (!token) throw new Error(`tokens.json has no colour "${name}"`)
  return token.value.light
}
/** The brand neutrals (no hue): ink on the warm white, and the inverse for dark grounds. */
const INK = colour('ink')
const PAPER = colour('surface')
const MUTED = colour('ink-muted')

/** The wordmark's tracking (Wordmark.md: -0.02em). */
const TRACKING = -0.02

const SVG_COPIES = MARK_COPIES.map((path) => resolve(repoRoot, path))
/**
 * Where the glyph is drawn inline in `currentColor` (the app's icon rail and PDF
 * exports): the `viewBox`, `aspect` and `path` lines of a `BRAND_MARK` object.
 * This script writes them; `--check` compares them.
 */
const INLINE_COPIES = [resolve(uiRoot, 'bff/brand.ts')]

const identity = JSON.parse(readFileSync(resolve(brandRoot, 'identity.json'), 'utf8'))
const { name, tagline } = identity
/** The icon's letter: the name's first, in capitals as the wordmark sets it. */
const initial = [...name.trim()][0].toLocaleUpperCase('de')

const fontkit = loadFontkit(siteRoot)
if (!fontkit) {
  console.error('fontkit is missing: run `bun install --frozen-lockfile` in apps/website first.')
  process.exit(2)
}
const logoFont = fontkit.openSync(LOGO_FONT)
/** Cap height in em, measured on the outlines (the font's OS/2 value is the design's, 0.723). */
const CAP = logoFont.layout('H').glyphs[0].path.bbox.maxY / logoFont.unitsPerEm

// ── The icon ────────────────────────────────────────────────────────────────
/**
 * A 96-unit tile, at two sizes of the glyph:
 * - the launcher icons (manifest, home screen, 180 px and up) keep the
 *   wordmark's clear space: the cap height X is a third of the tile, X free
 *   on every side;
 * - the master, which is the tab icon (favicon.svg, icon.svg, favicon.ico at
 *   16 to 48 px), sets the letter at 10/16 of the tile, so at 16 px it is
 *   10 px tall on whole pixels; at a third it was a 5 px smudge. The tile's
 *   edge is its clear space there (3 px at 16 px).
 */
const TILE = 96
const X = TILE / 3
const TAB_X = (TILE * 10) / 16
/** The tile's corner, 20 of 96 (about a fifth); launchers that cut their own shape get none. */
const RADIUS = 20

/** The initial at cap height `x`, centred on its ink box in a `side`-unit square. */
function glyph(side, x) {
  const size = x / CAP
  const probe = outline(logoFont, initial, { size })
  const dx = (side - (probe.ink.right - probe.ink.left)) / 2 - probe.ink.left
  const baseline = (side + x) / 2
  return outline(logoFont, initial, { size, x: dx, y: baseline })
}

const mark = glyph(TILE, TAB_X)
const box = mark.ink
const round = (n) => Math.round(n * 100) / 100
/** The glyph's ink box as a viewBox, for the inline copies that set it flush. */
const inkViewBox = [box.left, box.top, box.right - box.left, box.bottom - box.top].map(round).join(' ')

/** `text` with the BRAND_MARK object's three lines set to the master's glyph; throws when they are missing. */
function withInlineGlyph(text, path) {
  const [, , w, h] = inkViewBox.split(' ')
  const lines = [
    [/(\n  viewBox: ')[^']*(',)/, inkViewBox],
    [/(\n  aspect: )[^,]*(,)/, `${w} / ${h}`],
    [/(\n  path: ')[^']*(',)/, mark.d],
  ]
  return lines.reduce((acc, [pattern, value]) => {
    if (!pattern.test(acc)) throw new Error(`${path}: no BRAND_MARK line matching ${pattern}`)
    return acc.replace(pattern, (_, before, after) => `${before}${value}${after}`)
  }, text)
}

const masterSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${TILE} ${TILE}">
  <!-- The app icon: the wordmark's first letter, ${JSON.stringify(initial)}, in Switzer Semibold,
       outlined, in ink on the warm white; a dark scheme inverts it. This is the
       tab icon, the letter at 10/16 of the tile so it reads at 16 px; the
       launcher icons keep the wordmark's clear space (brand-basis.md, "App
       icon"; derived, pending designer sign-off).
       GENERATED by \`node packages/brand/build-brand-assets.mjs\` from identity.json
       and the font; do not edit. That script copies it into both apps, renders
       every raster icon and checks the inline copy of the glyph. The <title>
       is the product's name, filled in from identity.json in each copy
       (name-copies.mjs). -->
  <title>{productName}</title>
  <style>@media (prefers-color-scheme: dark) { #tile { fill: ${INK} } #mark path { fill: ${PAPER} } }</style>
  <rect id="tile" width="${TILE}" height="${TILE}" rx="${RADIUS}" fill="${PAPER}"/>
  <g id="mark" data-initial="${initial}">
    <path fill="${INK}" d="${mark.d}"/>
  </g>
</svg>
`

// ── The share card ──────────────────────────────────────────────────────────
/**
 * 1200 x 630, the stacked lockup (brand-basis.md, "Logo"): the wordmark, and the
 * tagline below it at the gap X, left-aligned, with at least X of clear space
 * around the pair; the domain sits at the foot in ink-muted.
 */
function shareCard() {
  const W = 1200, H = 630, left = 96
  const word = name.toLocaleUpperCase('de')
  /** The right edge of `text`'s ink per unit of font size. */
  const reach = (text, opts = {}) => outline(logoFont, text, { size: 1, ...opts }).ink.right
  // 136 px, or smaller for a longer name: the word keeps its clear space X to the right edge.
  const wordSize = Math.min(136, (W - left) / (reach(word, { tracking: TRACKING }) + CAP))
  const x = wordSize * CAP
  const claimSize = Math.min(52, (W - left - x) / reach(tagline))
  const claimCap = claimSize * CAP
  const wordBaseline = 300
  const wordRun = outline(logoFont, word, { size: wordSize, x: left, y: wordBaseline, tracking: TRACKING })
  const claim = outline(logoFont, tagline, { size: claimSize, x: left, y: wordBaseline + x + claimCap })
  const domain = outline(logoFont, identity.domain, { size: 28, x: left, y: H - 72 })
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="${PAPER}"/>
  <path fill="${INK}" d="${wordRun.d}"/>
  <path fill="${INK}" d="${claim.d}"/>
  <path fill="${MUTED}" d="${domain.d}"/>
</svg>
`
}

// ── Check ───────────────────────────────────────────────────────────────────
const named = namedMark(masterSvg, name)

if (process.argv.includes('--check')) {
  const problems = []
  if (readFileSync(MASTER, 'utf8') !== masterSvg) {
    problems.push(`${MASTER} is not what identity.json and the font draw (initial ${JSON.stringify(initial)}).`)
  }
  for (const path of SVG_COPIES) {
    if (readFileSync(path, 'utf8') !== named) problems.push(`${path} differs from ${MASTER}.`)
  }
  for (const path of INLINE_COPIES) {
    const text = readFileSync(path, 'utf8')
    if (withInlineGlyph(text, path) !== text) problems.push(`${path} does not draw the master's glyph.`)
  }
  for (const p of problems) console.error(p)
  if (problems.length) {
    console.error('Run node packages/brand/build-brand-assets.mjs.')
    process.exit(1)
  }
  console.log(`Brand icon (${JSON.stringify(initial)}) and its copies match identity.json and the font.`)
  process.exit(0)
}

// ── Rasters ─────────────────────────────────────────────────────────────────
const sharp = createRequire(resolve(siteRoot, 'package.json'))('sharp')

/** The glyph at the clear-space size X on a tile; `radius` 0 is full bleed, for launchers and iOS that cut their own shape. */
function launcher(ground, ink, radius) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${TILE} ${TILE}">
  <rect width="${TILE}" height="${TILE}" rx="${radius}" fill="${ground}"/>
  <path fill="${ink}" d="${glyph(TILE, X).d}"/>
</svg>`
}

function png(svg, size) {
  return sharp(Buffer.from(svg), { density: (72 * size) / TILE })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toBuffer()
}

/** An .ico holding PNG frames, which every browser since IE 11 reads. */
function ico(frames) {
  const header = Buffer.alloc(6 + 16 * frames.length)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(frames.length, 4)
  let offset = header.length
  frames.forEach(({ size, data }, i) => {
    const entry = 6 + 16 * i
    header.writeUInt8(size >= 256 ? 0 : size, entry)
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1)
    header.writeUInt16LE(1, entry + 4) // colour planes
    header.writeUInt16LE(32, entry + 6) // bits per pixel
    header.writeUInt32LE(data.length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += data.length
  })
  return Buffer.concat([header, ...frames.map((f) => f.data)])
}

function write(path, data) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, data)
  console.log(`wrote ${path.slice(repoRoot.length + 1)}`)
}

const favicon = ico(await Promise.all([16, 32, 48].map(async (size) => ({ size, data: await png(named, size) }))))
// iOS rounds the corners itself and paints transparency black, so the touch
// icon is full-bleed and opaque. The maskable icon is the dark variant: ink
// ground, warm-white glyph, well inside the 80% safe circle a launcher crops to.
const touch = await sharp(await png(launcher(PAPER, INK, 0), 180)).flatten({ background: PAPER }).png().toBuffer()
const manifestIcons = {
  'icons/icon-192.png': await png(launcher(PAPER, INK, RADIUS), 192),
  'icons/icon-512.png': await png(launcher(PAPER, INK, RADIUS), 512),
  'icons/icon-maskable-512.png': await png(launcher(INK, PAPER, 0), 512),
}
const card = await sharp(Buffer.from(shareCard())).png({ compressionLevel: 9 }).toBuffer()

write(MASTER, masterSvg)
for (const path of SVG_COPIES) write(path, named)
write(resolve(siteRoot, 'public/favicon.ico'), favicon)
write(resolve(siteRoot, 'public/apple-touch-icon.png'), touch)
write(resolve(siteRoot, 'public/media/share-card.png'), card)
write(resolve(uiRoot, 'app/favicon.ico'), favicon)
write(resolve(uiRoot, 'app/apple-icon.png'), touch)
for (const [file, data] of Object.entries(manifestIcons)) {
  write(resolve(siteRoot, 'public', file), data)
  write(resolve(uiRoot, 'public', file), data)
}
for (const path of INLINE_COPIES) write(path, withInlineGlyph(readFileSync(path, 'utf8'), path))
