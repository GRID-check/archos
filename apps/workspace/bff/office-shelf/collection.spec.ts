/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { officeShelfCollectionName } from './collection'

describe('officeShelfCollectionName', () => {
  it('derives a deterministic, org-scoped collection name', () => {
    expect(officeShelfCollectionName('org_01HZ')).toBe('archiv_org_01HZ')
    // Pure function of the org id — same input, same output.
    expect(officeShelfCollectionName('org_01HZ')).toBe(officeShelfCollectionName('org_01HZ'))
  })

  it('sanitizes characters outside the collection-name charset', () => {
    expect(officeShelfCollectionName('org/../evil id')).toBe('archiv_org____evil_id')
    expect(officeShelfCollectionName('a.b:c')).toBe('archiv_a_b_c')
  })

  it('preserves hyphens and underscores (as project collections do)', () => {
    expect(officeShelfCollectionName('org-1_test')).toBe('archiv_org-1_test')
  })
})
