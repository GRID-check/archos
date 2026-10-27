/**
 * @vitest-environment node
 */
/**
 * One MCP tool call is one Langfuse trace (ADR-0089, ADR-0122). The mapping is
 * pure and checked field by field; the posting is checked at the network, the
 * way the agent door really sends it: through `recordOperationCalled`, the one
 * place every tool call is recorded.
 */
import { webcrypto } from 'node:crypto'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { recordOperationCalled } from '@/lib/agent-api/telemetry'
import type { AgentPrincipal } from '@/lib/agent-api/principal'
import { TOOL_CALL_TRACE_NAME, type ToolCallRecord, recordToolCallTrace, toolCallBatch } from './tool-call-trace'

const ids = { traceId: 'a'.repeat(32), observationId: 'obs-1', eventIds: ['ev-1', 'ev-2'] as [string, string] }

const call: ToolCallRecord = {
  operation: 'project-rename',
  domain: 'projects',
  door: 'piloti',
  mode: 'search',
  decision: 'propose',
  status: 202,
  startedAt: Date.parse('2026-10-21T09:00:00.000Z'),
  endedAt: Date.parse('2026-10-21T09:00:00.120Z'),
  clientId: null,
  organizationId: 'org_1',
  userId: 'user_1',
  conversationId: 'conv_1',
}

beforeAll(() => {
  // The shared setup file swaps `crypto` for a stub with no randomUUID.
  vi.stubGlobal('crypto', webcrypto)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('toolCallBatch', () => {
  it('is one agent-tool-call trace holding one TOOL observation named for the operation', () => {
    const [trace, observation] = toolCallBatch(call, ids).batch
    expect(trace).toMatchObject({
      type: 'trace-create',
      body: { id: ids.traceId, name: TOOL_CALL_TRACE_NAME, sessionId: 'conv_1', tags: ['feature:agent-mcp', 'door:piloti', 'decision:propose'] },
    })
    expect(observation).toMatchObject({
      type: 'observation-create',
      body: {
        traceId: ids.traceId,
        type: 'TOOL',
        name: 'mcp.project-rename',
        level: 'DEFAULT',
        startTime: '2026-10-21T09:00:00.000Z',
        endTime: '2026-10-21T09:00:00.120Z',
        metadata: { operation: 'project-rename', domain: 'projects', door: 'piloti', mode: 'search', decision: 'propose', status: 202, duration_ms: 120 },
      },
    })
  })

  it('names an A2A door call for its door, which has no mode', () => {
    const a2a: ToolCallRecord = { ...call, operation: 'piloti-ask-create', domain: 'conversations', door: 'a2a', mode: null, decision: 'run' }
    const [trace, observation] = toolCallBatch(a2a, ids).batch
    expect(trace?.body).toMatchObject({ tags: expect.arrayContaining(['door:a2a']) })
    expect(observation?.body).toMatchObject({ name: 'a2a.piloti-ask-create', metadata: { door: 'a2a', mode: null } })
  })

  it('names nobody unless identity attributes are on, and never carries the agent’s own text', () => {
    const unknown = toolCallBatch({ ...call, operation: null, decision: 'refused', status: 404 }, ids)
    const text = JSON.stringify(unknown)
    expect(text).not.toContain('user_1')
    expect(unknown.batch[1]).toMatchObject({ body: { name: 'mcp.unknown', level: 'WARNING', statusMessage: 'HTTP 404' } })

    vi.stubEnv('TRACE_IDENTITY_ATTRIBUTES', 'true')
    expect(toolCallBatch(call, ids).batch[0]).toMatchObject({ body: { userId: 'user_1', tags: expect.arrayContaining(['org:org_1']) } })
  })

  it('files the trace under the deployment’s environment and release', () => {
    vi.stubEnv('APP_ENV', 'Staging EU')
    vi.stubEnv('GIT_SHA', 'abc123')
    expect(toolCallBatch(call, ids).batch[0]).toMatchObject({ body: { environment: 'staging-eu', release: 'abc123' } })
  })
})

describe('posting', () => {
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(Response.json({ successes: [], errors: [] }, { status: 207 }))
    vi.stubGlobal('fetch', fetchMock)
  })

  it('sends nothing when Langfuse is not configured', async () => {
    await recordToolCallTrace(call)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends one ingestion batch for each tool call the agent door records', async () => {
    vi.stubEnv('LANGFUSE_PUBLIC_KEY', 'pk')
    vi.stubEnv('LANGFUSE_SECRET_KEY', 'sk') // pragma: allowlist secret
    vi.stubEnv('LANGFUSE_HOST', 'http://langfuse-web:3000')
    const principal = {
      actor: 'external_agent',
      clientId: 'client_1',
      scopes: [],
      session: { userId: 'user_1', organizationId: 'org_1' },
    } as unknown as AgentPrincipal

    recordOperationCalled({ principal, mode: 'tools' }, {
      operation: 'project-list',
      domain: 'projects',
      decision: 'run',
      status: 200,
      startedAt: Date.now() - 5,
    })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    const [url, init] = fetchMock.mock.calls[0] as [string | URL, RequestInit]
    expect(String(url)).toBe('http://langfuse-web:3000/api/public/ingestion')
    const sent = JSON.parse(String(init.body)) as { batch: { type: string; body: Record<string, unknown> }[] }
    expect(sent.batch.map((event) => event.type)).toEqual(['trace-create', 'observation-create'])
    expect(sent.batch[1].body).toMatchObject({ name: 'mcp.project-list', type: 'TOOL', metadata: { door: 'mcp', client_id: 'client_1' } })
  })
})
