/**
 * @vitest-environment node
 *
 * `skill-search` and `skill-get` (ADR-0122): an outside agent finds the office's
 * procedures through search-operations, and call-operation reaches the routes
 * the operations name, as the person.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { findOperation } from '@/lib/agent-api/catalog'
import { searchOperations } from '@/lib/agent-api/discovery'
import { callOperation } from '@/lib/agent-api/dispatch'
import type { AgentPrincipal } from '@/lib/agent-api/principal'
import { NotFoundError } from '@/lib/api/errors'

vi.mock('@/lib/skills/service', () => ({ searchSkills: vi.fn(), readSkill: vi.fn() }))
vi.mock('@/lib/authz/feature-flags', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/authz/feature-flags')>()),
  requireSkillsEnabled: () => null,
}))

import { readSkill, searchSkills } from '@/lib/skills/service'

const session = {
  userId: 'user-1',
  email: 'test@grid.com',
  name: null,
  accessToken: '',
  organizationId: 'org-1',
  organizationMembershipId: 'om-1',
  role: 'member' as const,
  permissions: [],
  featureFlags: null,
}
const outside: AgentPrincipal = { actor: 'external_agent', clientId: 'c', scopes: [], session }
const piloti: AgentPrincipal = { actor: 'piloti', clientId: null, scopes: [], session }

function operation(name: string) {
  const op = findOperation(name)
  if (!op) throw new Error(`${name} is not in the catalog`)
  return op
}

function found(principal: AgentPrincipal, query: string): string[] {
  const result = searchOperations({ principal, mode: 'search' }, { query })
  return (result.structuredContent as { operations: { name: string }[] }).operations.map((op) => op.name)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('an outside agent finds the office’s procedures on its own', () => {
  it('ranks skill-search and skill-get first for the words an agent uses', () => {
    expect(found(outside, 'office procedure').slice(0, 2).sort()).toEqual(['skill-get', 'skill-search'])
    expect(found(outside, 'find skill').slice(0, 3)).toContain('skill-search')
    expect(found(outside, 'read skill').slice(0, 3)).toContain('skill-get')
  })

  it('is not offered to Piloti, which loads skills with its own use_skill', () => {
    expect(found(piloti, 'office procedure')).not.toContain('skill-search')
    expect(found(piloti, 'office procedure')).not.toContain('skill-get')
  })
})

describe('skill-search', () => {
  it('passes the words and the limit to the search, defaulting the limit', async () => {
    vi.mocked(searchSkills).mockResolvedValue({ skills: [], total: 0 })
    const result = await callOperation(operation('skill-search'), { query: { query: 'Stiegen prüfen', limit: 5 } }, session)
    expect(result.status).toBe(200)
    expect(searchSkills).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-1' }), 'Stiegen prüfen', 5)
    await callOperation(operation('skill-search'), {}, session)
    expect(searchSkills).toHaveBeenLastCalledWith(expect.anything(), '', 10)
  })

  it('refuses a limit past the most one search answers, before the route runs', async () => {
    await expect(callOperation(operation('skill-search'), { query: { limit: 500 } }, session)).rejects.toThrow(/limit/)
    expect(searchSkills).not.toHaveBeenCalled()
  })
})

describe('skill-get', () => {
  it('answers the skill the route reads by name, body and all', async () => {
    const skill = { name: 'stair-check', description: 'Checks stairs.', origin: 'org' as const, body: '# Stairs' }
    vi.mocked(readSkill).mockResolvedValue({ skill })
    const result = await callOperation(operation('skill-get'), { params: { name: 'stair-check' } }, session)
    expect(result).toMatchObject({ status: 200, body: { skill } })
    expect(readSkill).toHaveBeenCalledWith(expect.anything(), 'stair-check')
  })

  it('answers 404 for a name the office has not enabled', async () => {
    vi.mocked(readSkill).mockRejectedValue(new NotFoundError('Unknown skill "nope".'))
    const result = await callOperation(operation('skill-get'), { params: { name: 'nope' } }, session)
    expect(result.status).toBe(404)
  })
})
