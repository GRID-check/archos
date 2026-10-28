/**
 * Every reason `getApplicableStandards` can give has German words on the
 * Steckbrief: a new verdict with an English sentence nobody keyed fails here,
 * before it reaches a German reader as English.
 */
import { describe, expect, it } from 'vitest'
import { de, en } from '@/i18n/dictionaries'
import { getApplicableStandards } from '@/lib/oib/applicable-standards'
import { OIB_STANDARDS } from '@/lib/oib/standards-catalog'
import type { ProjectPrimitiveValue, ProjectProfile } from '@/lib/project-profile/types'
import { byStatus, STANDARD_REASON_IDS, standardReasonId, standardShortId } from './standard-reasons'

const profile = (facts: Record<string, ProjectPrimitiveValue>): ProjectProfile => ({
  facts: Object.fromEntries(
    Object.entries(facts).map(([key, value]) => [
      key,
      { value, confidence: 'confirmed' as const, source: 'onboarding' as const, updatedAt: '2026-10-20T08:00:00.000Z' },
    ])
  ),
  goals: {},
  unknowns: [],
  assumptions: {},
})

/** Profiles that between them reach every branch of the verdicts. */
const PROFILES: Array<ProjectProfile | null> = [
  null,
  profile({ project_phase: 'design' }),
  ...['manufacturing', 'storage', 'agriculture', 'other', 'residential', 'lodging', 'office', 'healthcare', 'assembly'].map(
    (main_use) => profile({ main_use })
  ),
  profile({ main_use: 'residential', building_class: 'GK5' }),
  profile({ main_use: 'residential', 'escape_level_m@bldg1': 24.6, 'storeys_below_ground@bldg1': 1 }),
]

describe('standard reasons', () => {
  it('keys every reason the verdicts give, so none reaches a German reader in English', () => {
    const reasons = new Set(PROFILES.flatMap((p) => getApplicableStandards(p).map((standard) => standard.reason)))
    for (const reason of reasons) expect(standardReasonId(reason), reason).not.toBeNull()
    const used = new Set([...reasons].map(standardReasonId))
    expect([...used].sort()).toEqual([...STANDARD_REASON_IDS].sort())
  })

  it('has words for every key in both languages', () => {
    for (const id of STANDARD_REASON_IDS) {
      expect(de.intakeProfileStep.rules.reasons[id]).toBeTruthy()
      expect(en.intakeProfileStep.rules.reasons[id]).toBeTruthy()
    }
  })

  it('has a short name for every Richtlinie in the catalog', () => {
    for (const standard of OIB_STANDARDS) expect(standardShortId(standard.code), standard.code).not.toBeNull()
    expect(standardShortId('OIB 9')).toBeNull()
  })

  it('orders required, then likely, then to check, keeping the catalog order within each', () => {
    const ordered = byStatus([
      { code: 'a', status: 'check' as const },
      { code: 'b', status: 'required' as const },
      { code: 'c', status: 'likely' as const },
      { code: 'd', status: 'required' as const },
    ])
    expect(ordered.map((standard) => standard.code)).toEqual(['b', 'd', 'c', 'a'])
  })
})
