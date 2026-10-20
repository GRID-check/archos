/**
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  OFFICE_SHELF_COLLECTION_PREFIX,
  OFFICE_SHELF_COLLECTION_PREFIXES,
  OFFICE_SHELF_TARGET_COLLECTION_PREFIX,
  isOfficeShelfCollectionName,
  officeShelfOrganizationId,
} from './collection-prefix'

const python = readFileSync(join(process.cwd(), '../../src/aiq_agent/common/source_kinds.py'), 'utf8')
const pythonConstant = (name: string): string => {
  const match = python.match(new RegExp(`^${name} = "([^"]+)"`, 'm'))
  if (!match) throw new Error(`${name} not found in source_kinds.py`)
  return match[1]
}

describe('the office-shelf collection prefix', () => {
  it('is the same constant in TypeScript and Python', () => {
    expect(pythonConstant('OFFICE_SHELF_COLLECTION_PREFIX')).toBe(OFFICE_SHELF_COLLECTION_PREFIX)
    expect(pythonConstant('OFFICE_SHELF_TARGET_COLLECTION_PREFIX')).toBe(OFFICE_SHELF_TARGET_COLLECTION_PREFIX)
  })

  it('accepts the old and the new prefix, and nothing else', () => {
    expect(OFFICE_SHELF_COLLECTION_PREFIXES).toEqual(['office_shelf_', 'archiv_'])
    expect(isOfficeShelfCollectionName('archiv_org_1')).toBe(true)
    expect(isOfficeShelfCollectionName('office_shelf_org_1')).toBe(true)
    expect(isOfficeShelfCollectionName('proj_x')).toBe(false)
  })

  it('reads the organization id behind either prefix', () => {
    expect(officeShelfOrganizationId('archiv_org_1')).toBe('org_1')
    expect(officeShelfOrganizationId('office_shelf_org_1')).toBe('org_1')
    expect(officeShelfOrganizationId('proj_x')).toBeNull()
  })
})
