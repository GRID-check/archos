// @disk-inputs: src/**
/**
 * A phone on its side is still a phone: `md:` and `useIsMobile()` agree, and
 * both say so.
 *
 * An iPhone in landscape is 852 x 393. Tailwind's `md` is "at least 768px
 * wide", so it took the desktop shell into 393px of height and every
 * `md:opacity-0` reveal hid its control from a finger. `globals.css` redefines
 * `md`/`max-md` and adds `phone`; `use-is-mobile.ts` exports the same queries
 * for JavaScript. These hold the three things that can drift apart silently:
 *
 *  1. the stylesheet's queries and the hook's (two copies of one string, because
 *     CSS cannot import TypeScript);
 *  2. Tailwind still honouring a `@custom-variant` that reuses a built-in name
 *     (it replaces the body and keeps the sort position today; an upgrade that
 *     changed that would put every `md:` back on the phone without a diff);
 *  3. nobody writing the old width by hand into a `matchMedia` again.
 */

import { readFileSync } from 'node:fs'
import { readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

import { MOBILE_LAYOUT_QUERY, PHONE_ON_ITS_SIDE_QUERY, PHONE_QUERY } from '@/hooks/use-is-mobile'

const SRC = join(__dirname, '..', '..')
const UI_ROOT = join(SRC, '..')
const GLOBALS = readFileSync(join(SRC, 'app', 'globals.css'), 'utf8')

/** The body of `@custom-variant <name> { … }`, braces balanced. */
function customVariant(name: string): string {
  const start = GLOBALS.indexOf(`@custom-variant ${name} {`)
  expect(start, `@custom-variant ${name}`).toBeGreaterThanOrEqual(0)
  let depth = 0
  for (let i = GLOBALS.indexOf('{', start); i < GLOBALS.length; i += 1) {
    if (GLOBALS[i] === '{') depth += 1
    else if (GLOBALS[i] === '}' && --depth === 0) return GLOBALS.slice(start, i + 1)
  }
  throw new Error(`unbalanced @custom-variant ${name}`)
}

describe('the stylesheet and the hook ask the same question', () => {
  it('md is "at least 768px wide, and not a phone on its side"', () => {
    const md = customVariant('md')
    expect(md).toContain('@media (width >= 48rem)')
    expect(md).toContain(`@media not all and ${PHONE_ON_ITS_SIDE_QUERY}`)
  })

  it('max-md is exactly the phone shell useIsMobile() reports', () => {
    expect(customVariant('max-md')).toContain(`@media ${MOBILE_LAYOUT_QUERY} {`)
  })

  it('phone is below sm, or a phone on its side', () => {
    expect(customVariant('phone')).toContain(`@media ${PHONE_QUERY} {`)
  })
})

describe('Tailwind honours the override', () => {
  const require = createRequire(join(UI_ROOT, 'package.json'))
  const tailwindRoot = dirname(require.resolve('tailwindcss/package.json'))

  async function build(candidates: string[]): Promise<string> {
    const { compile } = require('tailwindcss') as typeof import('tailwindcss')
    const variants = GLOBALS.slice(
      GLOBALS.indexOf('@custom-variant md {'),
      GLOBALS.indexOf('@custom-variant phone {') + customVariant('phone').length
    )
    const css = [
      '@layer theme, base, components, utilities;',
      "@import 'tailwindcss/theme.css' layer(theme);",
      "@import 'tailwindcss/utilities.css' layer(utilities);",
      variants,
    ].join('\n')
    const compiler = await compile(css, {
      base: UI_ROOT,
      loadStylesheet: async (id: string) => {
        const path = join(tailwindRoot, id.replace(/^tailwindcss\//, ''))
        return { path, base: dirname(path), content: readFileSync(path, 'utf8') }
      },
    })
    return compiler.build(candidates)
  }

  it('wraps md: in the phone exclusion, and leaves lg: as Tailwind wrote it', async () => {
    const css = await build(['md:flex', 'lg:grid'])
    const md = css.indexOf('.md\\:flex')
    // The class sits inside the exclusion, which sits inside the width query.
    const before = css.slice(0, md)
    expect(before.lastIndexOf(`@media not all and ${PHONE_ON_ITS_SIDE_QUERY}`)).toBeGreaterThan(
      before.lastIndexOf('@media (width >= 48rem)')
    )
    expect(css).toMatch(/@media \(width >= 64rem\) \{\s*\.lg\\:grid/)
  })

  it('keeps md: in its place in the cascade, after sm: and before lg:', async () => {
    const css = await build(['lg:grid', 'md:flex', 'sm:block'])
    const order = ['.sm\\:block', '.md\\:flex', '.lg\\:grid'].map((cls) => css.indexOf(cls))
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })
})

describe('no breakpoint is written by hand into JavaScript', () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) walk(path, out)
      else if (/\.tsx?$/.test(entry) && !/\.(?:spec|test)\.tsx?$/.test(entry)) out.push(path)
    }
    return out
  }

  it('asks for the phone shell through use-is-mobile, never a raw md width', () => {
    // A `(max-width: 767px)` in a matchMedia forgets the phone on its side, and
    // disagrees with every `md:` class on the same screen.
    const RAW_MD = /\((?:max|min)-width:\s*(?:767|768)(?:\.\d+)?px\)|\(width\s*[<>]=?\s*48rem\)/
    const offenders = walk(SRC)
      .filter((file) => !file.endsWith(join('hooks', 'use-is-mobile.ts')))
      // An `<img sizes>` names widths for the image picker, not a layout.
      .filter((file) =>
        readFileSync(file, 'utf8')
          .split('\n')
          .some((line) => RAW_MD.test(line) && !/\bsizes[=:]/.test(line))
      )
      .map((file) => file.slice(SRC.length + 1))
    expect(offenders).toEqual([])
  })
})
