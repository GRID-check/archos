/**
 * The wire of the office's conventions (ADR-0129): the lines a person reads
 * and the decision they make on one. Pure zod, shared by the routes, the agent
 * operations and the settings card, so the contract is written once.
 */

import { z } from 'zod'

const support = { projects: z.number().int().nonnegative(), of: z.number().int().nonnegative() }
const key = z.string().min(1).max(300)

/** One convention as a line a person can decide on. The `key` is stable across recounts. */
export const conventionLineSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('filing'), key, docType: z.string(), path: z.string(), ...support }),
  z.object({ kind: z.literal('folder'), key, path: z.string(), ...support }),
  z.object({ kind: z.literal('document_number'), key, shape: z.string(), ...support }),
  z.object({
    kind: z.literal('revision_style'),
    key,
    style: z.enum(['letter', 'number', 'padded_number', 'letter_number']),
    ...support,
  }),
  z.object({ kind: z.literal('file_date'), key, format: z.string(), ...support }),
])
export type ConventionLine = z.infer<typeof conventionLineSchema>
export type ConventionLineKind = ConventionLine['kind']

export const CONVENTION_DECISIONS = ['confirmed', 'declined'] as const
export type ConventionDecision = (typeof CONVENTION_DECISIONS)[number]

/** What a person can do to a line: confirm it, decline it, or take the decision back. */
export const decideConventionBodySchema = z.object({
  lineKey: key.describe('The key of a line, from office-conventions-list.'),
  decision: z
    .enum([...CONVENTION_DECISIONS, 'undecided'])
    .describe(
      '"confirmed" keeps the line for Piloti even when later counts fall below the threshold; "declined" means ' +
        'Piloti never uses it again; "undecided" takes an earlier decision back.'
    ),
})
export type DecideConventionBody = z.infer<typeof decideConventionBodySchema>

/** One line as the list returns it. */
export interface ConventionLineView {
  line: ConventionLine
  /** The person's decision, or null while nobody decided. */
  decision: ConventionDecision | null
  /** Whether the latest count still shows it. A confirmed line may be kept without it. */
  counted: boolean
  decidedBy: string | null
  decidedAt: string | null
}

export interface OfficeConventionsView {
  /** Whether the organization learns conventions at all (the `office-conventions` flag). */
  enabled: boolean
  /** Projects the latest count was taken over; 0 before the first count. */
  projects: number
  computedAt: string | null
  lines: ConventionLineView[]
}
