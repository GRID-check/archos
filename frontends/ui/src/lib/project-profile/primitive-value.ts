import { z } from 'zod'

/**
 * One value on the project profile: what a fact, an assumption or a goal holds.
 *
 * It lives in a file of its own so that `evidence-schema.ts` can use it without
 * importing `types.ts`, which imports the evidence schema in turn. Import it
 * from `./types` as before; that file re-exports it.
 */
export const ProjectPrimitiveValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
  z.null(),
])

export type ProjectPrimitiveValue = z.infer<typeof ProjectPrimitiveValueSchema>
