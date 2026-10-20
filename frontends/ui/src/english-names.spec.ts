/**
 * @vitest-environment node
 */

/**
 * No new German identifier in the UI (AGENTS.md: every name in code is English,
 * domain words included). The Python half is `tests/test_english_names.py`; both
 * read the stems in `ci/german_stems.json`.
 *
 * A ratchet, not a ban: `english-names-baseline.json` holds how many German
 * identifiers each file had when this check arrived, and a file may only go
 * down. Over its count fails: rename the new name. Under its count fails too, so
 * the baseline follows every cleanup: rerun with UPDATE_ENGLISH_NAMES=1.
 *
 * Only identifiers are read, through the TypeScript parser, and split into their
 * words. A string, a comment and JSX text are never checked, so German copy,
 * document names and legal citations stay as they are; a key written as a
 * string (`'bundesland': …` in a legacy-name map) is data, not a name.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript-api'
import { describe, expect, it } from 'vitest'

const UI_ROOT = path.resolve(__dirname, '..')
const REPO_ROOT = path.resolve(UI_ROOT, '../..')
const BASELINE_PATH = path.join(UI_ROOT, 'english-names-baseline.json')
const STEMS = (JSON.parse(readFileSync(path.join(REPO_ROOT, 'ci', 'german_stems.json'), 'utf8')) as { stems: string[] })
  .stems
const GERMAN = new RegExp(STEMS.join('|'))
const WORDS = /[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+/g

/** The words of `identifier` that carry a German stem (`federalState` → [], `bundeslandId` → ['bundesland']). */
function germanWords(identifier: string): string[] {
  const words = identifier.split('_').flatMap((part) => part.match(WORDS) ?? [])
  return words.map((word) => word.toLowerCase()).filter((word) => GERMAN.test(word))
}

function sourceFiles(): string[] {
  const listed = execFileSync('git', ['ls-files', '*.ts', '*.tsx', '*.mts', '*.mjs', '*.js'], {
    cwd: UI_ROOT,
    encoding: 'utf8',
  })
  return listed.split('\n').filter((file) => file && !file.startsWith('public/'))
}

function countIn(file: string): number {
  const text = readFileSync(path.join(UI_ROOT, file), 'utf8')
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : file.endsWith('.ts') || file.endsWith('.mts') ? ts.ScriptKind.TS : ts.ScriptKind.JS
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, kind)
  let count = 0
  const visit = (node: ts.Node): void => {
    if ((ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) && germanWords(node.text).length > 0) count += 1
    ts.forEachChild(node, visit)
  }
  visit(source)
  return count
}

function current(): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const file of sourceFiles()) {
    const count = countIn(file)
    if (count > 0) counts[file] = count
  }
  return counts
}

describe('every name in the UI is English', () => {
  it('reads identifiers by their words, not their substrings', () => {
    expect(germanWords('bundeslandSource')).toEqual(['bundesland'])
    expect(germanWords('GebaeudeklasseInput')).toEqual(['gebaeudeklasse'])
    expect(germanWords('federalState')).toEqual([])
    // `archiv` is German, `archive` is English: the soft-delete names stay legal.
    expect(germanWords('archivedAt')).toEqual([])
    expect(germanWords('archiv_scope')).toEqual(['archiv'])
  })

  const counts = current()
  if (process.env.UPDATE_ENGLISH_NAMES) {
    const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
    writeFileSync(BASELINE_PATH, `${JSON.stringify(sorted, null, 2)}\n`)
  }
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Record<string, number>

  it('lets no file gain a German identifier', () => {
    const grown = Object.entries(counts)
      .filter(([file, count]) => count > (baseline[file] ?? 0))
      .map(([file, count]) => `${file}: ${baseline[file] ?? 0} -> ${count}`)
    // Name it in English (docs/glossary.md, "German domain term, English code name").
    expect(grown).toEqual([])
  })

  it('moves the baseline down with every cleanup (UPDATE_ENGLISH_NAMES=1)', () => {
    const shrunk = Object.entries(baseline)
      .filter(([file, count]) => (counts[file] ?? 0) < count)
      .map(([file, count]) => `${file}: ${count} -> ${counts[file] ?? 0}`)
    expect(shrunk).toEqual([])
  })
})
