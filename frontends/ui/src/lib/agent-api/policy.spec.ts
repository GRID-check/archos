/**
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('./catalog', async () => {
  const { FAKE_OPERATIONS } = await import('./test-operations')
  return {
    AGENT_OPERATIONS: FAKE_OPERATIONS,
    findOperation: (name: string) => FAKE_OPERATIONS.find((op) => op.name === name),
  }
})

import { FAKE_OPERATIONS } from './test-operations'
import { SENSITIVE_SCOPE, callDecision, findVisibleOperation, visibleOperations } from './policy'
import type { AgentPrincipal } from './principal'

const session = {
  userId: 'user_1',
  email: 'a@piloti.test',
  name: null,
  accessToken: '',
  organizationId: 'org_1',
  organizationMembershipId: 'om_1',
  role: 'admin' as const,
  permissions: [],
  featureFlags: null,
}

const person = (scopes: string[] = []): AgentPrincipal => ({ kind: 'person', session, clientId: 'c', scopes })
const piloti: AgentPrincipal = { kind: 'piloti', session, clientId: null, scopes: [] }
const op = (name: string) => FAKE_OPERATIONS.find((candidate) => candidate.name === name)!

describe('callDecision', () => {
  it('runs everything for a person; the route is the gate', () => {
    for (const operation of FAKE_OPERATIONS) expect(callDecision(person(), operation)).toBe('run')
  })

  it('lets in-product Piloti read', () => {
    expect(callDecision(piloti, op('project-list'))).toBe('run')
    // A POST that only searches is still a read.
    expect(callDecision(piloti, op('document-search'))).toBe('run')
  })

  it('turns every write by in-product Piloti into a proposal', () => {
    expect(callDecision(piloti, op('project-member-add'))).toBe('propose')
    expect(callDecision(piloti, op('project-delete'))).toBe('propose')
    expect(callDecision(piloti, op('folder-access-grant'))).toBe('propose')
  })
})

describe('visibleOperations', () => {
  const names = (principal: AgentPrincipal) => visibleOperations(principal).map((candidate) => candidate.name)

  it('hides a sensitive operation from an external agent without the step-up scope', () => {
    expect(names(person())).not.toContain('folder-access-grant')
    expect(names(person())).toContain('project-member-add')
  })

  it('shows it once the client holds piloti:sensitive', () => {
    expect(names(person([SENSITIVE_SCOPE]))).toContain('folder-access-grant')
  })

  it('shows it to Piloti, whose writes are only proposals', () => {
    expect(names(piloti)).toContain('folder-access-grant')
  })

  it('treats a hidden operation as absent', () => {
    expect(findVisibleOperation(person(), 'folder-access-grant')).toBeUndefined()
    expect(findVisibleOperation(person(), 'project-list')?.name).toBe('project-list')
  })
})
