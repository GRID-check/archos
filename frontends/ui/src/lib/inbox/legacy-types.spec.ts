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
    expect(canonicalInboxType('task_run.completed')).toBe('task_run.completed')
  })

  it('widens a SQL type list with the legacy spellings of the types in it and no others', () => {
    expect(legacyInboxTypeAliases(['document.new_revision', 'task_run.completed'])).toEqual([
      'document.new_fassung',
      'job.completed',
    ])
    expect(legacyInboxTypeAliases(['annotation.activity'])).toEqual([])
  })

  it('reads a task run row an older pod wrote as job.* as the task_run type (0176)', () => {
    expect(canonicalInboxType('job.completed')).toBe('task_run.completed')
    expect(canonicalInboxType('job.failed')).toBe('task_run.failed')
    expect(canonicalInboxType('job.waiting')).toBe('task_run.waiting')
  })
})
