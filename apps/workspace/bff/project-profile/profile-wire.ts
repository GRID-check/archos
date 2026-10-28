/**
 * The bodies of the profile routes that were declared inside their route files,
 * moved here so the routes and the MCP catalog (`lib/agent-api/catalog/projects.ts`)
 * parse against one schema.
 */

import { z } from 'zod'
import { ProjectProfilePatchOperationSchema } from './types'

const fieldSchema = z.object({ field: z.string(), value: z.string() })

/** `POST …/consistency-check`. */
export const consistencyCheckSchema = z.object({
  freeText: z.array(fieldSchema).max(50),
  structured: z.array(fieldSchema).max(200).optional(),
  locale: z.string().optional(),
})

/** `POST …/profile/patches`. */
export const patchProfileSchema = z.object({
  patch: z.array(ProjectProfilePatchOperationSchema),
  /**
   * The conversation a `project_profile_patch` card was proposed in. A thread
   * that drew on a restricted folder may not write the project-wide profile
   * (ADR-0087). Absent for the brief's own editor.
   */
  conversationId: z.string().min(1).max(128).optional(),
})

/**
 * `POST …/generate-summary`. Optional: the route tolerates a missing or invalid
 * body (older callers send none) and then writes in the person's UI language.
 */
export const generateSummaryRequestSchema = z.object({
  locale: z
    .string()
    .optional()
    .describe('The language to write the summary in, "de" or "en". Defaults to the person’s UI language.'),
})

/**
 * A profile route's answer: the stored state without `profilePromptView`, the
 * text rendering of the profile that goes into Piloti's prompt. It is an
 * internal rendering of `profile` (no client reads it), and an agent would read
 * the same facts twice.
 */
export function toProfileWire<T extends { profilePromptView?: unknown }>(
  state: T
): Omit<T, 'profilePromptView'> {
  const { profilePromptView: _promptView, ...wire } = state
  return wire
}
