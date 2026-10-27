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
  RENAMED_BACKEND_OPERATIONS,
  SENSITIVE_SCOPE,
  SENSITIVE_SCOPE_ENFORCED_BY_WORKOS,
  callDecision,
  doorOfPrincipal,
  canSee,
  findVisibleBackendOperation,
  findVisibleOperation,
  isOnDoor,
  maySeeSensitive,
  nativeToolOf,
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
    expect(callDecision(piloti, op('workspace-search'))).toBe('run')
  })

  it('turns every write by in-product Piloti into a proposal', () => {
    expect(callDecision(piloti, op('project-member-add'))).toBe('propose')
    expect(callDecision(piloti, op('project-delete'))).toBe('propose')
    expect(callDecision(piloti, op('project-folder-access-set'))).toBe('propose')
  })
})

describe('visibleOperations', () => {
  const names = (principal: AgentPrincipal) => visibleOperations(principal).map((candidate) => candidate.name)

  it('hides a sensitive operation from an external agent without the step-up scope', () => {
    expect(names(person())).not.toContain('project-folder-access-set')
    expect(names(person())).toContain('project-member-add')
  })

  it('ignores piloti:sensitive while WorkOS does not define and enforce it (M5)', () => {
    // A token carrying the string proves nothing until the authorization server grants it on step-up.
    expect(SENSITIVE_SCOPE_ENFORCED_BY_WORKOS).toBe(false)
    expect(names(person([SENSITIVE_SCOPE]))).not.toContain('project-folder-access-set')
    expect(findVisibleOperation(person([SENSITIVE_SCOPE]), 'project-folder-access-set')).toBeUndefined()
  })

  it('hides it from Piloti, which may not even propose it (M4)', () => {
    expect(names(piloti)).not.toContain('project-folder-access-set')
    expect(findVisibleOperation(piloti, 'project-folder-access-set')).toBeUndefined()
  })

  it('keeps every platform operation off the office door, for everyone (H3): it has a door of its own', () => {
    const platformRead = { ...op('project-list'), name: 'platform-overview-get', domain: 'platform' as const }
    expect(isOnDoor(platformRead.name)).toBe(false)
    expect(canSee(piloti, platformRead)).toBe(false)
    expect(canSee(person(), platformRead)).toBe(false)
  })

  it('offers the platform door what the config marks `platform`, and nothing else (ADR-0126)', () => {
    const platformRead = { ...op('project-list'), name: 'platform-overview-get', domain: 'platform' as const }
    const withheld = { ...platformRead, name: 'organization-model-config-get' }
    const operator = { ...person(), door: 'platform' as const }
    expect(isOnDoor(platformRead.name, 'platform')).toBe(true)
    expect(canSee(operator, platformRead)).toBe(true)
    expect(canSee(operator, withheld)).toBe(false)
    for (const operation of FAKE_OPERATIONS) expect(canSee(operator, operation), operation.name).toBe(false)
    expect(doorOfPrincipal(person())).toBe('office')
  })

  it('offers a withheld operation to nobody, as if it did not exist', () => {
    const withheld = { ...op('project-list'), name: 'organization-model-config-get' }
    expect(isOnDoor(withheld.name)).toBe(false)
    expect(isOnDoor(withheld.name, 'platform')).toBe(false)
    expect(canSee(piloti, withheld)).toBe(false)
    expect(canSee(person(), withheld)).toBe(false)
    expect(findVisibleOperation(person(), 'organization-model-config-get')).toBeUndefined()
    expect(findVisibleOperation(person(), 'citation-format')).toBeUndefined()
  })

  it('offers a name the config does not know to nobody: no silent default', () => {
    const unknown = { ...op('project-list'), name: 'project-unlisted-thing' }
    expect(canSee(person(), unknown)).toBe(false)
    expect(canSee(piloti, unknown)).toBe(false)
    expect(isOnDoor(unknown.name)).toBe(false)
  })

  it('hides from Piloti, and only from Piloti, what Piloti does with a native tool; it stays on the door', () => {
    // `annotation-create` is Piloti's `canvas__mark` (exposure.config.ts); the fake catalog has no native twin of its own.
    const mark = { ...op('project-member-add'), name: 'annotation-create' }
    expect(nativeToolOf('annotation-create')).toBe('canvas__mark')
    expect(canSee(piloti, mark)).toBe(false)
    expect(canSee(person(), mark)).toBe(true)
    // Visibility only: the operation is on the office door, so a proposal filed before still applies.
    expect(isOnDoor('annotation-create')).toBe(true)
    expect(nativeToolOf('project-list')).toBeUndefined()
  })

  it('hides the asks from Piloti, and only from Piloti: Piloti never asks Piloti (ADR-0124)', () => {
    for (const name of ['piloti-ask-create', 'piloti-ask-get', 'piloti-ask-cancel']) {
      const ask = { ...op('project-list'), name, domain: 'conversations' as const }
      expect(canSee(piloti, ask), name).toBe(false)
      expect(canSee(person(), ask), name).toBe(true)
    }
  })

  it('treats a hidden operation as absent', () => {
    expect(findVisibleOperation(person(), 'project-folder-access-set')).toBeUndefined()
    expect(findVisibleOperation(person(), 'project-list')?.name).toBe('project-list')
  })
})

describe('the guards on a sensitive operation (ADR-0122)', () => {
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
    expect(canSee(optedIn(['access', 'secret']), op('project-folder-access-set'))).toBe(false)
  })

  it('never lets Piloti see one, whatever its principal claims', () => {
    const claiming: AgentPrincipal = { ...piloti, scopes: [SENSITIVE_SCOPE], sensitiveOptIns: ['access', 'secret'] }
    expect(maySeeSensitive(claiming, 'access', true)).toBe(false)
    expect(canSee(claiming, op('project-folder-access-set'))).toBe(false)
  })
})

describe('backend operations', () => {
  it('are shown to a person and hidden from Piloti, which has them as native tools', () => {
    expect(visibleBackendOperations(person()).map((o) => o.name)).toContain('knowledge-search')
    expect(findVisibleBackendOperation(person(), 'knowledge-search')?.name).toBe('knowledge-search')
    expect(visibleBackendOperations(piloti)).toEqual([])
    expect(findVisibleBackendOperation(piloti, 'knowledge-search')).toBeUndefined()
  })

  it('answer to a renamed one’s old name for one release, without listing it under that name', () => {
    expect(findVisibleBackendOperation(person(), 'knowledge-image-view')?.name).toBe('document-look')
    expect(visibleBackendOperations(person()).map((o) => o.name)).not.toContain('knowledge-image-view')
    expect(findVisibleBackendOperation(piloti, 'knowledge-image-view')).toBeUndefined()
    for (const current of Object.values(RENAMED_BACKEND_OPERATIONS)) {
      expect(visibleBackendOperations(person()).map((o) => o.name)).toContain(current)
    }
  })

  it('are not on the platform door: they read an office’s workspace', () => {
    const operator = { ...person(), door: 'platform' as const }
    expect(visibleBackendOperations(operator)).toEqual([])
    expect(findVisibleBackendOperation(operator, 'knowledge-search')).toBeUndefined()
  })
})
