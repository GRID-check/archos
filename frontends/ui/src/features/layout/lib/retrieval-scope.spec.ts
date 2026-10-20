/**
 * @vitest-environment node
 */
import { describe, expect, test } from 'vitest'
import { includeShelvesForTurn } from './retrieval-scope'

describe('includeShelvesForTurn', () => {
  test('a session upload drops the project and the office shelf — but never the law', () => {
    expect(includeShelvesForTurn({ subjectShelf: 'session', preset: 'project' })).toEqual([
      'session',
      'base',
    ])
  })

  test('asking about a project file drops the office shelf', () => {
    expect(includeShelvesForTurn({ subjectShelf: 'project' })).toEqual([
      'project',
      'session',
      'base',
    ])
  })

  test('asking about an office shelf file drops the project corpus', () => {
    expect(includeShelvesForTurn({ subjectShelf: 'office_shelf' })).toEqual([
      'office_shelf',
      'session',
      'base',
    ])
  })

  /**
   * A subject says which DOCUMENTS the turn is about. It is not a statement
   * that the reader no longer wants the building code applied — and applying it
   * is what this product is for. The asymmetry that exposed the bug is pinned
   * two tests down: the `project` PRESET always kept `base`, and the `project`
   * SHELF did not, although a reader reaches for either to say the same thing.
   */
  test('no subject shelf costs the turn its building code', () => {
    for (const subjectShelf of ['session', 'project', 'office_shelf'] as const) {
      expect(includeShelvesForTurn({ subjectShelf })).toContain('base')
    }
  })

  test('the project documents chip keeps law + session, not the office shelf', () => {
    expect(includeShelvesForTurn({ preset: 'project' })).toEqual(['project', 'session', 'base'])
  })

  test('the office shelf chip keeps law + session, not project files', () => {
    expect(includeShelvesForTurn({ preset: 'office' })).toEqual(['office_shelf', 'session', 'base'])
  })

  test('the Baurecht chip stays on the base corpus', () => {
    expect(includeShelvesForTurn({ preset: 'law' })).toEqual(['base'])
  })

  test('no commitment leaves the signed scope alone', () => {
    expect(includeShelvesForTurn({})).toBeUndefined()
  })
})
