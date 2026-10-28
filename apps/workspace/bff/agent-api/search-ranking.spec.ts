/**
 * @vitest-environment node
 */
/**
 * What an outside agent finds for the requests it actually typed. Each query
 * below was written by a model dogfooding the door, against the real catalog;
 * the operation it wanted must rank in the first three. A ranking change that
 * pushes one out fails here, so the ranking only gets better.
 *
 * Add a query when a transcript shows an agent searching twice for one thing.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('./telemetry', () => ({ recordOperationCalled: vi.fn(), recordOperationMissing: vi.fn() }))

import { nothingMatched, searchOperations } from './discovery'
import type { AgentPrincipal } from './principal'

const session = {
  userId: 'user_eval',
  email: 'eval@piloti.test',
  name: 'Eval',
  accessToken: '',
  organizationId: 'org_eval',
  organizationMembershipId: 'om_eval',
  role: 'admin' as const,
  permissions: [],
  featureFlags: null,
}
const agent: AgentPrincipal = { actor: 'external_agent', session, clientId: 'eval', scopes: [] }
const ctx = { principal: agent, mode: 'search' as const }

function topNames(query: string, limit = 3): string[] {
  const result = searchOperations(ctx, { query, limit })
  return ((result.structuredContent as { operations: { name: string }[] }).operations ?? []).map((op) => op.name)
}

const FOUND_IN_THE_FIRST_THREE: ReadonlyArray<readonly [string, string]> = [
  ['which OIB guidelines apply to project', 'knowledge-search'],
  ['what does the project require under building law', 'knowledge-search'],
  ['ask piloti', 'agent-ask-create'],
  ['ask Piloti a question about the project', 'agent-ask-create'],
  ['passage read exact match in building law text', 'passage-read'],
  ['quote a clause from an OIB guideline', 'passage-read'],
  ['Austrian law paragraph Bauordnung', 'law-lookup'],
  ['find documents by file name', 'document-by-name-resolve'],
  ['download link for a document', 'document-download'],
  ['IFC model storeys rooms', 'ifc-query'],
  ['project memory', 'project-memory-list'],
  ['list projects', 'project-list'],
  ['add member project', 'project-person-add'],
  ['search documents for a topic', 'knowledge-search'],
  ['rename a document', 'document-rename'],
  ['undo deleting a document', 'document-restore'],
  ['create a task', 'task-create'],
  ['open points of the project', 'project-annotation-list'],
]

describe('search-operations for the requests agents typed', () => {
  it.each(FOUND_IN_THE_FIRST_THREE)('finds %s → %s in the first three', (query, wanted) => {
    expect(topNames(query)).toContain(wanted)
  })

  it('ranks the operation whose summary opens with the verb first among same-named ones', () => {
    expect(topNames('ask piloti')[0]).toBe('agent-ask-create')
  })

  it('never ranks by a fragment inside a word: "to" is not in "restore"', () => {
    expect(topNames('which OIB guidelines apply to project', 10)).not.toContain('project-restore')
  })

  it('points a content question that matches nothing at the operations that read content', () => {
    expect(nothingMatched(ctx)).toMatch(/knowledge-search .*law-lookup .*agent-ask-create/)
  })
})
