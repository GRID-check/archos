/**
 * The bodies of the „Ausmisten" routes (ADR-0092), kept out of the route files
 * so the routes and the MCP catalog (`lib/agent-api/catalog/projects.ts`) parse
 * against one schema.
 */

import { z } from 'zod'

/** The most documents one cleanup may name. */
export const CLEANUP_MAX_DOCUMENTS = 2000

const ids = z.array(z.string().uuid()).max(CLEANUP_MAX_DOCUMENTS)

/** `POST …/cleanup`: what the person decided, and what Piloti had proposed. */
export const confirmCleanupSchema = z.object({ documentIds: ids, proposedIds: ids, aiUsed: z.boolean() }).strict()

/** `POST …/cleanup/proposal`. */
export const proposeCleanupSchema = z.object({ locale: z.enum(['de', 'en']) }).strict()
