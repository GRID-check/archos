#!/usr/bin/env node
/**
 * Builds the corporate-design CSS from tokens.json, and copies the hand-maintained
 * component stylesheet and the fonts beside it, into dist/.
 *
 *   node packages/brand/build-tokens.mjs    write dist/
 *
 * Output (dist/)
 *   tokens.css        CSS variables (light and dark theme), text classes, @font-face
 *   components.css    copied from css/components.css (class prefix ui-)
 *   fonts/            copied from fonts/
 *
 * sync.mjs imports renderDist() and writeDist() from here, so the copies in the apps
 * are always built from the same source.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const BRAND = dirname(fileURLToPath(import.meta.url))
const HEADER = '/* generated from tokens.json by build-tokens.mjs — do not edit */'
const FORMATS = { '.woff2': 'woff2', '.woff': 'woff', '.ttf': 'truetype', '.otf': 'opentype' }

const isThemed = (value) => value !== null && typeof value === 'object' && 'light' in value
const isAlias = (value) => typeof value === 'string' && /^\{[a-z0-9-]+\}$/.test(value)
const toVar = (value) => value.replace(/\{([a-z0-9-]+)\}/g, 'var(--$1)')

const declarations = (pairs) => pairs.map(([name, value]) => `  --${name}: ${value};`).join('\n')

/** Light is the base; dark repeats the tokens that differ, plus aliases (they follow the theme). */
function themeBlocks(themed) {
  const light = themed.map((t) => [t.name, toVar(t.value.light)])
  const dark = themed
    .filter((t) => t.value.dark !== undefined || isAlias(t.value.light))
    .map((t) => [t.name, toVar(t.value.dark ?? t.value.light)])
  return [
    `:root, [data-theme="light"] {\n${declarations(light)}\n}`,
    `[data-theme="dark"] {\n${declarations(dark)}\n}`,
  ]
}

function rootBlock(tokens) {
  const scalars = ['spacing', 'radius', 'stroke', 'effect', 'layout'].flatMap((group) =>
    tokens[group].tokens.map((t) => [t.name, t.value]),
  )
  const families = Object.entries(tokens.type.families).map(([key, value]) => [`font-${key}`, value])
  const texts = tokens.type.groups.flatMap((group) =>
    group.styles.map((s) => [
      `text-${s.name}`,
      `${s.fontWeight} ${s.fontSize}/${s.lineHeight} var(--font-${group.family})`,
    ]),
  )
  return `:root {\n${declarations([...scalars, ...families, ...texts])}\n}`
}

function textClasses(tokens) {
  return tokens.type.groups.flatMap((group) =>
    group.styles.map(
      (s) => `.${s.name} {
  font-family: var(--font-${group.family});
  font-size: ${s.fontSize};
  line-height: ${s.lineHeight};
  font-weight: ${s.fontWeight};
  letter-spacing: ${s.letterSpacing};
}`,
    ),
  )
}

function fontFaces(tokens) {
  return tokens.type.fonts.map((f) => {
    const file = f.file.replace(/^\.\//, '')
    const format = FORMATS[extname(file)]
    return `@font-face {
  font-family: "${f.family}";
  src: url("./${file}") format("${format}");
  font-weight: ${f.weight};
  font-style: ${f.style};
  font-display: swap;
}`
  })
}

export function renderTokensCss(tokens) {
  const themed = [...tokens.color.tokens, ...tokens.shadow.tokens].filter((t) => isThemed(t.value))
  const blocks = [...themeBlocks(themed), rootBlock(tokens), ...textClasses(tokens), ...fontFaces(tokens)]
  return `${HEADER}\n${blocks.join('\n')}\n`
}

/**
 * Everything dist/ holds, keyed by the path under dist/. Pure: reads the sources, writes nothing.
 * @returns {Map<string, string | Buffer>}
 */
export function renderDist() {
  const tokens = JSON.parse(readFileSync(join(BRAND, 'tokens.json'), 'utf8'))
  const out = new Map()
  out.set('tokens.css', renderTokensCss(tokens))
  out.set('components.css', readFileSync(join(BRAND, 'css/components.css')))
  for (const file of readdirSync(join(BRAND, 'fonts')).sort()) {
    out.set(`fonts/${file}`, readFileSync(join(BRAND, 'fonts', file)))
  }
  return out
}

export function writeDist(outputs) {
  const dist = join(BRAND, 'dist')
  for (const [rel, content] of outputs) {
    const target = join(dist, rel)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeDist(renderDist())
  console.log(`built ${resolve(BRAND, 'dist')}`)
}
