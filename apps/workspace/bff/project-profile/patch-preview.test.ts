/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'

import { buildPatchPreviewRows } from './patch-preview'
import { ProjectProfileSchema } from './types'
import type { ProjectProfile, ProjectProfilePatchOperation } from './types'

const NOW = '2026-07-08T00:00:00.000Z'

function fact(value: ProjectProfile['facts'][string]['value']): ProjectProfile['facts'][string] {
  return { value, confidence: 'confirmed', source: 'onboarding', updatedAt: NOW }
}

const baseProfile: ProjectProfile = ProjectProfileSchema.parse({
  facts: {
    building_type: fact('other'),
    heritage_protection: fact(false),
  },
  goals: { zieltermin: '2027-03-01' },
})

function op(
  o: ProjectProfilePatchOperation['op'],
  path: string,
  value?: unknown
): ProjectProfilePatchOperation {
  return { op: o, path, value }
}

describe('buildPatchPreviewRows', () => {
  it('maps a known enum key to its option label, before from the current profile', () => {
    const rows = buildPatchPreviewRows([op('add', '/facts/building_type', 'building')], baseProfile)
    expect(rows).toEqual([
      {
        label: 'Bauwerkstyp',
        before: 'sonstiges Bauwerk (Flugdach, Stützmauer, Werbeanlage …)',
        after: 'Gebäude',
      },
    ])
  })

  it('renders an em dash for a before that is not yet set', () => {
    const rows = buildPatchPreviewRows(
      [op('add', '/facts/heat_supply', 'heat_pump')],
      baseProfile
    )
    expect(rows).toEqual([{ label: 'Geplante Wärmeversorgung', before: '—', after: 'Wärmepumpe' }])
  })

  it('renders remove as an em dash after value', () => {
    const rows = buildPatchPreviewRows([op('remove', '/facts/building_type')], baseProfile)
    expect(rows[0]).toMatchObject({
      label: 'Bauwerkstyp',
      before: 'sonstiges Bauwerk (Flugdach, Stützmauer, Werbeanlage …)',
      after: '—',
    })
  })

  it('formats yes_no_open booleans as Ja/Nein', () => {
    const rows = buildPatchPreviewRows([op('add', '/facts/heritage_protection', true)], baseProfile)
    expect(rows[0]).toMatchObject({
      label: 'Steht das Gebäude unter Denkmalschutz?',
      before: 'Nein',
      after: 'Ja',
    })
  })

  it('joins multi-select option labels', () => {
    const rows = buildPatchPreviewRows(
      [op('add', '/facts/work_type', ['new_build', 'refurbishment'])],
      baseProfile
    )
    expect(rows[0].after).toBe('Neubau, Sanierung')
  })

  it('accepts the deep /facts/<key>/value path form', () => {
    const rows = buildPatchPreviewRows(
      [op('add', '/facts/heat_supply/value', 'district_heating')],
      baseProfile
    )
    expect(rows[0]).toMatchObject({ label: 'Geplante Wärmeversorgung', after: 'Fernwärme' })
  })

  it('unwraps a shaped { value } op value', () => {
    const shaped = {
      value: 'building',
      confidence: 'confirmed',
      source: 'user_confirmed',
      updatedAt: NOW,
    }
    const rows = buildPatchPreviewRows([op('add', '/facts/building_type', shaped)], baseProfile)
    expect(rows[0].after).toBe('Gebäude')
  })

  it('never hides a foreign object value — it JSON-stringifies it', () => {
    const rows = buildPatchPreviewRows(
      [op('add', '/facts/building_type', { foo: 'bar' })],
      baseProfile
    )
    expect(rows[0].after).toBe('{"foo":"bar"}')
  })

  it('falls back to a humanized label for an unknown key', () => {
    const rows = buildPatchPreviewRows(
      [op('add', '/facts/some_novel_fact', 'brandschutzkonzept liegt vor')],
      baseProfile
    )
    expect(rows[0]).toMatchObject({
      label: 'Some Novel Fact',
      before: '—',
      after: 'brandschutzkonzept liegt vor',
    })
  })

  it('leaves before blank when the profile is not yet loaded', () => {
    const rows = buildPatchPreviewRows([op('add', '/facts/building_type', 'building')], null)
    expect(rows).toEqual([{ label: 'Bauwerkstyp', before: '', after: 'Gebäude' }])
  })
})
