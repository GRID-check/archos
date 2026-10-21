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
import {
  SENSITIVE_SCOPE,
  SENSITIVE_SCOPE_ENFORCED_BY_WORKOS,
  callDecision,
  canSee,
  findVisibleBackendOperation,
  findVisibleOperation,
  isOnDoor,
  maySeeSensitive,
  visibleBackendOperations,
  visibleOperations,
} from './policy'
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

const person = (scopes: string[] = []): AgentPrincipal => ({ actor: 'external_agent', session, clientId: 'c', scopes })
const piloti: AgentPrincipal = { actor: 'piloti', session, clientId: null, scopes: [] }
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

  it('ignores piloti:sensitive while WorkOS does not define and enforce it (M5)', () => {
    // A token carrying the string proves nothing until the authorization server grants it on step-up.
    expect(SENSITIVE_SCOPE_ENFORCED_BY_WORKOS).toBe(false)
    expect(names(person([SENSITIVE_SCOPE]))).not.toContain('folder-access-grant')
    expect(findVisibleOperation(person([SENSITIVE_SCOPE]), 'folder-access-grant')).toBeUndefined()
  })

  it('hides it from Piloti, which may not even propose it (M4)', () => {
    expect(names(piloti)).not.toContain('folder-access-grant')
    expect(findVisibleOperation(piloti, 'folder-access-grant')).toBeUndefined()
  })

  it('keeps every platform operation off the office door, for everyone (H3): it waits for a door of its own', () => {
    const platformRead = { ...op('project-list'), name: 'platform-overview-get', domain: 'platform' as const }
    expect(isOnDoor(platformRead)).toBe(false)
    expect(canSee(piloti, platformRead)).toBe(false)
    expect(canSee(person(), platformRead)).toBe(false)
  })

  it('offers a withheld operation to nobody, as if it did not exist', () => {
    const withheld = {
      ...op('project-list'),
      name: 'organization-model-config-get',
      withheld: { category: 'product-config' as const, reason: 'which models Piloti runs on; product configuration' },
    }
    expect(isOnDoor(withheld)).toBe(false)
    expect(canSee(piloti, withheld)).toBe(false)
    expect(canSee(person(), withheld)).toBe(false)
    expect(findVisibleOperation(person(), 'organization-model-config-get')).toBeUndefined()
    expect(findVisibleOperation(person(), 'citation-format')).toBeUndefined()
  })

  it('hides the asks from Piloti, and only from Piloti: Piloti never asks Piloti (ADR-0123)', () => {
    for (const name of ['piloti-ask-create', 'piloti-ask-get', 'piloti-ask-cancel']) {
      const ask = { ...op('project-list'), name, domain: 'conversations' as const }
      expect(canSee(piloti, ask), name).toBe(false)
      expect(canSee(person(), ask), name).toBe(true)
    }
  })

  it('treats a hidden operation as absent', () => {
    expect(findVisibleOperation(person(), 'folder-access-grant')).toBeUndefined()
    expect(findVisibleOperation(person(), 'project-list')?.name).toBe('project-list')
  })
})

describe('the guards on a sensitive operation (ADR-0121)', () => {
  const optedIn = (sensitiveOptIns: AgentPrincipal['sensitiveOptIns'], scopes = [SENSITIVE_SCOPE]): AgentPrincipal => ({
    ...person(scopes),
    sensitiveOptIns,
  })

  it('needs the organization’s opt-in for that class, the scope, and the scope enforced', () => {
    expect(maySeeSensitive(optedIn(['access']), 'access', true)).toBe(true)
    // The other class stays off: an office may let agents share and keep its keys.
    expect(maySeeSensitive(optedIn(['access']), 'secret', true)).toBe(false)
    expect(maySeeSensitive(optedIn(['secret']), 'secret', true)).toBe(true)
    expect(maySeeSensitive(optedIn([]), 'access', true)).toBe(false)
    expect(maySeeSensitive(optedIn(undefined), 'access', true)).toBe(false)
    expect(maySeeSensitive(optedIn(['access'], []), 'access', true)).toBe(false)
    expect(maySeeSensitive(optedIn(['access']), 'access', false)).toBe(false)
  })

  it('is off by default: an opted-in organization’s agent with the scope sees nothing until WorkOS enforces it', () => {
    expect(canSee(optedIn(['access', 'secret']), op('folder-access-grant'))).toBe(false)
  })

  it('never lets Piloti see one, whatever its principal claims', () => {
    const claiming: AgentPrincipal = { ...piloti, scopes: [SENSITIVE_SCOPE], sensitiveOptIns: ['access', 'secret'] }
    expect(maySeeSensitive(claiming, 'access', true)).toBe(false)
    expect(canSee(claiming, op('folder-access-grant'))).toBe(false)
  })
})

describe('backend operations', () => {
  it('are shown to a person and hidden from Piloti, which has them as native tools', () => {
    expect(visibleBackendOperations(person()).map((o) => o.name)).toContain('knowledge-search')
    expect(findVisibleBackendOperation(person(), 'knowledge-search')?.name).toBe('knowledge-search')
    expect(visibleBackendOperations(piloti)).toEqual([])
    expect(findVisibleBackendOperation(piloti, 'knowledge-search')).toBeUndefined()
  })
})
