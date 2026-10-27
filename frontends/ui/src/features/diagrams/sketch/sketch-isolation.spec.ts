/**
 * Excalidraw is 2.5 MB gzipped and must never reach the chat bundle (ADR-0141).
 *
 * The chat stays at its size only while two things hold: `@excalidraw/excalidraw`
 * is imported by `sketch-canvas.tsx` alone, and `sketch-canvas.tsx` is reached
 * only through `next/dynamic` (`import('./sketch-canvas')`). A static import
 * anywhere else type-checks, builds and works, and costs every reader 2.5 MB;
 * this is what catches it.
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
  it('imports @excalidraw/excalidraw from sketch-canvas.tsx only', () => {
    const importers = files.filter(({ text }) => /from\s+['"]@excalidraw\/excalidraw(?:\/[^'"]*)?['"]/.test(text))
    expect(importers.map(({ path }) => path)).toEqual(['features/diagrams/sketch/sketch-canvas.tsx'])
  })

  it('reaches sketch-canvas only through a dynamic import, and only from the dialog', () => {
    const statics = files.filter(({ text }) => /from\s+['"][^'"]*sketch-canvas['"]/.test(text) && !/import\s+type\b[^;]*sketch-canvas/.test(text))
    expect(statics.map(({ path }) => path)).toEqual([])
    const dynamics = files.filter(({ text }) => /import\(\s*['"][^'"]*sketch-canvas['"]\s*\)/.test(text))
    expect(dynamics.map(({ path }) => path)).toEqual(['features/diagrams/sketch/sketch-dialog.tsx'])
  })
})
