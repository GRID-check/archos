/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { jsonSchemaDocument, toJsonSchema, UnsupportedSchemaNodeError } from './zod-json-schema'

const propertiesOf = (schema: z.ZodType) => toJsonSchema(schema).properties as Record<string, Record<string, unknown>>

describe('the repo’s decisions on top of z.toJSONSchema', () => {
  it('describes what a caller sends: a defaulted field is optional and keeps its default', () => {
    const node = toJsonSchema(z.object({ name: z.string(), limit: z.number().int().default(20) }))
    expect(node.required).toEqual(['name'])
    expect((node.properties as Record<string, unknown>).limit).toEqual({ type: 'integer', default: 20 })
  })

  it('requires exactly what the object cannot parse without', () => {
    const geocode = z.preprocess((value) => value, z.object({ label: z.string() }))
    const node = toJsonSchema(z.object({ value: z.unknown(), location: geocode.nullable() }))
    // `z.unknown()` parses a missing key; a nullable preprocess does not.
    expect(node.required).toEqual(['location'])
  })

  it('throws for a node JSON Schema cannot describe, instead of exporting {}', () => {
    expect(() => toJsonSchema(z.object({ seen: z.map(z.string(), z.string()) }))).toThrow(UnsupportedSchemaNodeError)
    expect(() => toJsonSchema(z.custom<string>(() => true))).toThrow(/cannot describe a custom/)
  })

  it('describes a date as the ISO-8601 string that crosses the wire', () => {
    expect(propertiesOf(z.object({ at: z.coerce.date() })).at).toEqual({ type: 'string', format: 'date-time' })
  })

  it('describes a trimmed-then-piped string by the piped side’s bounds', () => {
    const title = z.string().transform((value) => value.trim()).pipe(z.string().min(1).max(80))
    expect(propertiesOf(z.object({ title })).title).toEqual({ type: 'string', minLength: 1, maxLength: 80 })
  })

  it('keeps OpenAPI’s discriminator on a discriminated union', () => {
    const union = z.discriminatedUnion('kind', [z.object({ kind: z.literal('a') }), z.object({ kind: z.literal('b') })])
    expect(toJsonSchema(union).discriminator).toEqual({ propertyName: 'kind' })
  })

  it('says a string format once, by its format, and keeps a regex of our own', () => {
    const properties = propertiesOf(
      z.object({ id: z.guid(), at: z.string().datetime(), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
    )
    expect(properties.id).toEqual({ type: 'string', format: 'uuid' })
    expect(properties.at).toEqual({ type: 'string', format: 'date-time' })
    expect(properties.day).toEqual({ type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' })
  })

  it('drops the noise: safe-integer bounds, $schema on a node, an empty additionalProperties', () => {
    const node = toJsonSchema(z.object({ count: z.number().int().min(0) }).passthrough())
    expect(node).toEqual({ type: 'object', properties: { count: { type: 'integer', minimum: 0 } }, required: ['count'] })
  })

  it('keeps a strict object closed', () => {
    expect(toJsonSchema(z.object({ a: z.string() }).strict()).additionalProperties).toBe(false)
  })

  it('carries a .describe() text as the node’s description', () => {
    expect(propertiesOf(z.object({ q: z.string().describe('What to look for.') })).q.description).toBe('What to look for.')
  })

  it('writes a document of named $defs under the 2020-12 dialect', () => {
    const document = jsonSchemaDocument({ Thing: z.object({ a: z.string() }) }, { title: 'T', description: 'D' })
    expect(document.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
    expect(Object.keys(document.$defs as object)).toEqual(['Thing'])
    expect((document.$defs as Record<string, object>).Thing).not.toHaveProperty('$schema')
  })
})
