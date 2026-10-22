/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { withOperationNames, withRankedOrderNote } from './door-text'

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
    expect(out).toMatch(/^Found 25 relevant document\(s\):\n\(Ranked hits are in the search/)
    expect(out).toContain('--- Result 1 ---')
  })

  it('leaves an answer without a count line alone', () => {
    expect(withRankedOrderNote('No relevant documents found')).toBe('No relevant documents found')
  })
})
