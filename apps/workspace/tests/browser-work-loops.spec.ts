/**
 * @vitest-environment node
 */

/**
 * The browser runs no work loop over items (ADR-0121). A bulk move, a sort, an
 * import or a reindex is a server run on `bff_job_queue`: the browser starts
 * it, reads it, and asks for its next step. This is the ratchet that keeps that
 * true for the next writer.
 *
 * It counts, per browser file, three signatures of a loop the browser drives,
 * read through the TypeScript parser so a comment that names one is not counted:
 *
 * - a `const` whose name ends in `CONCURRENCY` (the width of a pool),
 * - a function named `pooled`, `workerPool`, `runPool` or `withConcurrency`,
 * - `Promise.all(Array.from({ length: … }, worker))` (the pool itself).
 *
 * Browser code is the feature and component trees, the app's pages (not its
 * API) and any other file that opens with `'use client'`.
 *
 * A ratchet, not a ban, as `english-names.spec.ts` is: `ci/browser_work_loops.json`
 * holds each file's count and the reason it is there. A count may fall, never
 * rise, and a new file may not appear. A hit that is not a loop over server
 * items (the browser holds the bytes it sends, a local upload) is baselined with
 * that reason. After a cleanup, rerun with UPDATE_BROWSER_WORK_LOOPS=1 to lower
 * the counts; a new entry is written by hand, with its reason.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript-api'
import { describe, expect, it } from 'vitest'

const UI_ROOT = path.resolve(__dirname, '..')
const REPO_ROOT = path.resolve(UI_ROOT, '../..')
const BASELINE_PATH = path.join(REPO_ROOT, 'ci', 'browser_work_loops.json')

const POOL_WIDTH = /[A-Z_]*CONCURRENCY\b/
const POOL_FUNCTION = /\b(pooled|workerPool|runPool|withConcurrency)\b/

const GUIDANCE =
  'A browser loop over many items. Make it a server run on bff_job_queue (docs/adr/0121-bulk-work-is-owned-by-the-server.md): ' +
  'a row the person comes back to, worked in bounded slices. The browser starts it, reads it and asks for its next step. ' +
  'If the browser holds the bytes it sends (a local file), baseline it in ci/browser_work_loops.json with that reason.'

interface BaselineEntry {
  count: number
  reason: string
}
type Baseline = Record<string, BaselineEntry>

/** Browser code: features, components, hooks, the app's pages (not its API), and any file that opts in with 'use client'. */
function isBrowserPath(file: string): boolean {
  if (/\.(spec|test)\.tsx?$/.test(file)) return false
  if (/^app\/api\//.test(file)) return false
  return /^ui\/(features|components|hooks)\//.test(file) || /^app\//.test(file)
}

function isUseClient(source: ts.SourceFile): boolean {
  const first = source.statements[0]
  return (
    first !== undefined &&
    ts.isExpressionStatement(first) &&
    ts.isStringLiteral(first.expression) &&
    first.expression.text === 'use client'
  )
}

function isArrayFromWithLength(node: ts.Expression): boolean {
  if (!ts.isCallExpression(node)) return false
  const callee = node.expression
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) return false
  if (callee.expression.text !== 'Array' || callee.name.text !== 'from') return false
  const [shape] = node.arguments
  return shape !== undefined && ts.isObjectLiteralExpression(shape) && shape.properties.some(hasLengthKey)
}

function hasLengthKey(property: ts.ObjectLiteralElementLike): boolean {
  if (ts.isPropertyAssignment(property)) return ts.isIdentifier(property.name) && property.name.text === 'length'
  return ts.isShorthandPropertyAssignment(property) && property.name.text === 'length'
}

/** `Promise.all(Array.from({ length: … }, worker))`: a pool of workers, awaited together. */
function isPoolCall(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false
  const callee = node.expression
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) return false
  if (callee.expression.text !== 'Promise' || callee.name.text !== 'all') return false
  const [pool] = node.arguments
  return pool !== undefined && isArrayFromWithLength(pool)
}

/** How many loop signatures the file carries (see the header). */
function countIn(source: ts.SourceFile): number {
  let count = 0
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const isConst = (node.parent.flags & ts.NodeFlags.Const) !== 0
      if (isConst && POOL_WIDTH.test(node.name.text)) count += 1
      const fn = node.initializer
      if (POOL_FUNCTION.test(node.name.text) && fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) count += 1
    }
    if (ts.isFunctionDeclaration(node) && node.name && POOL_FUNCTION.test(node.name.text)) count += 1
    if (isPoolCall(node)) count += 1
    ts.forEachChild(node, visit)
  }
  visit(source)
  return count
}

function sourceOf(file: string, text: string): ts.SourceFile {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  // Parent pointers are needed: a declaration's `const` lives on its list.
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind)
}

/** Every tracked or not-yet-tracked TypeScript file under the source directories (a new file is seen before it is committed). */
function sourceFiles(): string[] {
  const listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'app', 'bff', 'ui', 'i18n', 'shared', 'types', 'utils'], {
    cwd: UI_ROOT,
    encoding: 'utf8',
  })
  // A tracked file deleted in the working tree is listed by git until it is staged; it has no source to read.
  return listed.split('\n').filter((file) => /\.tsx?$/.test(file) && existsSync(path.join(UI_ROOT, file)))
}

function current(): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const file of sourceFiles()) {
    const text = readFileSync(path.join(UI_ROOT, file), 'utf8')
    if (!isBrowserPath(file) && !text.includes('use client')) continue
    const source = sourceOf(file, text)
    if (!isBrowserPath(file) && !isUseClient(source)) continue
    const count = countIn(source)
    if (count > 0) counts[file] = count
  }
  return counts
}

describe('the browser runs no work loop over items (ADR-0121)', () => {
  it('counts the three signatures and not the words in a comment or a string', () => {
    const count = (text: string) => countIn(sourceOf('probe.ts', text))
    expect(count('const MOVE_CONCURRENCY = 2')).toBe(1)
    expect(count('function f() { const CONCURRENCY = 6 }')).toBe(1)
    expect(count('let MOVE_CONCURRENCY = 2')).toBe(0)
    expect(count('const runPool = async () => {}')).toBe(1)
    expect(count('function workerPool() {}')).toBe(1)
    expect(count('await Promise.all(Array.from({ length: n }, worker))')).toBe(1)
    expect(count('await Promise.all(items.map(f))')).toBe(0)
    expect(count('// Promise.all(Array.from({ length: 2 }, w)) and const X_CONCURRENCY = 2')).toBe(0)
    expect(count("const note = 'const MOVE_CONCURRENCY = 2'")).toBe(0)
  })

  const counts = current()
  if (process.env.UPDATE_BROWSER_WORK_LOOPS) {
    const kept: Baseline = {}
    for (const [file, entry] of Object.entries(JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline)) {
      const now = Math.min(entry.count, counts[file] ?? 0)
      if (now > 0) kept[file] = { count: now, reason: entry.reason }
    }
    writeFileSync(BASELINE_PATH, `${JSON.stringify(kept, null, 2)}\n`)
  }
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline

  it('lets no browser file gain a loop, and admits no new file with one', () => {
    const grown = Object.entries(counts)
      .filter(([file, count]) => count > (baseline[file]?.count ?? 0))
      .map(([file, count]) => `${file}: ${baseline[file]?.count ?? 0} -> ${count}`)
    expect(grown, GUIDANCE).toEqual([])
  })

  it('moves the baseline down with every cleanup (UPDATE_BROWSER_WORK_LOOPS=1)', () => {
    const shrunk = Object.entries(baseline)
      .filter(([file, entry]) => (counts[file] ?? 0) < entry.count)
      .map(([file, entry]) => `${file}: ${entry.count} -> ${counts[file] ?? 0}`)
    expect(shrunk, 'rerun with UPDATE_BROWSER_WORK_LOOPS=1 to lower the baseline').toEqual([])
  })
})
