import { describe, expect, it } from 'vitest'
import { foldSearchText, operationScorer, searchWordGroups } from './operation-search'

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
})
