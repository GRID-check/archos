/**
 * Project memory API — list and manually add memory items.
 * Thin handlers; authz and logic live in `@/lib/projects/service`.
 */

import { apiRoute, parseJsonBody, parseQuery } from '@/lib/api/handler'
import { addProjectMemoryItem, getProjectMemory } from '@/lib/projects/service'
import { createMemorySchema, listMemoryQuerySchema, toMemoryWireItem } from '@/lib/projects/project-memory-wire'

type Params = { id: string }

export const GET = apiRoute<Params>(
  async ({ session, params, request }) => {
    const query = parseQuery(request, listMemoryQuerySchema)
    const items = await getProjectMemory(session, params.id, {
      includeArchived: query.includeArchived === 'true',
      sourceConversationId: query.conversationId || undefined,
    })
    return { items: items.map(toMemoryWireItem) }
  },
  { authz: { enforcedBy: 'getProjectMemory (requireProjectAccess project:view)' } }
)

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    const input = await parseJsonBody(request, createMemorySchema)
    return { item: toMemoryWireItem(await addProjectMemoryItem(session, params.id, input)) }
  },
  {
    status: 201,
    authz: { enforcedBy: 'addProjectMemoryItem (requireProjectAccess project:memory:write)' },
  }
)
