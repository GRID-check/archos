/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { foldSearchText, operationScorer, searchWordGroups, stemSearchWord } from './operation-search'

const memberAdd = {
  name: 'project-member-add',
  summary: 'Add a person to a project',
  description: 'Adds an organization member to a project with a role.',
}
const summaryGenerate = {
  name: 'project-summary-generate',
  summary: 'Generate the project summary',
  description: 'Writes a short summary of the project from its documents.',
}

describe('foldSearchText', () => {
  it('spells German letters out instead of cutting the word at them', () => {
    expect(foldSearchText('Hinzufügen Größe')).toBe('hinzufuegen groesse')
  })
})

describe('searchWordGroups', () => {
  it('keeps a word with an umlaut whole and adds what it means in the catalog', () => {
    expect(searchWordGroups('Mitglied hinzufügen')).toEqual([
      ['mitglied', 'member'],
      ['hinzufuegen', 'add'],
    ])
  })

  it('matches an inflected word by the term it starts with, and a short term only whole', () => {
    expect(searchWordGroups('Mitglieder')).toEqual([['mitglieder', 'member']])
    expect(searchWordGroups('neu')).toEqual([['neu', 'create']])
    expect(searchWordGroups('neubau')).toEqual([['neubau']])
  })

  it.each([
    ['Auftraggeber', 'task'],
    ['Eingangsbereich', 'inbox'],
    ['Kostenschätzung', 'budget'],
    ['rechtzeitig', 'role'],
    ['Rechtslage', 'role'],
  ])('does not read %s as a form of a shorter term (no %s)', (word, wrong) => {
    expect(searchWordGroups(word).flat()).not.toContain(wrong)
  })

  it.each([
    ['Aufträge', 'task'],
    ['Eingangs', 'inbox'],
    ['Kosten', 'budget'],
    ['Rechte', 'role'],
    ['Einladung', 'add'],
    ['archivieren', 'archive'],
    ['Zuständigkeit', 'assignment'],
  ])('still reads the inflected %s as its term (%s)', (word, meaning) => {
    expect(searchWordGroups(word).flat()).toContain(meaning)
  })

  it('reads Freigabe as an approval, not a release', () => {
    for (const word of ['Freigabe', 'freigeben']) {
      expect(searchWordGroups(word).flat()).toContain('approve')
      expect(searchWordGroups(word).flat()).not.toContain('release')
    }
  })

  it('splits a compound of two terms into two words', () => {
    expect(searchWordGroups('Projektmitglieder')).toEqual([
      ['projekt', 'project'],
      ['mitglied', 'member'],
    ])
  })

  it('leaves English as it is', () => {
    expect(searchWordGroups('add member')).toEqual([['add'], ['member']])
  })
})

describe('operationScorer', () => {
  it('ranks the operation a German request means above one that only shares a fragment', () => {
    const score = operationScorer('Mitglied zu Projekt hinzufügen')
    expect(score(memberAdd)).toBeGreaterThan(score(summaryGenerate))
  })

  it('counts a German word and its meaning as one word for the all-words bonus', () => {
    const german = operationScorer('Mitglied hinzufügen')(memberAdd)
    const english = operationScorer('member add')(memberAdd)
    expect(german).toBe(english)
  })

  it('scores every operation 1 for an empty query, and 0 for one it does not answer', () => {
    expect(operationScorer('')(memberAdd)).toBe(1)
    expect(operationScorer('Bauklasse')(memberAdd)).toBe(0)
  })

  it('drops one-letter words, and scores 0 for text that has no usable word left', () => {
    expect(searchWordGroups('a member')).toEqual([['member']])
    expect(operationScorer('a')(memberAdd)).toBe(0)
    expect(operationScorer('(a+)+$')(memberAdd)).toBe(0)
  })

  it('matches whole words, never a fragment inside one', () => {
    const restore = { name: 'project-restore', summary: 'Restore a deleted project', description: 'Brings it back.' }
    expect(operationScorer('to')(restore)).toBe(0)
  })

  it('weighs a word by how rare it is among the operations ranked', () => {
    const knowledge = { name: 'knowledge-search', summary: 'Search the OIB guidelines of a project', description: 'Passages.' }
    const corpus = [memberAdd, summaryGenerate, knowledge]
    const score = operationScorer('OIB project', corpus)
    expect(score(knowledge)).toBeGreaterThan(score(memberAdd))
  })

  it('ignores the grammar of a question unless nothing else is left', () => {
    expect(operationScorer('which of the member')(memberAdd)).toBe(operationScorer('member')(memberAdd))
    expect(operationScorer('what')(memberAdd)).toBe(0)
  })
})

describe('stemSearchWord', () => {
  it('meets the plural and the past at the stem, and leaves short words alone', () => {
    expect(stemSearchWord('guidelines')).toBe(stemSearchWord('guideline'))
    expect(stemSearchWord('failed')).toBe('fail')
    expect(stemSearchWord('tasks')).toBe('task')
    expect(stemSearchWord('searches')).toBe('search')
    expect(stemSearchWord('access')).toBe('access')
    expect(stemSearchWord('ask')).toBe('ask')
  })
})
