/**
 * Excalidraw is 2.5 MB gzipped and must never reach the chat bundle (ADR-0141,
 * ADR-0146).
 *
 * The chat stays at its size only while two things hold: `@excalidraw/excalidraw`
 * is imported by the editor (`sketch-canvas.tsx`) and the sketch renderer
 * (`sketch-render.ts`) alone, and each is reached only through a dynamic
 * import: the canvas from the dialog, the renderer from the sketch figure. A
 * static import anywhere else type-checks, builds and works, and costs every
 * reader 2.5 MB; this is what catches it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(__dirname, '..', '..', '..')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(path)
    return /\.(ts|tsx)$/.test(name) && !/\.spec\.tsx?$/.test(name) ? [path] : []
  })
}

const files = sourceFiles(SRC).map((path) => ({ path: relative(SRC, path), text: readFileSync(path, 'utf8') }))

describe('the sketch editor stays out of the chat bundle', () => {
  it('imports @excalidraw/excalidraw from the canvas and the renderer only', () => {
    const importers = files.filter(({ text }) => /from\s+['"]@excalidraw\/excalidraw(?:\/[^'"]*)?['"]/.test(text))
    expect(importers.map(({ path }) => path).sort()).toEqual([
      'features/diagrams/sketch/sketch-canvas.tsx',
      'features/diagrams/sketch/sketch-render.ts',
    ])
  })

  it.each([
    ['sketch-canvas', 'features/diagrams/sketch/sketch-dialog.tsx'],
    ['sketch-render', 'features/diagrams/components/sketch-figure.tsx'],
  ])('reaches %s only through a dynamic import, and only from %s', (module, importer) => {
    // A whole `import type … from '…'` statement is erased at compile time, so
    // it is cut out first; whatever still names sketch-canvas in a `from` (an
    // import or a re-export) or a bare side-effect import is a static edge.
    // Testing the file for "has an import type" instead let a value import in
    // the same file through.
    const TYPE_ONLY_IMPORT = /import\s+type\s[^'"]*?from\s*['"][^'"]+['"]/g
    const STATIC_EDGE = new RegExp(`(?:from\\s*|import\\s+)['"][^'"]*${module}['"]`)
    const statics = files.filter(({ text }) => STATIC_EDGE.test(text.replace(TYPE_ONLY_IMPORT, '')))
    expect(statics.map(({ path }) => path)).toEqual([])
    const dynamics = files.filter(({ text }) => new RegExp(`import\\(\\s*['"][^'"]*${module}['"]\\s*\\)`).test(text))
    expect(dynamics.map(({ path }) => path)).toEqual([importer])
  })
})
