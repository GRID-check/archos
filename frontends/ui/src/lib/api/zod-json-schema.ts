/**
 * Zod schemas as JSON Schema, for the contracts the Python tier also reads and
 * for every input an agent is shown (MCP tool schemas, `openapi.json`).
 *
 * ## Why this exists at all
 *
 * A wire contract with two hand-written descriptions — a zod object here and a
 * Pydantic model there — is two things somebody has to keep equal, and this repo
 * has the cautionary tale: `AUDIT_ACTIONS` and the provisioning script's
 * `SCHEMAS` array were two lists meant to be one and drifted by nine actions,
 * with the only symptom an ERROR log on the side that never throws. So the zod
 * schema is the source, this converts it, and a committed fixture under
 * `tests/fixtures/` is the artifact both languages read.
 *
 * ## Zod's own exporter does the work
 *
 * `z.toJSONSchema` (Zod 4) is the converter; this module only fixes the four
 * decisions every caller here shares, so they are made once:
 *
 * - **Input, not output.** Every schema here describes what a caller SENDS: a
 *   `.default()` field is optional on the wire, and a `.transform()` is the
 *   BFF's business, not the wire's. A field is required exactly when the
 *   object will not parse without it ({@link objectNode}).
 * - **An undescribable node throws.** A `z.map`, a `z.custom` or a bare
 *   transform fails a spec ({@link UnsupportedSchemaNodeError}) instead of
 *   silently exporting `{}`, a contract that permits anything. The one exception
 *   is a date: `z.coerce.date()` reads an ISO-8601 string off the wire, so that
 *   is what it is described as.
 * - **A string format is its `format`, not zod's regex.** `uuid`, `date-time`
 *   and `email` carry zod's validating regex as a `pattern` too; an agent pays
 *   for every token of a tool list, and the format already says it. A `.regex()`
 *   of our own stays.
 * - **The noise is dropped**, each a keyword that says what its absence
 *   already says: the default safe-integer bounds zod writes on every `.int()`,
 *   the `$schema` line on every node, the empty `additionalProperties: {}` of a
 *   loose object, the `type` beside a literal's `const`, a record's
 *   `propertyNames: { type: 'string' }` and a tuple's `items: false` (its
 *   `maxItems` already closes it). An agent pays for every token of a tool list,
 *   and `mcp-server.spec.ts` holds the list to a budget.
 *
 * Two shapes it would otherwise lose are put back: a discriminated union keeps
 * OpenAPI's `discriminator`, and `z.string().transform(trim).pipe(...)` is
 * described by the piped side, whose bounds are the ones the route enforces.
 */

import { z } from 'zod'

/** A JSON Schema node. */
export type JsonSchemaNode = Record<string, unknown>

/** A zod node JSON Schema cannot describe. */
export class UnsupportedSchemaNodeError extends Error {
  constructor(readonly typeName: string) {
    super(`The JSON Schema export cannot describe a ${typeName}. Describe the wire shape with a representable schema.`)
    this.name = 'UnsupportedSchemaNodeError'
  }
}

/** Zod node kinds `z.toJSONSchema` has no JSON Schema for; `date` is described by hand. */
const UNREPRESENTABLE = new Set(['bigint', 'symbol', 'undefined', 'void', 'map', 'set', 'transform', 'nan', 'custom', 'function', 'promise'])

/** The string formats whose zod regex the `format` keyword already says. */
const FORMAT_PATTERNS_DROPPED = new Set(['uuid', 'guid', 'datetime', 'email'])

type OverrideContext = Parameters<NonNullable<NonNullable<Parameters<typeof z.toJSONSchema>[1]>['override']>>[0]

/** Whether `schema`, read as input, ends in a transform: what the pipe hands on is then the out side's to describe. */
function endsInTransform(schema: z.core.$ZodType): boolean {
  const def = schema._zod.def
  if (def.type === 'transform') return true
  return def.type === 'pipe' && endsInTransform((def as z.core.$ZodPipeDef).out)
}

function replaceWith(target: JsonSchemaNode, source: JsonSchemaNode): void {
  for (const key of Object.keys(target)) delete target[key]
  Object.assign(target, source)
}

function override({ zodSchema, jsonSchema }: OverrideContext): void {
  const def = zodSchema._zod.def
  if (def.type === 'date') {
    jsonSchema.type = 'string'
    jsonSchema.format = 'date-time'
    return
  }
  if (UNREPRESENTABLE.has(def.type)) throw new UnsupportedSchemaNodeError(def.type)
  if (def.type === 'pipe') {
    const pipe = def as z.core.$ZodPipeDef
    if (endsInTransform(pipe.in)) replaceWith(jsonSchema, { ...toJsonSchema(pipe.out), ...descriptionOf(zodSchema) })
    return
  }
  if (def.type === 'union' && 'discriminator' in def && typeof def.discriminator === 'string') {
    jsonSchema.discriminator = { propertyName: def.discriminator }
    return
  }
  if (def.type === 'string') {
    dropFormatPatterns(zodSchema, jsonSchema)
    return
  }
  if (def.type === 'number') {
    if (jsonSchema.minimum === Number.MIN_SAFE_INTEGER) delete jsonSchema.minimum
    if (jsonSchema.maximum === Number.MAX_SAFE_INTEGER) delete jsonSchema.maximum
    return
  }
  if (def.type === 'literal' && 'const' in jsonSchema) {
    delete jsonSchema.type
    return
  }
  if (def.type === 'record' && isPlainStringSchema(jsonSchema.propertyNames)) {
    delete jsonSchema.propertyNames
    return
  }
  if (def.type === 'tuple' && jsonSchema.items === false) {
    delete jsonSchema.items
    return
  }
  if (def.type === 'object') objectNode(def as z.core.$ZodObjectDef, jsonSchema)
}

/** `{ type: 'string' }` and nothing else: what every JSON object key already is. */
function isPlainStringSchema(value: unknown): boolean {
  return typeof value === 'object' && value !== null && Object.keys(value).length === 1 && (value as JsonSchemaNode).type === 'string'
}

function objectNode(def: z.core.$ZodObjectDef, jsonSchema: JsonSchemaNode): void {
  if (isEmptyObject(jsonSchema.additionalProperties)) delete jsonSchema.additionalProperties
  // Required is what the object cannot parse without: Zod's exporter reads it
  // off each field's declared optionality, and that misses two cases a caller
  // meets, a `z.unknown()` (which parses a missing key) and a nullable
  // `z.preprocess` (whose transform it reads as accepting one).
  const required = Object.keys(def.shape).filter((key) => !z.safeParse(def.shape[key], undefined).success)
  if (required.length > 0) jsonSchema.required = required
  else delete jsonSchema.required
}

/** The regex sources of `schema`'s own string-format checks whose `format` keyword already says them. */
function formatPatterns(schema: z.core.$ZodType): Set<string> {
  const checks: z.core.$ZodType[] = [schema, ...((schema._zod.def as { checks?: z.core.$ZodType[] }).checks ?? [])]
  const sources = new Set<string>()
  for (const check of checks) {
    const def = check._zod.def as { check?: string; format?: string; pattern?: RegExp }
    if (def.check === 'string_format' && FORMAT_PATTERNS_DROPPED.has(String(def.format)) && def.pattern) {
      sources.add(def.pattern.source)
    }
  }
  return sources
}

function dropFormatPatterns(schema: z.core.$ZodType, jsonSchema: JsonSchemaNode): void {
  const dropped = formatPatterns(schema)
  if (dropped.size === 0) return
  if (typeof jsonSchema.pattern === 'string' && dropped.has(jsonSchema.pattern)) delete jsonSchema.pattern
  if (!Array.isArray(jsonSchema.allOf)) return
  const kept = (jsonSchema.allOf as JsonSchemaNode[]).filter((part) => !dropped.has(String(part.pattern)))
  delete jsonSchema.allOf
  if (kept.length === 1) Object.assign(jsonSchema, kept[0])
  if (kept.length > 1) jsonSchema.allOf = kept
}

function isEmptyObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 0
}

function descriptionOf(schema: z.core.$ZodType): JsonSchemaNode {
  const description = z.globalRegistry.get(schema)?.description
  return description ? { description } : {}
}

/**
 * One zod schema as JSON Schema (draft 2020-12), as a caller sends it. Throws
 * {@link UnsupportedSchemaNodeError} for a node it cannot describe.
 *
 * A `.describe()` text becomes the node's `description`: it is the guidance a
 * model reads for that field when the schema is an MCP tool's input (ADR-0122),
 * and the one a Python reader sees for a wire field.
 */
export function toJsonSchema(schema: z.core.$ZodType): JsonSchemaNode {
  const { $schema: _dialect, ...node } = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io: 'input',
    unrepresentable: 'any',
    override,
  }) as JsonSchemaNode
  return node
}

/**
 * A whole export: `$defs` keyed by the names in a wire-schema map, so the
 * Python side loads one file and looks a shape up by name rather than by
 * position.
 */
export function jsonSchemaDocument(
  schemas: Record<string, z.core.$ZodType>,
  meta: { title: string; description: string },
): JsonSchemaNode {
  const defs: Record<string, JsonSchemaNode> = {}
  for (const [name, schema] of Object.entries(schemas)) {
    defs[name] = toJsonSchema(schema)
  }
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: meta.title,
    description: meta.description,
    $defs: defs,
  }
}
