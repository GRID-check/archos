import { describe, expect, it } from 'vitest'
import { INBOX_ITEM_TYPES } from '@/lib/db/schema'
import { canonicalInboxType, legacyInboxTypeAliases, LEGACY_INBOX_TYPES } from './types'

describe('inbox types written before the English names', () => {
  it('maps every legacy type onto a registered type, and no legacy type is a current one', () => {
    for (const [legacy, current] of Object.entries(LEGACY_INBOX_TYPES)) {
      expect(INBOX_ITEM_TYPES).toContain(current)
      expect(INBOX_ITEM_TYPES as readonly string[]).not.toContain(legacy)
      expect(canonicalInboxType(legacy)).toBe(current)
    }
    expect(canonicalInboxType('job.completed')).toBe('job.completed')
  })

  it('widens a SQL type list with the legacy spellings of the types in it and no others', () => {
    expect(legacyInboxTypeAliases(['document.new_revision', 'job.completed'])).toEqual(['document.new_fassung'])
    expect(legacyInboxTypeAliases(['job.completed'])).toEqual([])
  })
})
