/**
 * The body of `POST /api/projects`, kept out of the route file (a Next route
 * exports handlers only) so the spec parses against the very schema the route
 * does. No `server-only`: the form reads the bounds too.
 */

import { z } from 'zod'
import { geocodeResultSchema } from '@/lib/geocoding/types'
import { isValidBundeslandToken } from '@/lib/project-profile/intake-definition'
import { MAX_INTAKE_DESCRIPTION_LENGTH } from '@/lib/project-intake/types'
import { isMonth, type Month } from './month'
import { PROJECT_OUTCOMES } from './project-status'

/** Longest address line a person may type. */
export const MAX_ADDRESS_LENGTH = 200

const monthSchema = z.custom<Month>((value) => typeof value === 'string' && isMonth(value), 'A month, YYYY-MM.')

/** How a new project is set up. `piloti` reads the documents; `self` is the wizard. */
export const PROJECT_SETUPS = ['piloti', 'self'] as const
export type ProjectSetup = (typeof PROJECT_SETUPS)[number]

export const createProjectSchema = z
  .object({
    name: z.string().min(1).max(255).trim(),
    closing: z
      .object({
        outcome: z.enum(PROJECT_OUTCOMES),
        endedOn: monthSchema,
        startedOn: monthSchema.nullable(),
      })
      .strict()
      .optional(),
    /** Default `piloti`: the project gets an intake row and lands on its setup page. */
    setup: z.enum(PROJECT_SETUPS).default('piloti'),
    /** „Worum geht es?". Blank counts as not given. */
    description: z
      .string()
      .trim()
      .max(MAX_INTAKE_DESCRIPTION_LENGTH)
      .transform((value) => value || undefined)
      .optional(),
    /** The address search's hit. */
    location: geocodeResultSchema.optional(),
    /** The address as typed, when no hit was chosen. Blank counts as not given. */
    address: z
      .string()
      .trim()
      .max(MAX_ADDRESS_LENGTH)
      .transform((value) => value || undefined)
      .optional(),
    /** An A2_land token chosen by hand when no geocoder is configured. */
    bundesland: z
      .string()
      .refine(isValidBundeslandToken, 'A Bundesland token.')
      .optional(),
  })
  .strict()

export type CreateProjectBody = z.infer<typeof createProjectSchema>
