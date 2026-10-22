/**
 * The bodies of `PATCH` and `DELETE /api/projects/[id]`, the status body and the same-address query, kept out of the route
 * file (a Next route exports handlers only) so the route and the MCP catalog
 * (`lib/agent-api/catalog/projects.ts`) parse against one schema.
 */

import { z } from 'zod'
import { monthSchema } from './month'
import { PROJECT_OUTCOMES, type ProjectStatus } from './project-status'

export const renameProjectSchema = z.object({
  name: z.string().min(1).max(255).trim(),
})

/** Deleting asks for the project's name, as the dialog does: a person types it to confirm. */
export const deleteProjectSchema = z.object({
  confirmName: z.string().min(1),
})

/** `GET /api/projects/same-address?label=&lat=&lon=`. */
export const sameAddressQuerySchema = z.object({
  label: z.string().trim().min(3).max(300),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lon: z.coerce.number().min(-180).max(180).optional(),
})

/** `PUT /api/projects/[id]/status`: pause, resume, or close with how it ended and its Abschluss month. */
export const projectStatusSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('active') }).strict(),
  z.object({ status: z.literal('paused') }).strict(),
  z
    .object({
      status: z.literal('closed'),
      outcome: z.enum(PROJECT_OUTCOMES),
      endedOn: monthSchema,
    })
    .strict(),
])

/**
 * `GET /api/projects?view=&nameContains=`. `summary` (the default) is one lean
 * row per project; `full` is the whole stored row with the profile. Every
 * client we know reads only id and name, and the full rows were ~4.6 KB each.
 */
export const listProjectsQuerySchema = z.object({
  view: z.enum(['summary', 'full']).optional(),
  nameContains: z.string().trim().min(1).max(200).optional(),
})
export type ListProjectsQuery = z.infer<typeof listProjectsQuerySchema>

/** A project in the list: the names people use, its status and its dates. */
export interface ProjectSummary {
  id: string
  name: string
  status: ProjectStatus
  /** The profile fact `project_name`: the name people say aloud, which may differ from `name`. */
  projectName: string | null
  /** The profile fact `site_address`. */
  siteAddress: string | null
  createdAt: Date
  pausedAt: Date | null
  closedAt: Date | null
}
