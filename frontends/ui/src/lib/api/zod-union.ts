/**
 * The members of a zod discriminated union, by discriminator value.
 *
 * Zod 3 kept this map on the union as `optionsMap`; Zod 4 dropped it and keeps
 * each member's possible discriminator values on its internals
 * (`_zod.propValues`), the record zod itself builds the union's lookup from. A
 * literal wrapped in `.default()` (the generated card and wire schemas do
 * this) contributes its literal, as it did in `optionsMap`.
 */

import type { z } from 'zod'

type DiscriminatedUnion = z.ZodDiscriminatedUnion<readonly z.core.$ZodTypeDiscriminable[], string>

export function discriminatedOptions<U extends DiscriminatedUnion>(union: U): ReadonlyMap<unknown, U['options'][number]> {
  const key = union.def.discriminator
  const byValue = new Map<unknown, U['options'][number]>()
  for (const option of union.options) {
    for (const value of option._zod.propValues?.[key] ?? []) {
      if (value !== undefined) byValue.set(value, option)
    }
  }
  return byValue
}
