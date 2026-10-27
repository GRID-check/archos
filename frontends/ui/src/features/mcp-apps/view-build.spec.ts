/**
 * @vitest-environment node
 */
/**
 * The built `ui://piloti/proposal-card` document (ADR-0142), as
 * `scripts/build-mcp-app-views.ts` writes it for the door: one self-contained
 * HTML5 document a host can draw under the MCP Apps default CSP (no origin to
 * load from or connect to), the same for every office, within its size budget.
 *
 * Bun builds it (the toolchain, ADR-0103), so this spec runs the script with
 * `bun` into a temporary folder and reads what it wrote.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { APP_VIEWS } from '@/lib/agent-api/catalog/app-views'

/** About 1.7 MiB with A2UI 0.14 (React, the MCP Apps SDK with its own zod, A2UI, the card and three namespaces in two languages). */
const BUDGET_BYTES = 2 * 1024 * 1024

let dir = ''
let html = ''

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-app-views-'))
  execFileSync('bun', ['scripts/build-mcp-app-views.ts', '--out', dir], { cwd: process.cwd(), stdio: 'pipe' })
  html = readFileSync(join(dir, 'proposal-card.html'), 'utf8')
}, 120_000)

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('the proposal card document', () => {
  it('is the file the catalog names', () => {
    expect(APP_VIEWS.map((view) => view.file)).toContain('proposal-card.html')
  })

  it('is one HTML5 document with its script and styles inline', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<div id="root"></div>')
    expect(html.match(/<script type="module">/g)).toHaveLength(1)
    expect(html.match(/<style>/g)).toHaveLength(1)
  })

  it('loads nothing from anywhere: no external script, stylesheet, frame or base', () => {
    expect(html).not.toMatch(/<script[^>]+src=/i)
    expect(html).not.toMatch(/<link[^>]+href=/i)
    expect(html).not.toMatch(/<iframe|<base\s/i)
    expect(html).not.toMatch(/@import\s+url\(\s*['"]?https?:/i)
  })

  it('carries no deployment secret or origin: it is the same document for every office', () => {
    expect(html).not.toMatch(/process\.env\.[A-Z]/)
    expect(html).not.toMatch(/GRID_INTERNAL_API_TOKEN|WORKOS_API_KEY|sk_(live|test)_/)
    expect(html).not.toMatch(/https:\/\/app\.piloti\.at/)
  })

  it('carries the card’s words and not the rest of Piloti’s dictionaries', () => {
    expect(html).toContain('Übernehmen')
    expect(html).toContain('Apply this?')
    // The Markdown renderer and its mermaid stayed out (`markdown-stand-in.tsx`).
    expect(html).not.toContain('mermaid')
  })

  it('stays within its size budget', () => {
    expect(Buffer.byteLength(html)).toBeLessThan(BUDGET_BYTES)
  })
})
