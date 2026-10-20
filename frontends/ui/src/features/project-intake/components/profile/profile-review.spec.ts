/**
 * What step 5 shows of the review: which rows come up front, what folds by
 * topic, what „take all" sends, and the words a row and the class card use.
 */
import { describe, expect, it } from 'vitest'
import { PROFILE_CONFIRMED, PROFILE_REVIEW } from '@/app/dev/_fixtures/project-setup-profile'
import { DERIVATION_OPEN, DERIVATION_READY } from '@/app/dev/_fixtures/project-intake'
import {
  documentName,
  findings,
  leadDerivation,
  reasonInputs,
  restByTopic,
  shortLabel,
  takeAllDecisions,
  topFindings,
} from './profile-review'

const keys = (items: readonly { key: string }[]) => items.map((item) => item.key)

describe('profileReview', () => {
  it('leaves a contested value out of the table: the Rückfragen decide it', () => {
    expect(keys(findings(PROFILE_REVIEW.groups))).not.toContain('geschosse_oberirdisch@bw1')
  })

  it('puts the decisive suggestions first, then the class’s inputs, then what a document says', () => {
    expect(keys(topFindings(PROFILE_REVIEW.groups, PROFILE_REVIEW.derivations))).toEqual([
      'fluchtniveau_m@bw1',
      'nutzungseinheiten@bw1',
      'bauwerkstyp@bw1',
      'gebaeudestellung@bw1',
      'oib_ausgabe',
    ])
  })

  it('keeps a confirmed input of the class up front once nothing decisive is open', () => {
    const top = keys(topFindings(PROFILE_CONFIRMED.groups, PROFILE_CONFIRMED.derivations))
    expect(top).toContain('geschosse_oberirdisch@bw1')
    expect(top).not.toContain('standort_adresse')
  })

  it('folds the rest by topic, without the rows shown and without an empty topic', () => {
    const top = topFindings(PROFILE_REVIEW.groups, PROFILE_REVIEW.derivations)
    const rest = restByTopic(PROFILE_REVIEW.groups, top)
    expect(rest.map((group) => group.stage)).toEqual(['A'])
    expect(keys(rest[0].items)).toEqual(['standort_adresse', 'projektphase'])
  })

  it('takes every open suggestion at once, never a confirmed or contested one', () => {
    expect(takeAllDecisions(PROFILE_REVIEW.groups)).toEqual([
      { key: 'oib_ausgabe', action: 'confirm' },
      { key: 'bauwerkstyp@bw1', action: 'confirm' },
      { key: 'fluchtniveau_m@bw1', action: 'confirm' },
      { key: 'gebaeudestellung@bw1', action: 'confirm' },
      { key: 'nutzungseinheiten@bw1', action: 'confirm' },
    ])
  })

  it('shortens a label and a file name the way the table shows them', () => {
    expect(shortLabel('Anzahl Nutzungseinheiten (Wohnungen + Betriebseinheiten, Zielzustand)')).toBe('Anzahl Nutzungseinheiten')
    expect(shortLabel('(Zielzustand)')).toBe('(Zielzustand)')
    expect(documentName('E-02 Schnitt A-A.pdf')).toBe('E-02 Schnitt A-A')
    expect(documentName('Wohnungsliste.xlsx')).toBe('Wohnungsliste')
    expect(documentName('Bescheid.v2.final')).toBe('Bescheid.v2.final')
    expect(documentName('README')).toBe('README')
  })

  it('opens the class card on the Bauwerk with a class to take', () => {
    expect(leadDerivation([DERIVATION_OPEN, DERIVATION_READY])?.bauwerkId).toBe('bw1')
    expect(leadDerivation([DERIVATION_OPEN])?.bauwerkId).toBe('bw2')
    expect(leadDerivation([])).toBeNull()
  })

  it('names at most three inputs in the one-line reason, the escape level first', () => {
    expect(reasonInputs(DERIVATION_READY).map((input) => input.base)).toEqual([
      'fluchtniveau_m',
      'geschosse_oberirdisch',
      'nutzungseinheiten',
    ])
  })
})
