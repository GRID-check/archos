/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'

import { buildProjectBriefView } from './brief-view'
import {
  normalizeProfilePatchOperations,
  pruneResolvedAssumptions,
  pruneResolvedUnknowns,
} from './patch-engine'
import type { ProjectProfile } from './types'

const NOW = '2026-07-08T00:00:00.000Z'

function fact(value: ProjectProfile['facts'][string]['value']): ProjectProfile['facts'][string] {
  return { value, confidence: 'confirmed', source: 'onboarding', updatedAt: NOW }
}

describe('buildProjectBriefView', () => {
  const profile: ProjectProfile = {
    facts: {
      project_name: fact('Wohnhaus Lerchenfelder'),
      federal_state: fact('vienna'),
      work_type: fact(['new_build']),
      // Scoped building facts + the structural building-name fact used to label them.
      'building_name@bldg1': fact('Haupthaus'),
      'building_type@bldg1': fact('building'),
      'storeys_above_ground@bldg1': fact(5),
      custom_agent_fact: fact('brandschutzkonzept liegt vor'),
    },
    goals: {},
    unknowns: ['escape_level_m@bldg1', 'escape_level_m@bldg1', 'federal_state'],
    assumptions: {
      zoning: {
        value: 'residential',
        status: 'unconfirmed',
        reason: 'Typical for the district per the uploaded plan.',
        source: 'agent_suggested',
        updatedAt: NOW,
      },
    },
  }

  it('groups facts by intake stage with question/option labels, in intake order', () => {
    const view = buildProjectBriefView(profile)
    expect(view.groups.map((g) => g.id)).toEqual(['A', 'C', 'other'])
    const a = view.groups.find((g) => g.id === 'A')!
    expect(a.facts).toEqual([
      expect.objectContaining({ key: 'federal_state', label: 'Bundesland', value: 'Wien' }),
      expect.objectContaining({
        key: 'work_type',
        label: 'Art des Vorhabens (Projekt gesamt)',
        value: 'Neubau',
      }),
    ])
    const c = view.groups.find((g) => g.id === 'C')!
    // Scoped keys resolve to their base question label, suffixed with the building name.
    expect(c.facts).toEqual([
      expect.objectContaining({ key: 'building_type@bldg1', label: 'Bauwerkstyp · Haupthaus' }),
      expect.objectContaining({
        key: 'storeys_above_ground@bldg1',
        label: 'Anzahl oberirdischer Geschoße (Zielzustand) · Haupthaus',
        value: '5',
      }),
    ])
  })

  it('hides project_name and bauwerk_name structural keys, humanizes unknown keys', () => {
    const view = buildProjectBriefView(profile)
    const allKeys = view.groups.flatMap((g) => g.facts.map((f) => f.key))
    expect(allKeys).not.toContain('project_name')
    expect(allKeys).not.toContain('building_name@bldg1')
    const other = view.groups.find((g) => g.id === 'other')!
    expect(other.facts).toEqual([
      expect.objectContaining({
        label: 'Custom agent fact',
        value: 'brandschutzkonzept liegt vor',
      }),
    ])
  })

  it('dedupes unknowns, drops answered ones, resolves scoped labels', () => {
    const view = buildProjectBriefView(profile)
    // `federal_state` is answered by a fact → dropped; the scoped escape-level unknown remains.
    expect(view.missing).toEqual([
      { key: 'escape_level_m@bldg1', label: 'Fluchtniveau (Zielzustand)' },
    ])
  })

  it('exposes assumptions with display and raw values', () => {
    const view = buildProjectBriefView(profile)
    expect(view.assumptions).toEqual([
      expect.objectContaining({
        key: 'zoning',
        label: 'Flächenwidmung (Kategorie)',
        value: 'Wohngebiet',
        rawValue: 'residential',
        reason: 'Typical for the district per the uploaded plan.',
      }),
    ])
  })

  it('counts completeness as answered vs answered+missing', () => {
    const view = buildProjectBriefView(profile)
    // project_name + building_name@bldg1 hidden → 5 visible facts.
    expect(view.answeredCount).toBe(5)
    expect(view.totalCount).toBe(6) // + the one remaining scoped unknown
  })

  it('tolerates malformed input by falling back to an empty profile', () => {
    const view = buildProjectBriefView({ facts: 'garbage' })
    expect(view.groups).toEqual([])
    expect(view.totalCount).toBe(0)
  })
})

describe('normalizeProfilePatchOperations', () => {
  it('wraps a bare fact value with user_confirmed provenance', () => {
    const [op] = normalizeProfilePatchOperations(
      [{ op: 'add', path: '/facts/building_class', value: 'GK5' }],
      NOW
    )
    expect(op.value).toEqual({
      value: 'GK5',
      confidence: 'confirmed',
      source: 'user_confirmed',
      updatedAt: NOW,
    })
  })

  it('wraps a bare assumption value as unconfirmed agent_suggested', () => {
    const [op] = normalizeProfilePatchOperations(
      [{ op: 'add', path: '/assumptions/land_designation', value: 'bauland' }],
      NOW
    )
    expect(op.value).toEqual({
      value: 'bauland',
      status: 'unconfirmed',
      reason: '',
      source: 'agent_suggested',
      updatedAt: NOW,
    })
  })

  it('leaves complete objects, removes, deep paths and other sections untouched', () => {
    const ops = normalizeProfilePatchOperations(
      [
        { op: 'add', path: '/facts/land_designation', value: fact('bauland') },
        { op: 'remove', path: '/assumptions/land_designation' },
        { op: 'replace', path: '/facts/land_designation/value', value: 'freiland' },
        { op: 'add', path: '/unknowns/-', value: 'escape_level' },
      ],
      NOW
    )
    expect(ops[0].value).toEqual(fact('bauland'))
    expect(ops[1]).toEqual({ op: 'remove', path: '/assumptions/land_designation' })
    expect(ops[2].value).toBe('freiland')
    expect(ops[3].value).toBe('escape_level')
  })
})

describe('pruneResolvedUnknowns', () => {
  it('drops unknowns answered by a fact and dedupes, preserving open ones', () => {
    const profile: ProjectProfile = {
      facts: { building_class: fact('GK4') },
      goals: {},
      unknowns: ['building_class', 'escape_level', 'escape_level'],
      assumptions: {},
    }
    expect(pruneResolvedUnknowns(profile).unknowns).toEqual(['escape_level'])
  })

  it('returns the same object when nothing changes', () => {
    const profile: ProjectProfile = {
      facts: {},
      goals: {},
      unknowns: ['escape_level'],
      assumptions: {},
    }
    expect(pruneResolvedUnknowns(profile)).toBe(profile)
  })
})

describe('pruneResolvedAssumptions', () => {
  const assumption = (value: string): ProjectProfile['assumptions'][string] => ({
    value,
    status: 'unconfirmed',
    reason: 'Defaulted for projects created before the location question existed.',
    source: 'onboarding_default',
    updatedAt: NOW,
  })

  it('drops an assumption once a confirmed fact exists under the same key', () => {
    // The migration-backfilled federal_state=vienna default must vanish when the
    // user answers the location question — never two jurisdictions at once.
    const profile: ProjectProfile = {
      facts: { federal_state: fact('tyrol') },
      goals: {},
      unknowns: [],
      assumptions: { federal_state: assumption('vienna'), land_designation: assumption('bauland') },
    }

    const pruned = pruneResolvedAssumptions(profile)

    expect(pruned.assumptions).toEqual({ land_designation: assumption('bauland') })
  })

  it('returns the same object when no assumption is superseded', () => {
    const profile: ProjectProfile = {
      facts: { main_use: fact('residential') },
      goals: {},
      unknowns: [],
      assumptions: { federal_state: assumption('vienna') },
    }

    expect(pruneResolvedAssumptions(profile)).toBe(profile)
  })
})
