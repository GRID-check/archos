/**
 * @vitest-environment node
 */
/**
 * The recursion lock (ADR-0123): Piloti never asks Piloti.
 *
 * In-product Piloti reaches the catalog only through its own door, where every
 * write becomes a proposal (ADR-0121), and a turn an ask started is such a turn.
 * So the lock is held where proposals are filed and applied: an ask is refused
 * when it is proposed (nothing is filed) and when an old one is applied
 * (nothing is called). The A2A door's half, refusing Piloti's credential, is in
 * `app/api/a2a/route.spec.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/agent-api/dispatch', async () => {
  const actual = await vi.importActual<typeof import('@/lib/agent-api/dispatch')>('@/lib/agent-api/dispatch')
  return { ...actual, callOperation: vi.fn() }
})

import { UnprocessableError } from '@/lib/api/errors'
import { findOperation } from '@/lib/agent-api/catalog'
import { callOperation } from '@/lib/agent-api/dispatch'
import { requireProposable } from '@/lib/proposals/kinds'
import { applyOperation, PILOTI_ASK_REFUSAL, requireProposableOperation } from '@/lib/proposals/operation-applier'
import type { OperationPayload } from '@/lib/proposals/types'
import type { AuthorizedSession } from '@/lib/auth/types'
import { PILOTI_ASK_OPERATIONS } from './ask-wire'

const SESSION = { userId: 'user_anna', organizationId: 'org_1' } as AuthorizedSession

const payload = (operation: string): OperationPayload => ({
  operation,
  input: { body: { question: 'Was gilt hier?' } },
  summary: 'Ask Piloti a question and get its answer',
})

beforeEach(() => vi.clearAllMocks())

describe('the lock names real operations', () => {
  it.each(PILOTI_ASK_OPERATIONS)('%s is in the catalog, on a piloti-ask route', (name) => {
    const op = findOperation(name)
    expect(op, `${name} left the catalog: the lock would guard nothing`).toBeDefined()
    expect(op?.path.startsWith('/api/piloti-asks')).toBe(true)
  })

  it('covers every operation on a piloti-ask route', async () => {
    const { AGENT_OPERATIONS } = await import('@/lib/agent-api/catalog')
    const onAskRoutes = AGENT_OPERATIONS.filter((op) => op.path.startsWith('/api/piloti-asks')).map((op) => op.name)
    expect(onAskRoutes.sort()).toEqual([...PILOTI_ASK_OPERATIONS].sort())
  })
})

describe('Piloti cannot propose an ask', () => {
  it.each(PILOTI_ASK_OPERATIONS)('refuses to file %s, with the sentence the model relays', (name) => {
    expect(() => requireProposableOperation(payload(name))).toThrow(UnprocessableError)
    expect(() => requireProposableOperation(payload(name))).toThrow(PILOTI_ASK_REFUSAL)
    expect(() => requireProposable({ kind: 'operation', payload: payload(name) })).toThrow(PILOTI_ASK_REFUSAL)
  })

  it.each(PILOTI_ASK_OPERATIONS)('applies no %s that was filed before the lock: nothing is called', async (name) => {
    const results = await applyOperation(payload(name), { session: SESSION })
    expect(results).toEqual([{ label: payload(name).summary, ok: false, reason: PILOTI_ASK_REFUSAL }])
    expect(callOperation).not.toHaveBeenCalled()
  })
})
