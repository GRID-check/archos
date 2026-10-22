/**
 * The bodies of `PATCH` and `DELETE /api/projects/[id]`, the status body and the same-address query, kept out of the route
 * file (a Next route exports handlers only) so the route and the MCP catalog
 * (`lib/agent-api/catalog/projects.ts`) parse against one schema.
 */

import { z } from 'zod'
import type { Project } from '@/lib/db/schema'
import { monthSchema } from './month'
import { PROJECT_OUTCOMES } from './project-status'

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

/** A project in the list: the names people use, its status and its dates. */
export interface ProjectSummary {
  id: string
  name: string
  status: Project['status']
  /** The profile fact `project_name`: the name people say aloud, which may differ from `name`. */
  projectName: string | null
  /** The profile fact `site_address`. */
  siteAddress: string | null
  createdAt: Project['createdAt']
  pausedAt: Project['pausedAt']
  closedAt: Project['closedAt']
}

function factText(project: Pick<Project, 'profile'>, key: string): string | null {
  const value = project.profile?.facts?.[key]?.value
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function toProjectSummary(project: Project): ProjectSummary {
  return {
    id: project.id,
    name: project.name,
    status: project.status,
    projectName: factText(project, 'project_name'),
    siteAddress: factText(project, 'site_address') ?? factText(project, 'standort_adresse'),
    createdAt: project.createdAt,
    pausedAt: project.pausedAt,
    closedAt: project.closedAt,
  }
}

/** Case-insensitive match on the project's name or its profile `project_name`. */
export function projectNameMatches(project: ProjectSummary, needle: string): boolean {
  const wanted = needle.toLowerCase()
  return [project.name, project.projectName].some((name) => name?.toLowerCase().includes(wanted))
}
