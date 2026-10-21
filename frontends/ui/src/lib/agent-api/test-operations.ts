/**
 * A tiny fake catalog for the agent-door specs: what the policy and discovery
 * cases need (a read, a write, a delete, a sensitive write) without importing
 * the real catalog and every route behind it.
 */

import { z } from 'zod'
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
    name: 'document-search',
    domain: 'documents',
    summary: 'Search documents by words',
    description: 'A POST that only reads: finds documents whose text matches the query.',
    method: 'POST',
    path: '/api/documents/search',
    body: z.object({ query: z.string().min(1) }),
    readOnly: true,
    load,
  },
  {
    name: 'folder-access-grant',
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
