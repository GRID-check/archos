/**
 * The project-memory vocabularies, free of drizzle.
 *
 * `db/schema/project-memory.ts` is where they belong by subject and the wrong
 * place to import them FROM: a client component (a memory proposal card, the
 * proposals contract) must not drag the schema into the browser bundle. The
 * tuples live here, the schema imports and re-exports them, so no existing
 * caller moves (the `tasks/task-vocabulary.ts` arrangement).
 */

export const PROJECT_MEMORY_KINDS = [
  'decision',
  'constraint',
  'open_question',
  'derived_fact',
  'preference',
] as const
export type ProjectMemoryKind = (typeof PROJECT_MEMORY_KINDS)[number]

export const PROJECT_MEMORY_CONFIDENCES = ['low', 'medium', 'high'] as const
export type ProjectMemoryConfidence = (typeof PROJECT_MEMORY_CONFIDENCES)[number]

export const PROJECT_MEMORY_STATUSES = ['proposed', 'active', 'superseded', 'dismissed'] as const
export type ProjectMemoryStatus = (typeof PROJECT_MEMORY_STATUSES)[number]

export const PROJECT_MEMORY_VERIFICATIONS = [
  'unverified',
  'source_grounded',
  'user_confirmed',
] as const
export type ProjectMemoryVerification = (typeof PROJECT_MEMORY_VERIFICATIONS)[number]
