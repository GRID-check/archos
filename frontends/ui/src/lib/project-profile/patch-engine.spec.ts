/**
 * `isPatchAlreadyApplied` tells a lost race that already holds the change from
 * one that does not. Two people confirming the same suggestion on the intake's
 * review write the same fact at two instants: the instants differ (`updatedAt`,
 * a person evidence's `at`, an alternative's `recordedAt`), the value does not.
 */

import { describe, expect, it } from 'vitest'
import { isPatchAlreadyApplied } from './patch-engine'
import type { ProjectProfile, ProjectProfilePatchOperation } from './types'

const fact = (at: string, userId = 'user_1') => ({
  value: 4,
  confidence: 'confirmed' as const,
  source: 'user_confirmed' as const,
  updatedAt: at,
  evidence: [{ kind: 'person' as const, userId, at }],
  alternatives: [{ value: 5, evidence: [{ kind: 'person' as const, userId, at }], recordedAt: at }],
})

const profile = (entry: ReturnType<typeof fact>): ProjectProfile => ({
  facts: { 'geschosse_oberirdisch@bw1': entry },
  goals: {},
  unknowns: [],
  assumptions: {},
})

const write = (entry: ReturnType<typeof fact>): ProjectProfilePatchOperation[] => [
  { op: 'add', path: '/facts/geschosse_oberirdisch@bw1', value: entry },
]

describe('isPatchAlreadyApplied', () => {
  it('counts the same decision written a moment later as already applied', () => {
    const stored = profile(fact('2026-10-14T09:00:00.000Z'))
    expect(isPatchAlreadyApplied(stored, write(fact('2026-10-14T09:00:05.000Z')))).toBe(true)
  })

  it('still sees a different person, or a different value, as a change', () => {
    const stored = profile(fact('2026-10-14T09:00:00.000Z'))
    expect(isPatchAlreadyApplied(stored, write(fact('2026-10-14T09:00:00.000Z', 'user_2')))).toBe(false)
    expect(isPatchAlreadyApplied(stored, write({ ...fact('2026-10-14T09:00:00.000Z'), value: 3 }))).toBe(false)
  })
})
