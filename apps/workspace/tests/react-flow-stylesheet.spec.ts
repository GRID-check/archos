// @disk-inputs: app/**, ui/**
/**
 * Every module that renders `<ReactFlow>` imports React Flow's stylesheet.
 *
 * Without `@xyflow/react/dist/style.css` a node is not absolutely positioned:
 * the nodes stack in document flow with their transforms added on top, so the
 * graph draws as a staircase with its edges anchored in the wrong places. The
 * Herleitung shipped like that when the ReasoningFlow split (#1387) left the
 * import behind in the old file. Whether another chunk happened to load the
 * sheet first is luck, so each render site carries its own import.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..')
const STYLESHEET = /import\s+['"]@xyflow\/react\/dist\/(style|base)\.css['"]/

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : tsxFiles(path)
    return entry.name.endsWith('.tsx') && !entry.name.includes('.spec.') ? [path] : []
  })
}

describe('React Flow stylesheet', () => {
  const renderSites = ['app', 'ui']
    .flatMap((dir) => tsxFiles(join(ROOT, dir)))
    .filter((file) => /<ReactFlow\b/.test(readFileSync(file, 'utf8')))

  it('finds the render sites', () => {
    expect(renderSites.length).toBeGreaterThan(0)
  })

  it.each(renderSites.map((file) => [relative(ROOT, file), file]))(
    '%s imports the stylesheet',
    (_name, file) => {
      expect(readFileSync(file, 'utf8')).toMatch(STYLESHEET)
    }
  )
})
