/**
 * @vitest-environment node
 */
/**
 * The recursion lock (ADR-0124): Piloti never asks Piloti.
 *
 * In-product Piloti reaches the catalog only through its own door, where every
 * write becomes a proposal (ADR-0122), and a turn an ask started is such a turn.
 * So the lock is held where proposals are filed and applied: an ask is refused
 * when it is proposed (nothing is filed) and when an old one is applied
 * (nothing is called). Before both, Piloti never sees an ask (`canSee` in
 * `policy.ts`), so `agent-ask-get`, a read, cannot run either. The A2A door's
 * half, refusing Piloti's credential, is in `app/api/a2a/route.spec.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/agent-api/dispatch', async () => {
  const actual = await vi.importActual<typeof import('@/lib/agent-api/dispatch')>('@/lib/agent-api/dispatch')
  return { ...actual, callOperation: vi.fn() }
})

import { UnprocessableError } from '@/lib/api/errors'
import { findOperation } from '@/lib/agent-api/catalog'
import { callDecision, findVisibleOperation, visibleOperations } from '@/lib/agent-api/policy'
import type { AgentPrincipal } from '@/lib/agent-api/principal'
import { callOperation } from '@/lib/agent-api/dispatch'
import { requireProposable } from '@/lib/proposals/kinds'
import { applyOperation, AGENT_ASK_REFUSAL, requireProposableOperation } from '@/lib/proposals/operation-applier'
import type { OperationPayload } from '@/lib/proposals/types'
import type { AuthorizedSession } from '@/lib/auth/types'
import { AGENT_ASK_OPERATIONS } from './ask-wire'

const SESSION = { userId: 'user_anna', organizationId: 'org_1' } as AuthorizedSession

const payload = (operation: string): OperationPayload => ({
  operation,
  input: { body: { question: 'Was gilt hier?' } },
  summary: 'Ask Piloti a question and get its answer',
})

beforeEach(() => vi.clearAllMocks())

describe('the lock names real operations', () => {
  it.each(AGENT_ASK_OPERATIONS)('%s is in the catalog, on an agent-ask route', (name) => {
    const op = findOperation(name)
    expect(op, `${name} left the catalog: the lock would guard nothing`).toBeDefined()
    expect(op?.path.startsWith('/api/agent-asks')).toBe(true)
  })

  it('covers every operation on an agent-ask route', async () => {
    const { AGENT_OPERATIONS } = await import('@/lib/agent-api/catalog')
    const onAskRoutes = AGENT_OPERATIONS.filter((op) => op.path.startsWith('/api/agent-asks')).map((op) => op.name)
    expect(onAskRoutes.sort()).toEqual([...AGENT_ASK_OPERATIONS].sort())
  })
})

describe('Piloti does not see an ask', () => {
  const piloti: AgentPrincipal = { actor: 'piloti', session: SESSION, clientId: null, scopes: [] }
  const agent: AgentPrincipal = { actor: 'external_agent', session: SESSION, clientId: 'claude', scopes: [] }

  it.each(AGENT_ASK_OPERATIONS)('%s is absent from Piloti’s catalog and offered to an external agent', (name) => {
    expect(visibleOperations(piloti).map((op) => op.name)).not.toContain(name)
    expect(findVisibleOperation(piloti, name)).toBeUndefined()
    const offered = findVisibleOperation(agent, name)
    expect(offered?.name).toBe(name)
    expect(callDecision(agent, offered!)).toBe('run')
  })
})

describe('Piloti cannot propose an ask', () => {
  it.each(AGENT_ASK_OPERATIONS)('refuses to file %s, with the sentence the model relays', (name) => {
    expect(() => requireProposableOperation(payload(name))).toThrow(UnprocessableError)
    expect(() => requireProposableOperation(payload(name))).toThrow(AGENT_ASK_REFUSAL)
    expect(() => requireProposable({ kind: 'operation', payload: payload(name) })).toThrow(AGENT_ASK_REFUSAL)
  })

  it.each(AGENT_ASK_OPERATIONS)('applies no %s that was filed before the lock: nothing is called', async (name) => {
    const results = await applyOperation(payload(name), { session: SESSION })
    expect(results).toEqual([{ label: payload(name).summary, ok: false, reason: AGENT_ASK_REFUSAL }])
    expect(callOperation).not.toHaveBeenCalled()
  })
})
