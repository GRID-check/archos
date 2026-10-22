/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { MAX_RESULT_CHARS } from './discovery'
import { fittedHits, HIT_TEXT_BUDGET, withOperationNames, withRankedOrderNote } from './door-text'

const NAMES = {
  knowledge_search: 'knowledge-search',
  read_passage: 'passage-read',
  list_files: 'files-list',
  look: 'document-look',
  ris_lookup_tool: 'law-lookup',
}

describe('withOperationNames', () => {
  it('spells a call the way call-operation takes it', () => {
    expect(
      withOperationNames('Open another match with `read_passage(document=…, page=…)`.', NAMES)
    ).toBe('Open another match with `passage-read` with input {document=…, page=…}.')
  })

  it('renames a backticked or bare tool and leaves other words alone', () => {
    expect(withOperationNames('`list_files` shows it; knowledge_search finds it.', NAMES)).toBe(
      '`files-list` shows it; knowledge-search finds it.'
    )
    expect(withOperationNames('Look at the page; `look` shows it. ris_lookup_tool', NAMES)).toBe(
      'Look at the page; `document-look` shows it. law-lookup'
    )
  })
})

describe('withRankedOrderNote', () => {
  it('says what the order of the hits is, after the count line', () => {
    const out = withRankedOrderNote('Found 25 relevant document(s):\n\n--- Result 1 ---')
    expect(out).toMatch(/^Found 25 passages:\n\(Ranked hits are in the search/)
    expect(out).toContain('--- Result 1 ---')
  })

  it('counts documents, not passages, for a search grouped by document', () => {
    const out = withRankedOrderNote('Found 7 relevant document(s):\n\n--- Result 1 ---', true)
    expect(out).toMatch(/^Found 7 documents:\n/)
    expect(out).not.toContain('configured limit')
  })

  it('leaves an answer without a count line alone', () => {
    expect(withRankedOrderNote('No relevant documents found')).toBe('No relevant documents found')
  })
})

describe('fittedHits', () => {
  const hit = (n: number, size: number) =>
    `--- Result ${n} ---\nSource: Doc ${n}\nCitation: doc-${n}.pdf, p.${n}\nPage: ${n}\n\n${'x'.repeat(size)}\n\n`
  const answer = (count: number, size: number) =>
    `Found ${count} passages:\n\n${Array.from({ length: count }, (_, i) => hit(i + 1, size)).join('')}`

  it('leaves an answer that fits alone', () => {
    const text = answer(3, 100)
    expect(fittedHits(text)).toBe(text)
  })

  it('keeps every hit and its citation when the hits would not fit, shortening each passage instead', () => {
    const out = fittedHits(answer(25, 2_000))
    expect(out.length).toBeLessThanOrEqual(HIT_TEXT_BUDGET)
    for (let n = 1; n <= 25; n++) expect(out).toContain(`Citation: doc-${n}.pdf, p.${n}`)
    expect(out).toContain('read the whole passage with `passage-read`')
  })

  it('stays within budget when a hit’s metadata takes most of its share', () => {
    const longMeta = (n: number) =>
      `--- Result ${n} ---\nSource: ${'S'.repeat(600)}\nCitation: doc-${n}.pdf, p.${n}\n\n${'x'.repeat(2_000)}\n\n`
    const text = `Found 50 passages:\n\n${Array.from({ length: 50 }, (_, i) => longMeta(i + 1)).join('')}`
    const out = fittedHits(text)
    expect(out.length).toBeLessThanOrEqual(HIT_TEXT_BUDGET)
    for (let n = 1; n <= 50; n++) expect(out).toContain(`Citation: doc-${n}.pdf, p.${n}`)
  })

  it('stays under the cut the door makes at the end of every result', () => {
    expect(HIT_TEXT_BUDGET).toBeLessThan(MAX_RESULT_CHARS)
  })
})
