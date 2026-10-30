#!/usr/bin/env node
/**
 * Builds the corporate-design CSS from tokens.json, and copies the hand-maintained
 * component stylesheet and the fonts beside it, into dist/.
 *
 *   node packages/brand/build-tokens.mjs    write dist/
 *
 * Output (dist/)
 *   tokens.css        the website layer: CSS variables (light and dark theme), text
 *                     classes, @font-face. Tokens with "scope": "app" are left out, so
 *                     the website cannot reach the app's shadows or radius ladder.
 *   tokens.vars.css   the app layer: every colour, shadow and scalar, app-scoped ones
 *                     included, as variables only, each prefixed --ds-, dark under .dark
 *                     too: for an app with its own token names (the workspace), which
 *                     maps them onto these
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

/** A token every surface receives; "scope": "app" tokens reach only the app layer (tokens.vars.css). */
const isShared = (token) => token.scope === undefined
const tokensOf = (tokens, group, { app }) => tokens[group].tokens.filter((t) => app || isShared(t))

const declarations = (pairs) => pairs.map(([name, value]) => `  --${name}: ${value};`).join('\n')

/** Light is the base; dark repeats the tokens that differ, plus aliases (they follow the theme). */
function themePairs(themed) {
  const light = themed.map((t) => [t.name, toVar(t.value.light)])
  const dark = themed
    .filter((t) => t.value.dark !== undefined || isAlias(t.value.light))
    .map((t) => [t.name, toVar(t.value.dark ?? t.value.light)])
  return { light, dark }
}

function themeBlocks(themed) {
  const { light, dark } = themePairs(themed)
  return [
    `:root, [data-theme="light"] {\n${declarations(light)}\n}`,
    `[data-theme="dark"] {\n${declarations(dark)}\n}`,
  ]
}

const SCALAR_GROUPS = ['spacing', 'radius', 'stroke', 'effect', 'layout', 'motion']

function rootBlock(tokens) {
  const scalars = SCALAR_GROUPS.flatMap((group) => tokensOf(tokens, group, { app: false }).map((t) => [t.name, t.value]))
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

/**
 * Variables only, each name prefixed (--ds-ink), so an app with its own vocabulary can
 * import it beside its own tokens without a clash and map its names onto these.
 * Dark applies under .dark (the workspace's class) and [data-theme="dark"].
 */
export function renderVarsCss(tokens, prefix = 'ds') {
  const named = (pairs) => pairs.map(([name, value]) => [`${prefix}-${name}`, value.replace(/var\(--/g, `var(--${prefix}-`)])
  const themed = [...tokensOf(tokens, 'color', { app: true }), ...tokensOf(tokens, 'shadow', { app: true })].filter((t) => isThemed(t.value))
  const { light, dark } = themePairs(themed)
  const scalars = SCALAR_GROUPS.flatMap((group) => tokensOf(tokens, group, { app: true }).map((t) => [t.name, String(t.value)]))
  return `${HEADER}
:root {
${declarations(named([...light, ...scalars]))}
}
.dark, [data-theme="dark"] {
${declarations(named(dark))}
}
`
}

export function renderTokensCss(tokens) {
  const themed = [...tokensOf(tokens, 'color', { app: false }), ...tokensOf(tokens, 'shadow', { app: false })].filter((t) => isThemed(t.value))
  const blocks = [...themeBlocks(themed), rootBlock(tokens), ...textClasses(tokens), ...fontFaces(tokens)]
  return `${HEADER}\n${blocks.join('\n')}\n`
}

/**
 * Everything dist/ holds, keyed by the path under dist/. Pure: reads the sources, writes nothing.
 * @returns {Map<string, string | Buffer>}
 */
export function renderDist() {
  const tokens = JSON.parse(readFileSync(join(BRAND, 'tokens.json'), 'utf8'))
  for (const group of [...SCALAR_GROUPS, 'color', 'shadow']) {
    for (const t of tokens[group].tokens) {
      if (t.scope !== undefined && t.scope !== 'app') throw new Error(`tokens.json ${t.name}: unknown scope "${t.scope}" (only "app" exists)`)
    }
  }
  const out = new Map()
  out.set('tokens.css', renderTokensCss(tokens))
  out.set('tokens.vars.css', renderVarsCss(tokens))
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
