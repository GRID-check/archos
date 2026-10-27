/**
 * The generator's `$ref` resolution, and the drift of what it wrote.
 *
 * The companion spec — `src/shared/cards/nested-fields.spec.ts` — asks whether
 * the CHECKED-IN artifact validates nested card fields. The first half of this
 * one asks whether the generator would still do the right thing for shapes the
 * card models do not currently contain: a cycle, an unsupported sibling
 * keyword, a def shared by several parents. Those are the cases that will
 * arrive one day via `models.py`, and each of them used to be answered with a
 * silent `z.any()`.
 *
 * The second half asks a different question — whether the module in the repo is
 * still the module this generator emits — and it is at the bottom of the file
 * with its own reasoning.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  buildCardSchemaModule,
  discriminatedOneOfOverride,
  exportName,
  outPath,
  refParserOverride,
  schemaPath,
  topologicallyOrderedDefNames,
  unknownValueOverride,
} from './generate-card-schemas.mjs'

/** A card def with the discriminator the union needs. */
const card = (typeValue, properties, required = []) => ({
  type: 'object',
  properties: { type: { const: typeValue }, ...properties },
  required: ['type', ...required],
})

describe('$ref resolution', () => {
  it('emits a $ref as the referenced const, not z.any()', () => {
    const generatedModule = buildCardSchemaModule({
      discriminator: { propertyName: 'type' },
      oneOf: [{ $ref: '#/$defs/ThingCard' }],
      $defs: {
        ThingCard: card('thing', { reference: { $ref: '#/$defs/NormReference' } }, ['reference']),
        NormReference: { type: 'object', properties: { document: { type: 'string' } }, required: ['document'] },
      },
    })
    expect(generatedModule).toContain('"reference": normReferenceSchema')
    expect(generatedModule).not.toContain('z.any()')
  })

  it('declares a shared def once and references it from every user', () => {
    const generatedModule = buildCardSchemaModule({
      discriminator: { propertyName: 'type' },
      oneOf: [{ $ref: '#/$defs/OneCard' }, { $ref: '#/$defs/TwoCard' }],
      $defs: {
        OneCard: card('one', { a: { $ref: '#/$defs/Shared' }, b: { $ref: '#/$defs/Shared' } }),
        TwoCard: card('two', { c: { $ref: '#/$defs/Shared' } }),
        Shared: { type: 'object', properties: { document: { type: 'string' } } },
      },
    })
    // One declaration, three references and its type — inlining would ship the object thrice.
    expect(generatedModule.match(/export const sharedSchema = /g)).toHaveLength(1)
    expect(generatedModule.match(/\bsharedSchema\b/g)).toHaveLength(5)
    expect(generatedModule).toContain('export type SharedData = z.input<typeof sharedSchema>')
  })

  it('declares a def before the def that references it', () => {
    // `const` is not hoisted: the referenced schema has to exist by the time
    // the referring declaration is evaluated, or the module throws on import.
    const root = {
      oneOf: [{ $ref: '#/$defs/OuterCard' }],
      $defs: {
        OuterCard: card('outer', { inner: { $ref: '#/$defs/Middle' } }),
        Middle: { type: 'object', properties: { leaf: { $ref: '#/$defs/Leaf' } } },
        Leaf: { type: 'object', properties: { name: { type: 'string' } } },
      },
    }
    expect(topologicallyOrderedDefNames(root)).toEqual(['Leaf', 'Middle', 'OuterCard'])
    const generatedModule = buildCardSchemaModule(root)
    expect(generatedModule.indexOf('export const leafSchema')).toBeLessThan(generatedModule.indexOf('export const middleSchema'))
    expect(generatedModule.indexOf('export const middleSchema')).toBeLessThan(generatedModule.indexOf('export const outerCardSchema'))
  })

  it('keeps the description written at the ref site', () => {
    const generatedModule = buildCardSchemaModule({
      oneOf: [{ $ref: '#/$defs/ThingCard' }],
      $defs: {
        ThingCard: card('thing', {
          reference: { $ref: '#/$defs/NormReference', description: 'Where the value comes from' },
        }),
        NormReference: { type: 'object', properties: { document: { type: 'string' } } },
      },
    })
    expect(generatedModule).toContain('normReferenceSchema.describe("Where the value comes from")')
  })

  it('refuses a reference cycle instead of emitting a module that cannot load', () => {
    expect(() =>
      topologicallyOrderedDefNames({
        oneOf: [{ $ref: '#/$defs/ACard' }],
        $defs: {
          ACard: card('a', { b: { $ref: '#/$defs/B' } }),
          B: { type: 'object', properties: { a: { $ref: '#/$defs/ACard' } } },
        },
      })
    ).toThrow(/Cyclic \$ref among card defs: ACard -> B -> ACard/)
  })

  it('refuses a sibling keyword next to a $ref rather than dropping it', () => {
    // Returning a string from `parserOverride` skips the library's own
    // handling of the node, so anything beside the `$ref` other than a
    // description would vanish — a constraint lost without a trace.
    expect(() => refParserOverride({ $ref: '#/$defs/NormReference', minItems: 1 })).toThrow(/minItems/)
  })

  it('leaves non-$ref nodes to the library', () => {
    expect(refParserOverride({ type: 'string' })).toBeUndefined()
  })

  it('emits a tagged oneOf of defs as z.discriminatedUnion, not a Zod 4 superRefine', () => {
    const generatedModule = buildCardSchemaModule({
      discriminator: { propertyName: 'type' },
      oneOf: [{ $ref: '#/$defs/ThingCard' }],
      $defs: {
        ThingCard: card(
          'thing',
          {
            items: {
              type: 'array',
              items: {
                discriminator: { propertyName: 'action' },
                oneOf: [{ $ref: '#/$defs/Left' }, { $ref: '#/$defs/Right' }],
              },
            },
          },
          ['items']
        ),
        Left: { type: 'object', properties: { action: { const: 'left' } }, required: ['action'] },
        Right: { type: 'object', properties: { action: { const: 'right' } }, required: ['action'] },
      },
    })
    expect(generatedModule).toContain('z.array(z.discriminatedUnion("action", [leftSchema, rightSchema]))')
    expect(generatedModule).not.toContain('z.core')
  })

  it('leaves a oneOf without a discriminator, or with an inline branch, to the library', () => {
    expect(discriminatedOneOfOverride({ oneOf: [{ $ref: '#/$defs/A' }] })).toBeUndefined()
    expect(
      discriminatedOneOfOverride({ discriminator: { propertyName: 'kind' }, oneOf: [{ type: 'string' }] })
    ).toBeUndefined()
  })

  it('names a def the way the module exports it', () => {
    expect(exportName('NormReference')).toBe('normReferenceSchema')
  })
})

describe('values the model types as Any', () => {
  it('emits `Any` as z.unknown(), keeping its description and default', () => {
    expect(unknownValueOverride({ description: 'The plain value', default: null })).toBe(
      'z.unknown().describe("The plain value").default(null)'
    )
  })

  it('emits `dict[str, Any]` as a record of unknown values', () => {
    expect(unknownValueOverride({ type: 'object', additionalProperties: true })).toBe(
      'z.record(z.string(), z.unknown())'
    )
  })

  it('leaves a typed node to the library', () => {
    expect(unknownValueOverride({ type: 'string' })).toBeUndefined()
    expect(unknownValueOverride({ type: 'object', properties: {}, additionalProperties: true })).toBeUndefined()
  })

  it('emits no z.any() for a card carrying both shapes', () => {
    const root = {
      oneOf: [{ $ref: '#/$defs/Open' }],
      $defs: {
        Open: card('open', {
          value: { default: null },
          input: { type: 'object', additionalProperties: true },
          items: { type: 'array', items: { type: 'object', additionalProperties: true } },
        }),
      },
    }
    const generatedModule = buildCardSchemaModule(root)
    expect(generatedModule).not.toContain('z.any()')
    expect(generatedModule).toContain('export type OpenData = z.input<typeof openSchema>')
  })
})

/**
 * The committed artifact is what this generator produces from the committed
 * input — the frontend half of `tests/aiq_agent/cards/test_schema_sync.py`.
 *
 * That test holds `models.py -> schemas.json`. Nothing held
 * `schemas.json -> generated.ts`, and the two guards that looked as though they
 * did only cover their own corner: `src/shared/cards/type-coverage.spec.ts`
 * asks whether the union has a MEMBER for every card type, and
 * `nested-fields.spec.ts` asks whether the fields it does have bottom out in
 * something other than `z.any()`. Neither notices a card type that is present
 * on both sides while its FIELDS have drifted — a scalar field added to
 * `models.py`, a `min_length` tightened, an enum given a new value. The
 * frontend then parses the field the model no longer sends, or rejects the one
 * it now does, and a rejected card is a DROPPED card, which renumbers every
 * `[[card:N]]` marker after it.
 *
 * Equality of the whole module, and not a field-by-field comparison, for the
 * reason the Python test states about the schema: the generator is the
 * definition of correct output, so anything that differs is drift by
 * construction — including drift in parts nobody thought to enumerate.
 */
describe('the committed Zod module', () => {
  it('is exactly what the generator emits for the committed JSON Schema', () => {
    const generatedModule = buildCardSchemaModule(JSON.parse(readFileSync(schemaPath, 'utf-8')))

    expect(
      readFileSync(outPath, 'utf-8'),
      'src/shared/cards/generated.ts is not what `npm run generate:cards` produces from ' +
        'shared/cards/schemas.json — either the schema was regenerated without regenerating the ' +
        'Zod mirror, or the mirror was hand-edited (its own banner says not to). Run ' +
        '`npm run generate:cards` from frontends/ui and commit the result.'
    ).toBe(generatedModule)
  })
})
