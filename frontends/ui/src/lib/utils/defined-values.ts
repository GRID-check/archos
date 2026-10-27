/**
 * `record` without its `undefined` values, typed as the full record it then is.
 *
 * Zod 4's `z.partialRecord` (a record keyed by an enum where any key may be
 * left out) types every value as possibly `undefined`, as `Partial` does. A
 * body parsed from JSON never holds one, but the type cannot know that; this
 * drops them rather than asserting it.
 */
export function definedValues<V>(record: Partial<Record<string, V>>): Record<string, V> {
  const defined: Record<string, V> = {}
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) defined[key] = value
  }
  return defined
}
