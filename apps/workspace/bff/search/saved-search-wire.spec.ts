/**
 * @vitest-environment node
 */
/**
 * The saved-search contract: the question is checked in full by the route's
 * parse, though its JSON Schema stays a bare object for the agent's tool list.
 */
import { describe, expect, it } from 'vitest'
import { toJsonSchema } from '@/lib/api/zod-json-schema'
import { createSavedSearchSchema, SAVED_SEARCH_QUERY_MAX_BYTES, updateSavedSearchSchema } from './saved-search-wire'

describe('createSavedSearchSchema', () => {
  it('parses a question as the search takes it, trimmed, and shares nothing by default', () => {
    const parsed = createSavedSearchSchema.parse({
      name: '  Brandschutz ',
      scope: { scope: 'office_shelf' },
      query: { text: ' Brandschutzkonzept ', kinds: ['document'], filters: { currentOnly: true } },
    })
    expect(parsed).toEqual({
      name: 'Brandschutz',
      scope: { scope: 'office_shelf' },
      query: { text: 'Brandschutzkonzept', kinds: ['document'], filters: { currentOnly: true } },
      shared: false,
    })
  })

  it('refuses a question the search would refuse, with the path into the query', () => {
    const result = createSavedSearchSchema.safeParse({ name: 'x', scope: {}, query: { kinds: ['nothing'] } })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path).toEqual(['query', 'kinds', 0])
  })

  it('drops a cursor: a saved search is the question, not a position in its answer', () => {
    const parsed = createSavedSearchSchema.parse({ name: 'x', scope: {}, query: { text: 'a', cursor: 'o:25' } })
    expect(parsed.query).toEqual({ text: 'a' })
  })

  it('refuses an empty name and one over 120 characters, and keeps a large valid question under the byte bound', () => {
    expect(createSavedSearchSchema.safeParse({ name: ' ', scope: {}, query: {} }).success).toBe(false)
    expect(createSavedSearchSchema.safeParse({ name: 'x'.repeat(121), scope: {}, query: {} }).success).toBe(false)
    const cites = Array.from({ length: 8 }, () => 'y'.repeat(120))
    const many = { filters: { cites, planIndex: Array.from({ length: 20 }, () => 'z'.repeat(120)) } }
    const huge = { ...many, text: 'w'.repeat(500), annotationFilters: {} }
    expect(new TextEncoder().encode(JSON.stringify(huge)).length).toBeLessThan(SAVED_SEARCH_QUERY_MAX_BYTES)
    expect(createSavedSearchSchema.safeParse({ name: 'x', scope: {}, query: huge }).success).toBe(true)
  })

  it('describes the question to an agent as an object, not a second copy of the search body', () => {
    const schema = toJsonSchema(createSavedSearchSchema) as { properties: Record<string, { type?: string; properties?: unknown }> }
    expect(schema.properties.query?.type).toBe('object')
    expect(schema.properties.query?.properties).toBeUndefined()
  })
})

describe('updateSavedSearchSchema', () => {
  it('takes a name, a share flag or both, never nothing', () => {
    expect(updateSavedSearchSchema.safeParse({ shared: true }).success).toBe(true)
    expect(updateSavedSearchSchema.safeParse({ name: 'Neu' }).success).toBe(true)
    expect(updateSavedSearchSchema.safeParse({}).success).toBe(false)
  })
})
