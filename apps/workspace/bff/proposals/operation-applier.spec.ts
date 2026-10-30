/**
 * @vitest-environment node
 */
/**
 * Piloti never decides a proposal for the person (ADR-0105, ADR-0122): applying,
 * dismissing or undoing a change is absent from its catalog, refused when it is
 * proposed, and refused when an old proposal of one is applied, so one click on
 * a card Piloti worded can never be a yes to a change the person did not read.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/agent-api/dispatch', async () => {
  const actual = await vi.importActual<typeof import('@/lib/agent-api/dispatch')>('@/lib/agent-api/dispatch')
  return { ...actual, callOperation: vi.fn() }
})

import { UnprocessableError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { findOperation } from '@/lib/agent-api/catalog'
import { callOperation } from '@/lib/agent-api/dispatch'
import { findVisibleOperation, visibleOperations } from '@/lib/agent-api/policy'
import type { AgentPrincipal } from '@/lib/agent-api/principal'
import { proposingTurn } from './proposing-turn'
import { applyOperation, PROPOSAL_DECISION_OPERATIONS, PROPOSAL_DECISION_REFUSAL, requireProposableOperation } from './operation-applier'
import type { OperationPayload } from './types'

const SESSION = { userId: 'user_anna', organizationId: 'org_1' } as AuthorizedSession
const DECISIONS = ['proposal-apply', 'proposal-dismiss', 'agent-change-undo']

const payload = (operation: string): OperationPayload => ({
  operation,
  input: { params: { id: '6f1c2b8e-3d4a-4b6c-8d7e-9f0a1b2c3d4e' } },
  summary: 'Apply a proposed change',
})

beforeEach(() => vi.clearAllMocks())

describe('proposal decisions', () => {
  it('names real operations', () => {
    expect([...PROPOSAL_DECISION_OPERATIONS].sort()).toEqual([...DECISIONS].sort())
    for (const name of DECISIONS) expect(findOperation(name), `${name} left the catalog`).toBeDefined()
  })

  it.each(DECISIONS)('%s is absent from Piloti’s catalog and offered to an external agent', (name) => {
    const piloti: AgentPrincipal = { actor: 'piloti', session: SESSION, clientId: null, scopes: [] }
    const agent: AgentPrincipal = { actor: 'external_agent', session: SESSION, clientId: 'claude', scopes: [] }
    expect(visibleOperations(piloti).map((op) => op.name)).not.toContain(name)
    expect(findVisibleOperation(piloti, name)).toBeUndefined()
    expect(findVisibleOperation(agent, name)?.name).toBe(name)
  })

  it.each(DECISIONS)('refuses to file %s as a proposal', (name) => {
    expect(() => requireProposableOperation(payload(name))).toThrow(UnprocessableError)
    expect(() => requireProposableOperation(payload(name))).toThrow(PROPOSAL_DECISION_REFUSAL)
  })

  it.each(DECISIONS)('applies no %s filed before the refusal: nothing is called', async (name) => {
    const results = await applyOperation(payload(name), { session: SESSION })
    expect(results).toEqual([{ label: payload(name).summary, ok: false, reason: PROPOSAL_DECISION_REFUSAL }])
    expect(callOperation).not.toHaveBeenCalled()
  })
})

describe('the proposing turn', () => {
  it('is the proposal’s origin message while its route runs, and nothing after', async () => {
    let seen: string | null = 'unset'
    vi.mocked(callOperation).mockImplementationOnce(async () => {
      seen = proposingTurn()
      return { status: 200, ok: true, body: {} }
    })
    await applyOperation(payload('document-sketch-edit'), { session: SESSION, originMessageId: 'msg_1' })
    expect(seen).toBe('msg_1')
    expect(proposingTurn()).toBeNull()
  })
})

describe('an operation off the office door (ADR-0122, amendment of 2026-10-21)', () => {
  // A withheld operation and an operator-console one: proposed before they left the door, or never offered.
  it.each(['organization-instructions-set', 'platform-lesson-update'])(
    'is refused like an unknown name when %s is proposed or applied',
    async (name) => {
      expect(findOperation(name), `${name} is still catalogued`).toBeDefined()
      expect(() => requireProposableOperation(payload(name))).toThrow(`The operation ${name} no longer exists`)
      const results = await applyOperation(payload(name), { session: SESSION })
      expect(results).toEqual([{ label: payload(name).summary, ok: false, reason: `The operation ${name} no longer exists` }])
      expect(callOperation).not.toHaveBeenCalled()
    },
  )
})

describe('an operation Piloti does with a native tool (exposure.config.ts, `native:<tool>`)', () => {
  // Hiding it from Piloti's door is visibility only: a card filed before the change still applies.
  const memory: OperationPayload = {
    operation: 'project-memory-create',
    input: { params: { id: '6f1c2b8e-3d4a-4b6c-8d7e-9f0a1b2c3d4e' }, body: { kind: 'decision', content: 'Die Bauherrin will alle Pläne als PDF.' } },
    summary: 'Keep a note',
  }

  it('is hidden from Piloti and still applies when the person accepts an old card', async () => {
    const piloti: AgentPrincipal = { actor: 'piloti', session: SESSION, clientId: null, scopes: [] }
    expect(findVisibleOperation(piloti, memory.operation)).toBeUndefined()
    expect(() => requireProposableOperation(memory)).not.toThrow()
    vi.mocked(callOperation).mockResolvedValue({ status: 201, ok: true, body: { id: 'note_1' } })
    const results = await applyOperation(memory, { session: SESSION })
    expect(results).toEqual([expect.objectContaining({ ok: true })])
    expect(callOperation).toHaveBeenCalledTimes(1)
  })
})

describe('a sketch edit accepted', () => {
  it('records the Fassung it made, for the receipt’s undo', async () => {
    const edit: OperationPayload = {
      operation: 'document-sketch-edit',
      input: {
        params: { id: 'doc_1' },
        body: { baseVersionId: 'ver_1', ops: [{ op: 'remove', intent: 'Drop the store', id: 'store' }] },
      },
      summary: 'Change a sketch by operations',
    }
    expect(() => requireProposableOperation(edit)).not.toThrow()
    vi.mocked(callOperation).mockResolvedValue({ status: 200, ok: true, body: { versionId: 'ver_2', rebased: false } })
    expect(await applyOperation(edit, { session: SESSION })).toEqual([{ label: edit.summary, ok: true, itemId: 'ver_2' }])
  })
})
