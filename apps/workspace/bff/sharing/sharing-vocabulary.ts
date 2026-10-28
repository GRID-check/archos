/**
 * The sharing vocabulary: the tuples the `resource_shares` table, the sharing
 * routes' wire schema and the agent catalog all read. A pure module, so a wire
 * module can import it without the database layer (`wire-modules.spec.ts`).
 */

/**
 * Resource types that may be shared. Every entry MUST have a matching entry in
 * the sharing registry (`@/lib/sharing/registry`), which is exhaustive over this
 * union — adding a type here without registering it is a type error.
 */
export const SHAREABLE_RESOURCE_TYPES = ['conversation', 'document'] as const
export type ShareableResourceType = (typeof SHAREABLE_RESOURCE_TYPES)[number]

/**
 * The role ladder, weakest first. Deliberately aligned with the project ladder
 * (project-viewer → viewer, project-editor/admin → collaborator) so users learn
 * one vocabulary. Order matters: `@/lib/sharing/access` takes the STRONGEST of
 * the visibility-derived role and any explicit grant.
 */
export const RESOURCE_ROLES = ['viewer', 'collaborator', 'owner'] as const
export type ResourceRole = (typeof RESOURCE_ROLES)[number]

/**
 * Blanket visibility of a shareable resource, weakest first.
 *   - `private`      — the owner plus anyone holding an explicit grant;
 *   - `project`      — everyone who can access the containing project;
 *   - `organization`  — every member of the organization (phase 2; the model
 *                      carries it from day one so no migration is needed).
 */
export const RESOURCE_VISIBILITIES = ['private', 'project', 'organization'] as const
export type ResourceVisibility = (typeof RESOURCE_VISIBILITIES)[number]
