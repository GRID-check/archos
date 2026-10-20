import { describe, expect, it } from 'vitest'
import {
  DOCUMENT_ROLES,
  canonicalDocumentRole,
  DOCUMENT_ROLE_DEFINITIONS,
  documentRoleDefinition,
  isDocumentRole,
  isRoleConfidence,
  isRoleSource,
  isScopeInstanceValid,
  LEGACY_DOCUMENT_ROLES,
  recommendedRoles,
  roleRequiresScopeInstance,
} from './document-roles'
import type { DocumentRole } from './document-roles'

describe('roles written before the English names', () => {
  it('maps every legacy role onto a role of the vocabulary and leaves the rest alone', () => {
    for (const [legacy, mapped] of Object.entries(LEGACY_DOCUMENT_ROLES)) {
      expect(isDocumentRole(mapped), legacy).toBe(true)
      expect(canonicalDocumentRole(legacy)).toBe(mapped)
    }
    expect(Object.keys(LEGACY_DOCUMENT_ROLES)).toHaveLength(DOCUMENT_ROLES.length)
    expect(canonicalDocumentRole('site_plan')).toBe('site_plan')
    expect(canonicalDocumentRole('nonsense')).toBe('nonsense')
    expect(canonicalDocumentRole(7)).toBe(7)
  })
})

describe('the role registry', () => {
  it('covers exactly the declared vocabulary, in the same order', () => {
    // Two declarations of one list is how they drift. The tuple exists for the
    // union type, the definitions for the data; this is what pins them.
    expect(DOCUMENT_ROLE_DEFINITIONS.map((d) => d.role)).toEqual([...DOCUMENT_ROLES])
  })

  it('gives every role a non-empty German label', () => {
    for (const definition of DOCUMENT_ROLE_DEFINITIONS) {
      expect(definition.label.trim(), definition.role).not.toBe('')
    }
  })

  it('only makes a role single-holder when the project really has one', () => {
    // A cardinality claim is about the world. The plan sets are many; the
    // governing documents are one.
    const single = DOCUMENT_ROLE_DEFINITIONS.filter((d) => d.cardinality === 'one').map(
      (d) => d.role
    )
    expect(single).toEqual(['development_plan', 'zoning_plan', 'land_register_extract', 'site_plan'])
  })

  it('rejects an unknown role rather than trusting the wire', () => {
    expect(isDocumentRole('development_plan')).toBe(true)
    expect(isDocumentRole('Bebauungsplan')).toBe(false)
    expect(isDocumentRole('bestandsplaene')).toBe(false)
    expect(() => documentRoleDefinition('nope' as DocumentRole)).toThrow(/Unknown document role/)
  })

  it('validates confidence and source against their closed sets', () => {
    expect(isRoleConfidence('declared')).toBe(true)
    expect(isRoleConfidence('suggested')).toBe(true)
    expect(isRoleConfidence('confirmed')).toBe(false)
    expect(isRoleSource('classifier')).toBe(true)
    expect(isRoleSource('llm')).toBe(false)
  })
})

describe('scope instances', () => {
  it('requires an instance for a building role and nothing else, for now', () => {
    expect(roleRequiresScopeInstance('existing_plans')).toBe(true)
    // A project has one plot in v1 and mints no id for it, so demanding one
    // here would make the Bebauungsplan unbindable. Flips when plots go plural.
    expect(roleRequiresScopeInstance('development_plan')).toBe(false)
    expect(roleRequiresScopeInstance('preliminary_decision')).toBe(false)
  })

  it('accepts the Bebauungsplan with no instance, since no plot ids exist yet', () => {
    expect(isScopeInstanceValid('development_plan', null)).toBe(true)
    expect(isScopeInstanceValid('development_plan', 'gs1')).toBe(false)
  })

  it('refuses a building role with no building, which would match every building', () => {
    expect(isScopeInstanceValid('existing_plans', 'bldg2')).toBe(true)
    expect(isScopeInstanceValid('existing_plans', null)).toBe(false)
    expect(isScopeInstanceValid('existing_plans', '')).toBe(false)
  })

  it('refuses a project role that carries one, so the column means one thing', () => {
    expect(isScopeInstanceValid('preliminary_decision', null)).toBe(true)
    expect(isScopeInstanceValid('preliminary_decision', 'bldg2')).toBe(false)
  })
})

describe('recommendedRoles', () => {
  it('pushes the Bebauungsplan once the project says one exists', () => {
    expect(recommendedRoles({})).not.toContain('development_plan')
    expect(recommendedRoles({ B2: 'ja' })).toContain('development_plan')
    expect(recommendedRoles({ B2: 'nein' })).not.toContain('development_plan')
  })

  it('reads a building condition from the building it was asked about', () => {
    const answers = { 'C2@bldg1': 'existing', 'C2@bldg2': 'new_build' }
    expect(recommendedRoles(answers, 'bldg1')).toContain('existing_plans')
    expect(recommendedRoles(answers, 'bldg2')).not.toContain('existing_plans')
  })

  it('pushes the Schadstoffgutachten only when the project includes a demolition', () => {
    expect(recommendedRoles({ A5: ['new_build'] })).not.toContain('expert_report_pollutants')
    expect(recommendedRoles({ A5: ['new_build', 'demolition'] })).toContain('expert_report_pollutants')
  })

  it('never pushes a role that states no condition', () => {
    // Offerable is not the same as recommended: the checklist lists every role,
    // but only a stated condition claims the project needs one.
    const everything = recommendedRoles({ B2: 'ja', A5: ['Abbruch'], 'C2@bldg1': 'existing' }, 'bldg1')
    expect(everything).not.toContain('preliminary_design_study')
    expect(everything).not.toContain('other_project_basis')
  })
})
