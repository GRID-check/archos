/**
 * The view carries only three dictionary namespaces (`dictionaries-stand-in.ts`,
 * ADR-0142). Every card the view draws, open and decided, read-only, and the
 * frame's own lines, in both languages, is drawn here with exactly that module
 * in place of Piloti's dictionaries, and fails on any key it does not hold
 * (the translator warns `[i18n] Missing translation` and shows the key path).
 */

import { render, screen, waitFor } from '@/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/dictionaries', async () => import('../dictionaries-stand-in'))

import type { CallToolResult } from '@modelcontextprotocol/client'
import { ProposalCardFrame } from './ProposalCardApp'

const BASE = {
  projectId: '3d1c2f7a-5b8e-4c1d-9f20-6a7b8c9d0e1f',
  proposedByKind: 'piloti',
  onBehalfOf: 'user_anna',
  onBehalfOfName: 'Anna Berger',
  originConversationId: null,
  originMessageId: null,
  createdAt: '2026-10-27T09:12:00.000Z',
}
const OPEN = { status: 'proposed', decidedBy: null, decidedByName: null, decidedAt: null, results: null, canDecide: true }
const DECIDED = {
  status: 'applied',
  decidedBy: 'user_anna',
  decidedByName: 'Anna Berger',
  decidedAt: '2026-10-27T09:20:00.000Z',
  results: [{ label: 'x', ok: true }],
  canDecide: false,
}

const KINDS = {
  operation: {
    kind: 'operation',
    payload: { operation: 'folder-rename', summary: 'Rename a folder', input: { params: { id: 'p-1' }, body: { name: 'x'.repeat(400) } } },
    targets: [{ type: 'folder', id: 'f-1', name: 'Pläne alt' }],
  },
  file_operation: {
    kind: 'file_operation',
    payload: { operation: 'move', operations: [{ document: 'Grundriss EG.pdf', current: 'Nachweise', target_folder: 'Einreichung' }], note: 'A note' },
  },
  memory: {
    kind: 'memory',
    payload: { scope: 'organization', kind: 'decision', content: 'REI 90 throughout', confidence: 'high', supersedes: 'REI 60' },
  },
  project_profile: {
    kind: 'project_profile',
    payload: { title: 'Update the context', rationale: null, patch: [{ op: 'add', path: '/facts/heat_supply', value: 'waermepumpe' }] },
  },
} as const

const resultOf = (proposal: object): CallToolResult => ({ content: [{ type: 'text', text: '' }], structuredContent: { proposal } })
const app = { callServerTool: vi.fn(), updateModelContext: vi.fn(async () => ({})) }

afterEach(() => vi.restoreAllMocks())

describe('the view’s dictionaries hold every word its cards say', () => {
  const cases = Object.entries(KINDS).flatMap(([name, kind]) =>
    [
      ['open', OPEN],
      ['decided', DECIDED],
      ['read only', { ...OPEN, canDecide: false }],
    ].flatMap(([state, status]) =>
      (['en-US', 'de-AT'] as const).map((locale) => [`${name}, ${state as string}, ${locale}`, { ...BASE, ...(status as object), ...kind }, locale] as const),
    ),
  )

  it.each(cases)('%s', async (_label, proposal, locale) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const id = '5f0c8a3e-2b7d-4e1a-9c6f-1d2e3f4a5b6c'
    render(<ProposalCardFrame result={resultOf({ ...proposal, id })} hostContext={{ locale }} app={app} />)
    await waitFor(() => expect(screen.getByTestId('mcp-app-proposal-card').textContent).not.toBe(''))
    await waitFor(() => expect(screen.queryByTestId('mcp-app-waiting')).toBeNull())
    const missing = warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('[i18n] Missing'))
    expect(missing).toEqual([])
    expect(screen.getByTestId('mcp-app-proposal-card').textContent).not.toMatch(/\b(cards|chat|common|nav)\.[a-zA-Z]+\./)
  })

  it('says so when the result carries no proposal', () => {
    render(<ProposalCardFrame result={{ content: [{ type: 'text', text: 'nothing' }] }} hostContext={{ locale: 'en-US' }} app={app} />)
    expect(screen.getByTestId('mcp-app-unreadable')).toHaveTextContent('This proposal could not be shown.')
  })
})
