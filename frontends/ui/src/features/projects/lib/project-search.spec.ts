import { describe, expect, test } from 'vitest'
import type { ProjectProfile } from '@/lib/project-profile/types'
import { projectMatchesQuery, type SearchableProject } from './project-search'

const profile = (values: Record<string, string>): ProjectProfile => ({
  facts: Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      { value, confidence: 'confirmed' as const, source: 'user_confirmed' as const, updatedAt: '2026-01-01T00:00:00Z' },
    ]),
  ),
  goals: {},
  unknowns: [],
  assumptions: {},
})

const seestadt: SearchableProject = {
  name: 'Wohnbau Seestadt Baufeld D12',
  profileDisplay: {
    title: 'Wohnbau Seestadt',
    summary: 'Wohnbau · 214 Wohneinheiten · GK 5 · Wien',
    keyFacts: [{ label: 'Bauherr', value: 'Gemeinnützige Bau- und Siedlungsgenossenschaft' }],
    missingInfo: [],
  },
  profile: profile({ A1: 'Janis-Joplin-Promenade 12, 1220 Wien' }),
}

describe('projectMatchesQuery', () => {
  test('matches the name', () => {
    expect(projectMatchesQuery(seestadt, 'seestadt')).toBe(true)
  })

  test('matches what an architect remembers instead of the name: street, town, client', () => {
    expect(projectMatchesQuery(seestadt, 'joplin')).toBe(true)
    expect(projectMatchesQuery(seestadt, '1220')).toBe(true)
    expect(projectMatchesQuery(seestadt, 'siedlungsgenossenschaft')).toBe(true)
  })

  test('needs every word, in any order', () => {
    expect(projectMatchesQuery(seestadt, 'wien wohnbau')).toBe(true)
    expect(projectMatchesQuery(seestadt, 'wien graz')).toBe(false)
  })

  test('a blank query matches everything and a project without a profile still matches by name', () => {
    expect(projectMatchesQuery({ name: 'Turnsaal' }, '  ')).toBe(true)
    expect(projectMatchesQuery({ name: 'Turnsaal' }, 'turn')).toBe(true)
    expect(projectMatchesQuery({ name: 'Turnsaal' }, 'wien')).toBe(false)
  })

  test('ignores fact values too short to mean anything', () => {
    const project: SearchableProject = { name: 'Alpha', profile: profile({ B1: 'ja' }) }
    expect(projectMatchesQuery(project, 'ja')).toBe(false)
  })
})
