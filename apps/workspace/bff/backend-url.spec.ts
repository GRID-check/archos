// @disk-inputs: app/**, bff/**, i18n/**, shared/**, types/**, ui/**, utils/**
/**
 * @vitest-environment node
 */

/**
 * One resolution of the backend's address. Six files used to carry their own
 * copy of the env chain, three of them a shorter one (`BACKEND_URL ?? …`) that
 * ignored `NEXT_PUBLIC_BACKEND_URL` and kept an empty `BACKEND_URL`.
 */

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript-api'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getBackendUrl } from './backend-url'
import { SOURCE_DIRS } from '@/test-utils/source-tree'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('getBackendUrl', () => {
  it('reads BACKEND_URL first, without a trailing slash', () => {
    vi.stubEnv('BACKEND_URL', 'http://aiq-api:8000/')
    vi.stubEnv('NEXT_PUBLIC_BACKEND_URL', 'http://public:8000')
    expect(getBackendUrl()).toBe('http://aiq-api:8000')
  })

  it('falls back to NEXT_PUBLIC_BACKEND_URL, then to localhost', () => {
    vi.stubEnv('BACKEND_URL', '')
    vi.stubEnv('NEXT_PUBLIC_BACKEND_URL', 'http://public:8000')
    expect(getBackendUrl()).toBe('http://public:8000')
    vi.stubEnv('NEXT_PUBLIC_BACKEND_URL', '')
    expect(getBackendUrl()).toBe('http://localhost:8000')
  })
})

const UI_ROOT = path.resolve(__dirname, '..')
const RESOLVER = 'bff/backend-url.ts'

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    if (!/\.(ts|tsx)$/.test(entry.name) || /\.(spec|test)\.tsx?$/.test(entry.name)) return []
    return [full]
  })
}

/** `process.env.BACKEND_URL` reads in `file`, through the parser so a comment naming it is not one. */
function backendUrlReads(file: string): number {
  const text = readFileSync(file, 'utf8')
  if (!text.includes('BACKEND_URL')) return 0
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  let hits = 0
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'BACKEND_URL' &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'env'
    ) {
      hits += 1
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return hits
}

describe('the backend address has one resolver', () => {
  it('no file but backend-url.ts reads process.env.BACKEND_URL', () => {
    const offenders = SOURCE_DIRS.flatMap((dir) => sourceFiles(path.join(UI_ROOT, dir)))
      .map((file) => path.relative(UI_ROOT, file).split(path.sep).join('/'))
      .filter((file) => file !== RESOLVER && backendUrlReads(path.join(UI_ROOT, file)) > 0)
    expect(offenders, 'Import getBackendUrl from @/lib/backend-url (or @/lib/backend-proxy, which re-exports it).').toEqual(
      []
    )
  })

  it('the scan sees the resolver it exempts', () => {
    expect(backendUrlReads(path.join(UI_ROOT, RESOLVER))).toBe(1)
  })
})
