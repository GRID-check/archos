/**
 * The `.describe()` text of the field a zod issue points at, so a validation
 * refusal can quote what the field is for (PostHog's MCP does the same:
 * `parameter "limit" must be of type number (Number of results ...)`). One agent
 * round fixes the input instead of two (a refusal, then describe-operation).
 */
import type { z } from 'zod'

type Step = string | number

function isSchema(value: unknown): value is z.ZodTypeAny {
  return typeof value === 'object' && value !== null && '_def' in value
}

/** `schema` and the schemas it wraps (optional, default, nullable, effects, brand), outermost first. */
function* layers(schema: z.ZodTypeAny): Generator<z.ZodTypeAny> {
  let current: z.ZodTypeAny | null = schema
  while (current) {
    yield current
    const def = current._def as Record<string, unknown>
    // An array's `type` is its element, not a wrapped schema.
    const next: unknown = def.typeName === 'ZodArray' ? null : (def.innerType ?? def.schema ?? def.type)
    current = isSchema(next) ? next : null
  }
}

function child(schema: z.ZodTypeAny, step: Step): z.ZodTypeAny | null {
  const def = schema._def as Record<string, unknown>
  if (typeof def.shape === 'function') {
    const next = (def.shape as () => Record<string, unknown>)()[String(step)]
    return isSchema(next) ? next : null
  }
  if (def.typeName === 'ZodRecord') return isSchema(def.valueType) ? def.valueType : null
  if (def.typeName === 'ZodArray' && typeof step === 'number') return isSchema(def.type) ? def.type : null
  return null
}

/** The description of the field at `path` inside `schema`, or undefined when there is none. */
export function fieldDescription(schema: z.ZodTypeAny, path: readonly Step[]): string | undefined {
  let current: z.ZodTypeAny = schema
  for (const step of path) {
    let next: z.ZodTypeAny | null = null
    for (const layer of layers(current)) {
      next = child(layer, step)
      if (next) break
    }
    if (!next) return undefined
    current = next
  }
  for (const layer of layers(current)) {
    if (layer.description) return layer.description
  }
  return undefined
}
