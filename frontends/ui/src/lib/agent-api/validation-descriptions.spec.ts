/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { OperationInputError, validateOperationInput } from './dispatch'
import { fieldDescription } from './field-description'
import type { AgentOperation } from './operation'

const query = z.object({
  limit: z.number().int().describe('Number of results to return per page.').optional(),
  sort: z.enum(['asc', 'desc']),
  filters: z.object({ owner: z.string().describe('Id of the owner.') }).optional(),
  tags: z.array(z.object({ label: z.string().describe('The tag text.') })).optional(),
})
const op = { name: 'thing-list', query, summary: '', description: '', domain: 'projects' } as unknown as AgentOperation

function refusal(input: Record<string, unknown>): string {
  try {
    validateOperationInput(op, { query: input })
  } catch (error) {
    if (error instanceof OperationInputError) return error.message
    throw error
  }
  return ''
}

describe('a validation refusal quotes the field’s description', () => {
  it('names the field, what was wrong, and what the field is for', () => {
    expect(refusal({ limit: 'ten', sort: 'asc' })).toBe(
      'thing-list: query.limit: Expected number, received string (Number of results to return per page)',
    )
  })

  it('reaches into nested objects and arrays', () => {
    expect(refusal({ sort: 'asc', filters: { owner: 3 } })).toMatch(/query\.filters\.owner: .*\(Id of the owner\)/)
    expect(refusal({ sort: 'asc', tags: [{ label: 1 }] })).toMatch(/query\.tags\.0\.label: .*\(The tag text\)/)
  })

  it('adds nothing for a field with no description', () => {
    expect(refusal({ sort: 'up' })).not.toMatch(/\(.*\)$/)
  })

  it('finds a description through optional wrappers', () => {
    expect(fieldDescription(query, ['limit'])).toBe('Number of results to return per page.')
    expect(fieldDescription(query, ['nope'])).toBeUndefined()
  })
})
