/**
 * The Steckbrief's wire shapes (ADR-0091), shared by the routes, the service
 * and the form. Isomorphic: no I/O.
 */

import { z } from 'zod'
import { isMonth, isOrderedPeriod, type Month } from './month'

const monthField = z
  .string()
  .refine(isMonth, { message: 'Expected a month as YYYY-MM' })
  .transform((value) => value as Month)
  .nullable()

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value.length > 0 ? value : null))
    .nullable()

/**
 * The Beginn, the one end of the period the Steckbrief edits. The Abschluss is
 * not a field: closing names it (ADR-0098), so a running project has none.
 */
export const projectPeriodSchema = z.object({ startedOn: monthField }).strict()
export type ProjectPeriodInput = z.infer<typeof projectPeriodSchema>

/**
 * One person on the project. Name, Funktion, Firma, von–bis and, for a
 * member, their Piloti account: deliberately nothing else (GDPR Art. 5(1)(c)),
 * no e-mail and no phone. A member's entry is keyed by `userId`, so describing
 * a member twice updates the one row.
 */
export const projectPersonSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    function: optionalText(200),
    company: optionalText(200),
    startedOn: monthField,
    endedOn: monthField,
    userId: z.string().trim().min(1).max(200).nullable(),
  })
  .strict()
  .refine((person) => isOrderedPeriod(person.startedOn, person.endedOn), {
    message: 'The end lies before the start',
    path: ['endedOn'],
  })
export type ProjectPersonInput = z.infer<typeof projectPersonSchema>

/**
 * Where a person on the Steckbrief comes from:
 *   - `member`: holds a role on the project now; listed without anyone typing
 *     them in, and a stored row only adds their Funktion, Firma and months;
 *   - `former`: held one and was removed; the row was written when they left;
 *   - `added`: entered by hand, an external planner or someone from before
 *     Piloti, with no account.
 */
export type ProjectPersonKind = 'member' | 'former' | 'added'

export interface ProjectPersonView {
  /** The stored row; null for a member nobody has described yet. */
  id: string | null
  kind: ProjectPersonKind
  /** Their Piloti account, for a member or a former member. */
  userId: string | null
  name: string
  function: string | null
  company: string | null
  startedOn: Month | null
  endedOn: Month | null
}

export interface SteckbriefView {
  /** The profile fact „Adresse / Gemeinde" (`standort_adresse`); edited in the intake wizard. */
  address: string | null
  /** The Beginn: the one set, else the month the project was created in Piloti (`startedOnIsDefault`). */
  startedOn: Month | null
  /** True while nobody has set the Beginn and it is the month of creation. */
  startedOnIsDefault: boolean
  /** The Abschluss, once the project is closed (ADR-0098); null while it runs. */
  endedOn: Month | null
  /** Members first, by when they joined, then everyone else. */
  people: ProjectPersonView[]
  /** False when the project's roster could not be read: `people` then holds only what is stored. */
  rosterKnown: boolean
  /** Whether the reader may change the period and the people: false in a closed project. */
  canEdit: boolean
  /** Whether the reader may delete a person: also in a closed project, for whoever manages it (erasure). */
  canErase: boolean
}
