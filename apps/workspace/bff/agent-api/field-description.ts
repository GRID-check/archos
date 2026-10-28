/**
 * The `.describe()` text of the field a zod issue points at, so a validation
 * refusal can quote what the field is for (PostHog's MCP does the same:
 * `parameter "limit" must be of type number (Number of results ...)`). One agent
 * round fixes the input instead of two (a refusal, then describe-operation).
 */
import { z } from 'zod'

type Schema = z.core.$ZodType

/** Zod node kinds that wrap one inner schema and add no field of their own. */
const WRAPPERS = new Set(['optional', 'nullable', 'default', 'prefault', 'catch', 'readonly', 'nonoptional'])

/** The schema `schema` wraps, or null: an array's element is a field, not a wrapped schema. */
function wrapped(schema: Schema): Schema | null {
  const def = schema._zod.def
  if (WRAPPERS.has(def.type)) return (def as z.core.$ZodOptionalDef).innerType
  if (def.type === 'lazy') return (def as z.core.$ZodLazyDef).getter()
  if (def.type !== 'pipe') return null
  // A transform has no fields; what the caller sends is described by the side around it.
  const pipe = def as z.core.$ZodPipeDef
  return pipe.in._zod.def.type === 'transform' ? pipe.out : pipe.in
}

/** `schema` and the schemas it wraps (optional, default, nullable, pipe), outermost first. */
function* layers(schema: Schema): Generator<Schema> {
  let current: Schema | null = schema
  while (current) {
    yield current
    current = wrapped(current)
  }
}

function child(schema: Schema, step: PropertyKey): Schema | null {
  const def = schema._zod.def
  if (def.type === 'object') return (def as z.core.$ZodObjectDef).shape[String(step)] ?? null
  if (def.type === 'record') return (def as z.core.$ZodRecordDef).valueType
  if (def.type === 'array' && typeof step === 'number') return (def as z.core.$ZodArrayDef).element
  return null
}

/** The description of the field at `path` inside `schema`, or undefined when there is none. */
export function fieldDescription(schema: Schema, path: readonly PropertyKey[]): string | undefined {
  let current: Schema = schema
  for (const step of path) {
    let next: Schema | null = null
    for (const layer of layers(current)) {
      next = child(layer, step)
      if (next) break
    }
    if (!next) return undefined
    current = next
  }
  for (const layer of layers(current)) {
    const description = z.globalRegistry.get(layer)?.description
    if (description) return description
  }
  return undefined
}
