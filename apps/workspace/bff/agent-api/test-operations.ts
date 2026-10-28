/**
 * A tiny fake catalog for the agent-door specs: what the policy and discovery
 * cases need (a read, a write, a delete, a sensitive write) without importing
 * the real catalog and every route behind it.
 */

import { z } from 'zod'
import type { Exposure } from './exposure.config'
import type { AgentOperation } from './operation'

const load = async () => ({})

export const FAKE_OPERATIONS: readonly AgentOperation[] = [
  {
    name: 'project-list',
    domain: 'projects',
    summary: 'List the projects the person can open',
    description: 'Returns every project the signed-in person is a member of. Call this first; its ids feed every project operation.',
    method: 'GET',
    path: '/api/projects',
    load,
  },
  {
    name: 'project-member-add',
    domain: 'projects',
    summary: 'Add a person to a project',
    description: 'Adds an organization member to a project with a role. The user id comes from organization-member-list.',
    method: 'POST',
    path: '/api/projects/[id]/members',
    params: z.object({ id: z.string().describe('The project id, from project-list.') }),
    body: z.object({ userId: z.string(), role: z.enum(['viewer', 'editor']) }).strict(),
    load,
  },
  {
    name: 'project-delete',
    domain: 'projects',
    summary: 'Delete a project',
    description: 'Deletes the project and everything in it. Cannot be undone. Ask the person first.',
    method: 'DELETE',
    path: '/api/projects/[id]',
    params: z.object({ id: z.string() }),
    load,
  },
  {
    name: 'workspace-search',
    domain: 'documents',
    summary: 'Search documents by words',
    description: 'A POST that only reads: finds documents whose text matches the query.',
    method: 'POST',
    path: '/api/search',
    body: z.object({ text: z.string().min(1) }),
    readOnly: true,
    load,
  },
  {
    name: 'project-folder-access-set',
    domain: 'folders',
    summary: 'Widen access to a folder',
    description: 'Grants a role access to a restricted folder. Changes who may read its documents.',
    method: 'POST',
    path: '/api/folders/[id]/access',
    params: z.object({ id: z.string() }),
    body: z.object({ role: z.string() }),
    sensitivity: 'access',
    load,
  },
]

/** The calls the fake platform overview route answered, for the platform door's spec. */
export const platformOverviewCalls: Request[] = []

/**
 * A tiny fake operator console for the platform door's spec (ADR-0126): a
 * read whose route answers, a fleet-wide destructive write, and a `secret` one.
 */
export const PLATFORM_FAKE_OPERATIONS: readonly AgentOperation[] = [
  {
    name: 'platform-overview-get',
    domain: 'platform',
    summary: 'Platform overview across all organizations',
    description: 'Every organization with its headline figures. Start here for organization ids.',
    method: 'GET',
    path: '/api/platform/overview',
    load: async () => ({
      GET: async (request: Request) => {
        platformOverviewCalls.push(request)
        return Response.json({ organizations: [] })
      },
    }),
  },
  {
    name: 'platform-kill-runs',
    domain: 'platform',
    summary: 'Kill switch: stop every running deep research',
    description: 'Interrupts every running deep research in every organization. It cannot be undone.',
    method: 'POST',
    path: '/api/platform/maintenance/kill-runs',
    destructive: true,
    load,
  },
  {
    name: 'platform-audit-portal-link',
    domain: 'platform',
    summary: 'Get an Admin Portal link to the platform audit log',
    description: 'Generates a short-lived Admin Portal link to the platform audit log; a credential.',
    method: 'POST',
    path: '/api/platform/audit-portal',
    idempotent: false,
    sensitivity: 'secret',
    load,
  },
]

/**
 * Who the fakes are offered to. A fake stands for a kind of operation (a write
 * Piloti proposes, a POST that only reads), not for the real operation of its
 * name, so a spec that mocks the catalog with the fakes mocks their entries too:
 *
 *   vi.mock('@/lib/agent-api/exposure.config', async (importOriginal) =>
 *     (await import('@/lib/agent-api/test-operations')).withFakeExposure(await importOriginal()))
 */
export const FAKE_EXPOSURE: Readonly<Record<string, Exposure>> = {
  'project-list': { external: true, piloti: true },
  'project-member-add': { external: true, piloti: true },
  'project-delete': { external: true, piloti: true },
  'workspace-search': { external: true, piloti: true },
  'project-folder-access-set': { external: true, piloti: false, reason: 'sensitive: Piloti never proposes it' },
  'platform-overview-get': { external: false, piloti: false, platform: true },
  'platform-kill-runs': { external: false, piloti: false, platform: true },
  'platform-audit-portal-link': { external: false, piloti: false, platform: true },
}

/** The real config module with the fakes' entries laid over it (the read tools keep their real ones). */
export function withFakeExposure<T extends { EXPOSURE: Readonly<Record<string, Exposure>> }>(real: T): T {
  return { ...real, EXPOSURE: { ...real.EXPOSURE, ...FAKE_EXPOSURE } }
}
