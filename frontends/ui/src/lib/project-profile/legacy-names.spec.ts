import { describe, expect, it } from 'vitest'
import names from './legacy-names.json'
import { BUILDING_ID_PREFIX } from './intake-definition'
import {
  LEGACY_PROFILE_KEYS,
  LEGACY_PROFILE_TOKENS,
  normalizeBuildingId,
  normalizeLegacyProfile,
  normalizeLegacyPromptView,
  normalizeProfileKey,
  normalizeProfilePatchOperation,
  normalizeProfilePatchPath,
  normalizeProfileValue,
} from './legacy-names'

describe('the legacy name tables', () => {
  it('map every old name to one new name, and no new name is an old one', () => {
    const olds = Object.keys(LEGACY_PROFILE_KEYS)
    const news = Object.values(LEGACY_PROFILE_KEYS)
    expect(new Set(news).size).toBe(news.length)
    expect(news.filter((name) => olds.includes(name))).toEqual([])
    for (const table of Object.values(LEGACY_PROFILE_TOKENS)) {
      const tokens = Object.values(table)
      expect(new Set(tokens).size).toBe(tokens.length)
      expect(tokens.filter((token) => token in table)).toEqual([])
    }
  })

  it('name only new keys in the token table', () => {
    const news = new Set(Object.values(LEGACY_PROFILE_KEYS))
    for (const key of Object.keys(LEGACY_PROFILE_TOKENS)) expect(news.has(key)).toBe(true)
  })

  it('agree with the building id the definition mints', () => {
    expect(names.building).toEqual({ legacyPrefix: 'bw', prefix: BUILDING_ID_PREFIX })
  })
})

describe('normalizeProfileKey', () => {
  it('renames the base, the building and the zone', () => {
    expect(normalizeProfileKey('bundesland')).toBe('federal_state')
    expect(normalizeProfileKey('geschosse_oberirdisch@bw12')).toBe('storeys_above_ground@bldg12')
    expect(normalizeProfileKey('wohneinheiten@bw1@wohnen')).toBe('dwelling_units@bldg1@residential')
    expect(normalizeProfileKey('gebaeudeklasse@bw2')).toBe('building_class@bldg2')
    expect(normalizeProfileKey('bauwerk_name@bw1')).toBe('building_name@bldg1')
  })

  it('leaves a new or unknown key alone, and is idempotent', () => {
    for (const key of ['federal_state', 'project_name', 'country', 'agent_invented', 'building_class@bldg3@office']) {
      expect(normalizeProfileKey(key)).toBe(key)
    }
    expect(normalizeProfileKey(normalizeProfileKey('nutzungen@bw1'))).toBe('uses@bldg1')
  })
})

describe('normalizeProfileValue', () => {
  it('maps a token by its key, new or old', () => {
    expect(normalizeProfileValue('bundesland', 'wien')).toBe('vienna')
    expect(normalizeProfileValue('federal_state', 'wien')).toBe('vienna')
    expect(normalizeProfileValue('nutzungen@bw1', ['wohnen', 'buero'])).toEqual(['residential', 'office'])
    expect(normalizeProfileValue('erschliessung', 'ja')).toBe('yes')
  })

  it('keeps an identical word where the key does not map it', () => {
    expect(normalizeProfileValue('bebauungsplan', 'ja')).toBe('ja')
    expect(normalizeProfileValue('federal_state', 'salzburg')).toBe('salzburg')
    expect(normalizeProfileValue('federal_state', 7)).toBe(7)
  })
})

describe('normalizeLegacyProfile', () => {
  const stored = {
    facts: {
      bundesland: { value: 'wien', confidence: 'confirmed', source: 'onboarding', updatedAt: 'x' },
      'gebaeudeklasse@bw1': {
        value: 3,
        confidence: 'confirmed',
        source: 'onboarding',
        updatedAt: 'x',
        evidence: [
          { kind: 'derivation', rule: 'gebaeudeklasse', citation: 'OIB-RL 2', inputs: [{ key: 'geschosse_oberirdisch@bw1', value: 3, suggested: false }] },
        ],
      },
    },
    goals: { kontext_ziele: 'x' },
    unknowns: ['bgf_oberirdisch@bw1'],
    assumptions: {
      'nutzungen@bw1': { value: ['wohnen'], status: 'unconfirmed', reason: 'r', source: 'agent_suggested', updatedAt: 'x', alternatives: [{ value: ['buero'], evidence: [], recordedAt: 'x' }] },
    },
  }

  it('renames keys, tokens, building ids and derivation evidence everywhere', () => {
    const out = normalizeLegacyProfile(stored) as typeof stored
    expect(Object.keys(out.facts)).toEqual(['federal_state', 'building_class@bldg1'])
    expect(out.facts['federal_state' as keyof typeof out.facts]).toMatchObject({ value: 'vienna' })
    expect(JSON.stringify(out.facts)).toContain('"rule":"building_class"')
    expect(JSON.stringify(out.facts)).toContain('"key":"storeys_above_ground@bldg1"')
    expect(Object.keys(out.goals)).toEqual(['context_goals'])
    expect(out.unknowns).toEqual(['gfa_above_ground@bldg1'])
    expect(JSON.stringify(out.assumptions)).toContain('["residential"]')
    expect(JSON.stringify(out.assumptions)).toContain('["office"]')
  })

  it('is idempotent and does not mutate its argument', () => {
    const before = JSON.stringify(stored)
    const once = normalizeLegacyProfile(stored)
    expect(JSON.stringify(stored)).toBe(before)
    expect(normalizeLegacyProfile(once)).toEqual(once)
  })

  it('lets the new-name entry win when both are present', () => {
    const out = normalizeLegacyProfile({
      facts: { bundesland: { value: 'wien' }, federal_state: { value: 'tirol' } },
    }) as { facts: Record<string, { value: string }> }
    expect(out.facts).toEqual({ federal_state: { value: 'tyrol' } })
  })

  it('returns what is not a profile object as it came', () => {
    expect(normalizeLegacyProfile(null)).toBeNull()
    expect(normalizeLegacyProfile('x')).toBe('x')
  })
})

describe('profile patches', () => {
  it('renames a path, with or without /value and with the encoded @ suffix', () => {
    expect(normalizeProfilePatchPath('/facts/bundesland')).toBe('/facts/federal_state')
    expect(normalizeProfilePatchPath('/facts/bundesland/value')).toBe('/facts/federal_state/value')
    expect(normalizeProfilePatchPath('/assumptions/fluchtniveau_m@bw1')).toBe('/assumptions/escape_level_m@bldg1')
    expect(normalizeProfilePatchPath('/unknowns/-')).toBe('/unknowns/-')
    expect(normalizeProfilePatchPath('/facts/federal_state')).toBe('/facts/federal_state')
  })

  it('renames the token of a bare value, of an envelope and the key an unknowns append names', () => {
    expect(normalizeProfilePatchOperation({ op: 'add', path: '/facts/bundesland', value: 'wien' })).toEqual({
      op: 'add',
      path: '/facts/federal_state',
      value: 'vienna',
    })
    expect(
      normalizeProfilePatchOperation({ op: 'add', path: '/facts/bundesland', value: { value: 'tirol', confidence: 'confirmed' } })
    ).toEqual({ op: 'add', path: '/facts/federal_state', value: { value: 'tyrol', confidence: 'confirmed' } })
    expect(normalizeProfilePatchOperation({ op: 'add', path: '/unknowns/-', value: 'bgf_oberirdisch@bw1' })).toEqual({
      op: 'add',
      path: '/unknowns/-',
      value: 'gfa_above_ground@bldg1',
    })
    const current = { op: 'add', path: '/facts/federal_state', value: 'vienna' }
    expect(normalizeProfilePatchOperation(current)).toBe(current)
  })
})

describe('normalizeLegacyPromptView', () => {
  it('renames the keys and tokens of every line form', () => {
    const view = [
      'PROJECT_CONTEXT v1',
      '',
      'confirmed:',
      '- bundesland=wien',
      '- nutzungen@bw1=wohnen,buero',
      '- project_name=Haus Wien',
      '',
      'unknown:',
      '- bgf_oberirdisch@bw1',
      '',
      'assumptions:',
      '- erschliessung=teilweise [Vorschlag: a.pdf, S. 2]',
      '',
      'contested:',
      '- bundesland: wien | alternativ: tirol (a.pdf, S. 1)',
    ].join('\n')
    expect(normalizeLegacyPromptView(view)).toBe(
      [
        'PROJECT_CONTEXT v1',
        '',
        'confirmed:',
        '- federal_state=vienna',
        '- uses@bldg1=residential,office',
        '- project_name=Haus Wien',
        '',
        'unknown:',
        '- gfa_above_ground@bldg1',
        '',
        'assumptions:',
        '- servicing=partial [Vorschlag: a.pdf, S. 2]',
        '',
        'contested:',
        '- federal_state: vienna | alternativ: tyrol (a.pdf, S. 1)',
      ].join('\n')
    )
  })

  it('renames nothing in a view that is already new', () => {
    const view = 'confirmed:\n- federal_state=vienna\n- country=at'
    expect(normalizeLegacyPromptView(view)).toBe(view)
  })
})

describe('normalizeBuildingId', () => {
  it('renames bwN only', () => {
    expect(normalizeBuildingId('bw3')).toBe('bldg3')
    expect(normalizeBuildingId('bldg3')).toBe('bldg3')
    expect(normalizeBuildingId('bwx')).toBe('bwx')
  })
})
