/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Break the authkit-nextjs import chain (pulls in next/cache) at load time.
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue(null),
}))

// Anonymous mode: no session/db lookups for collection scoping.
vi.mock('@/lib/proxy/collection-authz', () => ({
  parseQueryContext: vi.fn(() => ({})),
  // Body first, then the query, like the real one; enough to see a cancel's
  // `?projectId=` reach the scope builder.
  resolveRequestContext: vi.fn((searchParams: URLSearchParams, body?: Record<string, unknown>) => ({
    projectId:
      (typeof body?.projectId === 'string' ? body.projectId : undefined) ??
      searchParams.get('projectId') ??
      undefined,
  })),
}))

vi.mock('@/lib/retrieval-scope/collection-scope-request', () => ({
  buildCollectionScopeFromRequest: vi.fn().mockResolvedValue({
    headerValue: 'scope',
    scope: [],
    scopedCollections: [],
    projectId: undefined,
    verifiedConversationId: undefined,
  }),
}))

// Org model overrides lookup used by the POST handler to build
// X-Model-Overrides — controlled per-test below.
vi.mock('@/lib/model-config/service', () => ({
  getEffectiveModelOverrides: vi.fn(),
}))

// Structured federalState fact lookup (backlog T3-9 follow-up, 2026-07-16,
// user-mandated) — avoids pulling in the real @/lib/db chain; controlled
// per-test below like getEffectiveModelOverrides.
vi.mock('@/lib/project-profile/prompt-view', () => ({
  loadProjectFederalState: vi.fn().mockResolvedValue(null),
}))

// The commissioned-report filing, mocked at its own module so this suite
// asserts the WIRING — is it called, with what, and does its outcome reach the
// user's answer — and not the filing's own behaviour, which
// `lib/documents/commissioned-report.spec.ts` owns.
vi.mock('@/lib/documents/commissioned-report', () => ({
  fileCommissionedReport: vi.fn(),
}))
vi.mock('@/lib/projects/repository', () => ({
  // An active project: a closed one refuses the submit (ADR-0090).
  findProjectTenancy: vi.fn(async () => ({ organizationId: 'org_1', deletedAt: null, status: 'active' })),
}))

import { DELETE, GET, POST } from './route'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { getEffectiveModelOverrides } from '@/lib/model-config/service'
import { buildCollectionScopeFromRequest } from '@/lib/retrieval-scope/collection-scope-request'
import { loadProjectFederalState } from '@/lib/project-profile/prompt-view'
import { fileCommissionedReport } from '@/lib/documents/commissioned-report'
import { verifyRequestContextEnvelope } from '@/lib/request-context'

const originalRequireAuth = process.env.REQUIRE_AUTH
const originalInternalToken = process.env.INTERNAL_API_TOKEN

const getRequest = (url: string, headers: Record<string, string> = {}): Request =>
  new Request(url, { method: 'GET', headers })

const postRequest = (url: string, body?: unknown): Request =>
  new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

const streamParams = (path: string[]) => ({ params: Promise.resolve({ path }) })
const postParams = (path: string[]) => ({ params: Promise.resolve({ path }) })

/** Decodes the base64url JSON payload the way the Python backend does. */
const decodeModelOverridesHeader = (value: string): unknown =>
  JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))

describe('/api/jobs/async/[...path] proxy — SSE reconnection resume', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    // Anonymous mode so the proxy never resolves a WorkOS session / DB.
    delete process.env.REQUIRE_AUTH
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('data: {}\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalRequireAuth === undefined) {
      delete process.env.REQUIRE_AUTH
    } else {
      process.env.REQUIRE_AUTH = originalRequireAuth
    }
  })

  it('routes a stream reconnect with a Last-Event-ID header to the /stream/{last_event_id} endpoint', async () => {
    const res = await GET(
      getRequest('https://grid.example/api/jobs/async/job/job-1/stream', { 'Last-Event-ID': '42' }),
      streamParams(['job', 'job-1', 'stream'])
    )

    expect(res.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/v1/jobs/async/job/job-1/stream/42')
  })

  it('streams from the beginning when no Last-Event-ID header is present', async () => {
    const res = await GET(
      getRequest('https://grid.example/api/jobs/async/job/job-1/stream'),
      streamParams(['job', 'job-1', 'stream'])
    )

    expect(res.status).toBe(200)
    const upstreamUrl = String(fetchSpy.mock.calls[0][0])
    expect(upstreamUrl).toMatch(/\/v1\/jobs\/async\/job\/job-1\/stream$/)
  })

  it('ignores a non-numeric Last-Event-ID header (backend event ids are integers)', async () => {
    await GET(
      getRequest('https://grid.example/api/jobs/async/job/job-1/stream', {
        'Last-Event-ID': 'abc; DROP TABLE',
      }),
      streamParams(['job', 'job-1', 'stream'])
    )

    const upstreamUrl = String(fetchSpy.mock.calls[0][0])
    expect(upstreamUrl).toMatch(/\/v1\/jobs\/async\/job\/job-1\/stream$/)
  })

  it('does not append the header to an explicit /stream/{id} resume request', async () => {
    await GET(
      getRequest('https://grid.example/api/jobs/async/job/job-1/stream/7', {
        'Last-Event-ID': '42',
      }),
      streamParams(['job', 'job-1', 'stream', '7'])
    )

    const upstreamUrl = String(fetchSpy.mock.calls[0][0])
    expect(upstreamUrl).toMatch(/\/v1\/jobs\/async\/job\/job-1\/stream\/7$/)
  })

  it('leaves non-stream requests untouched by the Last-Event-ID header', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ job_id: 'job-1', status: 'running', error: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )

    await GET(
      getRequest('https://grid.example/api/jobs/async/job/job-1', { 'Last-Event-ID': '42' }),
      streamParams(['job', 'job-1'])
    )

    const upstreamUrl = String(fetchSpy.mock.calls[0][0])
    expect(upstreamUrl).toMatch(/\/v1\/jobs\/async\/job\/job-1$/)
  })
})

describe('/api/jobs/async/[...path] proxy — POST org model overrides', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  const session = {
    userId: 'user-1',
    organizationId: 'org-1',
    email: 'user@app.example',
    name: 'Test User',
    accessToken: 'token-abc',
    organizationMembershipId: 'membership-1',
    role: 'member',
    permissions: [] as string[],
    featureFlags: ['deep-research'],
  }

  beforeEach(() => {
    // These tests need a resolved org, so run with auth required and a
    // session that carries organizationId — unlike the anonymous-mode
    // suites above.
    process.env.REQUIRE_AUTH = 'true'
    vi.mocked(requireAuthorizedSession).mockResolvedValue(session)
    vi.mocked(loadProjectFederalState).mockResolvedValue(null)
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ job_id: 'job-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalRequireAuth === undefined) {
      delete process.env.REQUIRE_AUTH
    } else {
      process.env.REQUIRE_AUTH = originalRequireAuth
    }
  })

  it('forwards X-Model-Overrides with the base64url payload when the org has overrides', async () => {
    vi.mocked(getEffectiveModelOverrides).mockResolvedValue({ deep_research: 'openrouter/model-x' })

    const res = await POST(
      postRequest('https://grid.example/api/jobs/async/submit', { agent_type: 'deep_research' }),
      postParams(['submit'])
    )

    expect(res.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const init = fetchSpy.mock.calls[0][1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers['X-Model-Overrides']).toBeDefined()
    expect(decodeModelOverridesHeader(headers['X-Model-Overrides'])).toEqual({
      deep_research: 'openrouter/model-x',
    })
  })

  it('omits the header cleanly when the org has no overrides configured', async () => {
    vi.mocked(getEffectiveModelOverrides).mockResolvedValue(null)

    const res = await POST(
      postRequest('https://grid.example/api/jobs/async/submit', { agent_type: 'deep_research' }),
      postParams(['submit'])
    )

    expect(res.status).toBe(200)
    const init = fetchSpy.mock.calls[0][1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers['X-Model-Overrides']).toBeUndefined()
  })

  it('still proxies the submission without the header when override resolution throws', async () => {
    vi.mocked(getEffectiveModelOverrides).mockRejectedValue(new Error('db unavailable'))

    const res = await POST(
      postRequest('https://grid.example/api/jobs/async/submit', { agent_type: 'deep_research' }),
      postParams(['submit'])
    )

    expect(res.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const init = fetchSpy.mock.calls[0][1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers['X-Model-Overrides']).toBeUndefined()
  })
})

describe('/api/jobs/async/[...path] proxy — signed X-Request-Context envelope', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  const session = {
    userId: 'user-1',
    organizationId: 'org-1',
    email: 'user@app.example',
    name: 'Test User',
    accessToken: 'token-abc',
    organizationMembershipId: 'membership-1',
    role: 'member',
    permissions: [] as string[],
    featureFlags: ['deep-research'],
  }

  beforeEach(() => {
    process.env.REQUIRE_AUTH = 'true'
    vi.mocked(requireAuthorizedSession).mockResolvedValue(session)
    vi.mocked(buildCollectionScopeFromRequest).mockResolvedValue({
      headerValue: 'scope',
      scope: ['oib_knowledge', 'proj_abc'],
      scopedCollections: [{ collection: 'oib_knowledge', shelf: 'base' }, { collection: 'proj_abc', shelf: 'project' }],
      projectId: 'proj-1',
      projectCollectionName: 'proj_abc',
      conversationId: undefined,
      verifiedConversationId: undefined,
    })
    vi.mocked(getEffectiveModelOverrides).mockResolvedValue(null)
    vi.mocked(loadProjectFederalState).mockResolvedValue(null)
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ job_id: 'job-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalRequireAuth === undefined) {
      delete process.env.REQUIRE_AUTH
    } else {
      process.env.REQUIRE_AUTH = originalRequireAuth
    }
    if (originalInternalToken === undefined) {
      delete process.env.INTERNAL_API_TOKEN
    } else {
      process.env.INTERNAL_API_TOKEN = originalInternalToken
    }
  })

  it('attaches an unsigned envelope carrying org/user/project/scope when no internal token is configured', async () => {
    delete process.env.INTERNAL_API_TOKEN

    const res = await POST(
      postRequest('https://grid.example/api/jobs/async/submit', { agent_type: 'deep_research' }),
      postParams(['submit'])
    )

    expect(res.status).toBe(200)
    const init = fetchSpy.mock.calls[0][1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers['X-Request-Context']).toBeDefined()
    expect(headers['X-Request-Context-Sig']).toBeUndefined()

    const decoded = JSON.parse(
      Buffer.from(headers['X-Request-Context'], 'base64url').toString('utf8')
    )
    // `collectionScope` carries the SHELF-BEARING entries, not bare names.
    // `scoping.py` prefers this signed envelope and reads the raw header only
    // when no valid envelope is present, so a shelf that rode the header alone
    // would never reach an authenticated turn (ADR-0047).
    expect(decoded).toEqual({
      organizationId: 'org-1',
      userId: 'user-1',
      projectId: 'proj-1',
      collectionScope: [
        { collection: 'oib_knowledge', shelf: 'base' },
        { collection: 'proj_abc', shelf: 'project' },
      ],
      // The backend refuses an envelope without one as a grant (ADR-0084).
      issuedAt: expect.any(Number),
      // Who the job is for, by name: what the agent's prompt calls the person.
      requester: { name: 'Test User', email: 'user@app.example', organizationName: null },
    })
  })

  it('signs the envelope when INTERNAL_API_TOKEN is configured', async () => {
    process.env.INTERNAL_API_TOKEN = 'test-secret'

    const res = await POST(
      postRequest('https://grid.example/api/jobs/async/submit', { agent_type: 'deep_research' }),
      postParams(['submit'])
    )

    expect(res.status).toBe(200)
    const init = fetchSpy.mock.calls[0][1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers['X-Request-Context-Sig']).toMatch(/^[0-9a-f]{64}$/)
  })

  it('still attaches the envelope when model-overrides resolution throws (envelope is not best-effort)', async () => {
    vi.mocked(getEffectiveModelOverrides).mockRejectedValue(new Error('db unavailable'))

    const res = await POST(
      postRequest('https://grid.example/api/jobs/async/submit', { agent_type: 'deep_research' }),
      postParams(['submit'])
    )

    expect(res.status).toBe(200)
    const init = fetchSpy.mock.calls[0][1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers['X-Request-Context']).toBeDefined()
  })

  it('carries the resolved federal-state fact structurally on the envelope (backlog T3-9 follow-up, 2026-07-16)', async () => {
    vi.mocked(loadProjectFederalState).mockResolvedValue('tyrol')

    const res = await POST(
      postRequest('https://grid.example/api/jobs/async/submit', { agent_type: 'deep_research' }),
      postParams(['submit'])
    )

    expect(res.status).toBe(200)
    expect(loadProjectFederalState).toHaveBeenCalledWith('proj-1', 'org-1')
    const init = fetchSpy.mock.calls[0][1] as RequestInit
    const headers = init.headers as Record<string, string>
    const decoded = JSON.parse(
      Buffer.from(headers['X-Request-Context'], 'base64url').toString('utf8')
    )
    expect(decoded.federalState).toBe('tyrol')
  })

  it('omits the federal state from the envelope cleanly when the project has no valid fact', async () => {
    vi.mocked(loadProjectFederalState).mockResolvedValue(null)

    const res = await POST(
      postRequest('https://grid.example/api/jobs/async/submit', { agent_type: 'deep_research' }),
      postParams(['submit'])
    )

    expect(res.status).toBe(200)
    const init = fetchSpy.mock.calls[0][1] as RequestInit
    const headers = init.headers as Record<string, string>
    const decoded = JSON.parse(
      Buffer.from(headers['X-Request-Context'], 'base64url').toString('utf8')
    )
    expect(decoded.federalState).toBeUndefined()
  })

  it('still proxies the submission without the federal state when the lookup throws (best-effort)', async () => {
    vi.mocked(loadProjectFederalState).mockRejectedValue(new Error('db unavailable'))

    const res = await POST(
      postRequest('https://grid.example/api/jobs/async/submit', { agent_type: 'deep_research' }),
      postParams(['submit'])
    )

    expect(res.status).toBe(200)
    const init = fetchSpy.mock.calls[0][1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers['X-Request-Context']).toBeDefined()
    const decoded = JSON.parse(
      Buffer.from(headers['X-Request-Context'], 'base64url').toString('utf8')
    )
    expect(decoded.federalState).toBeUndefined()
  })
})

/**
 * A finished run's report used to be read once, rendered into a chat message
 * and discarded with the run's whole file system. This is the point at which
 * the BFF observes that completion. The filing itself is
 * `fileCommissionedReport` (`lib/documents/commissioned-report.spec.ts` owns its
 * behaviour); this suite asserts the WIRING: which path calls it, with what,
 * and how each outcome reaches the answer.
 */
describe('/api/jobs/async/[...path] proxy — filing a commissioned report', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  const session = {
    userId: 'user-1',
    organizationId: 'org-1',
    email: 'user@app.example',
    name: 'Test User',
    accessToken: 'token-abc',
    organizationMembershipId: 'membership-1',
    role: 'member',
    permissions: ['project:documents:write'],
    featureFlags: ['deep-research'],
  }

  const reportResponse = (body: Record<string, unknown>) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })

  const REPORT_BODY = {
    job_id: 'job-1',
    has_report: true,
    report: '# Bericht\n\nText.',
    project_collection: 'proj_abc',
  }

  const readReport = () =>
    GET(
      getRequest('https://grid.example/api/jobs/async/job/job-1/report?projectId=proj-1'),
      streamParams(['job', 'job-1', 'report'])
    )

  beforeEach(() => {
    process.env.REQUIRE_AUTH = 'true'
    vi.mocked(requireAuthorizedSession).mockResolvedValue(session)
    vi.mocked(fileCommissionedReport).mockResolvedValue({ outcome: 'queued' })
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reportResponse(REPORT_BODY))
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.mocked(fileCommissionedReport).mockReset()
    if (originalRequireAuth === undefined) {
      delete process.env.REQUIRE_AUTH
    } else {
      process.env.REQUIRE_AUTH = originalRequireAuth
    }
  })

  it('hands the run id, the reader’s session and the upstream body to the filing', async () => {
    await readReport()

    expect(fileCommissionedReport).toHaveBeenCalledWith({
      runId: 'job-1',
      session: expect.objectContaining({ userId: 'user-1', organizationId: 'org-1' }),
      body: REPORT_BODY,
    })
  })

  it('tells the client a queued filing is on its way, beside the untouched report', async () => {
    const res = await readReport()

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject(REPORT_BODY)
    expect(body.filingQueued).toBe(true)
    expect(body.filed).toBeUndefined()
    expect(body.filingFailed).toBeUndefined()
  })

  it('tells the client where a filed report landed', async () => {
    vi.mocked(fileCommissionedReport).mockResolvedValue({
      outcome: 'filed',
      filed: { documentId: 'doc-1', filename: 'bericht-2026-08-20.pdf', alreadyFiled: true },
    })

    const body = await (await readReport()).json()

    expect(body).toMatchObject(REPORT_BODY)
    expect(body.filed).toEqual({ documentId: 'doc-1', filename: 'bericht-2026-08-20.pdf', alreadyFiled: true })
    expect(body.filingQueued).toBeUndefined()
  })

  it.each(['failed', 'refused'] as const)('reports a %s filing as the broken promise, and still returns the report', async (outcome) => {
    vi.mocked(fileCommissionedReport).mockResolvedValue({ outcome })

    const res = await readReport()

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject(REPORT_BODY)
    expect(body.filingFailed).toBe(true)
    expect(body.filed).toBeUndefined()
    expect(body.filingQueued).toBeUndefined()
  })

  it('returns the body untouched when no promise was made', async () => {
    vi.mocked(fileCommissionedReport).mockResolvedValue(null)

    const body = await (await readReport()).json()

    expect(body).toEqual(REPORT_BODY)
  })

  it('files nothing on the status endpoint — only a report is a document', async () => {
    fetchSpy.mockResolvedValue(reportResponse({ job_id: 'job-1', status: 'completed' }))

    await GET(getRequest('https://grid.example/api/jobs/async/job/job-1'), streamParams(['job', 'job-1']))

    expect(fileCommissionedReport).not.toHaveBeenCalled()
  })

  it('hands no session to the filing in anonymous mode', async () => {
    delete process.env.REQUIRE_AUTH

    await GET(getRequest('https://grid.example/api/jobs/async/job/job-1/report'), streamParams(['job', 'job-1', 'report']))

    expect(fileCommissionedReport).toHaveBeenCalledWith(expect.objectContaining({ session: null }))
  })
})

describe('/api/jobs/async/[...path] proxy — every method carries the signed envelope (ADR-0084)', () => {
  // The backend lets a job's owner through on the bearer alone and anyone else
  // only inside the project or conversation this envelope signs, so a teammate's
  // stream, status, report and cancel are refused without it.
  const SECRET = 'test-secret' // pragma: allowlist secret
  let fetchSpy: ReturnType<typeof vi.spyOn>

  const session = {
    userId: 'user-1',
    organizationId: 'org-1',
    email: 'user@app.example',
    name: 'Test User',
    accessToken: 'token-abc',
    organizationMembershipId: 'membership-1',
    role: 'member',
    permissions: [] as string[],
    featureFlags: ['deep-research'],
  }

  const sentHeaders = (call = 0): Record<string, string> =>
    (fetchSpy.mock.calls[call][1] as RequestInit).headers as Record<string, string>

  /** The envelope as the BFF's own verifier reads it: signed, in its window, naming the checked scope. */
  const verifiedEnvelope = (call = 0) => {
    const headers = sentHeaders(call)
    return verifyRequestContextEnvelope(
      headers['X-Request-Context'],
      headers['X-Request-Context-Sig'],
      SECRET
    )
  }

  beforeEach(() => {
    process.env.REQUIRE_AUTH = 'true'
    process.env.INTERNAL_API_TOKEN = SECRET
    vi.mocked(requireAuthorizedSession).mockResolvedValue(session)
    vi.mocked(buildCollectionScopeFromRequest).mockResolvedValue({
      headerValue: 'scope',
      scope: ['oib_knowledge', 'proj_abc'],
      scopedCollections: [
        { collection: 'oib_knowledge', shelf: 'base' },
        { collection: 'proj_abc', shelf: 'project' },
      ],
      projectId: 'proj-1',
      projectCollectionName: 'proj_abc',
      conversationId: 'conv-1',
      verifiedConversationId: 'conv-1',
    })
    vi.mocked(getEffectiveModelOverrides).mockResolvedValue(null)
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(JSON.stringify({ job_id: 'job-1', status: 'running' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    )
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalRequireAuth === undefined) delete process.env.REQUIRE_AUTH
    else process.env.REQUIRE_AUTH = originalRequireAuth
    if (originalInternalToken === undefined) delete process.env.INTERNAL_API_TOKEN
    else process.env.INTERNAL_API_TOKEN = originalInternalToken
  })

  it.each([
    [['job', 'job-1']],
    [['job', 'job-1', 'stream']],
    [['job', 'job-1', 'report']],
    [['job', 'job-1', 'state']],
  ])('signs the checked project and conversation on GET %j', async (path) => {
    await GET(getRequest(`https://grid.example/api/jobs/async/${path.join('/')}?projectId=proj-1`), streamParams(path))

    expect(verifiedEnvelope()).toMatchObject({
      organizationId: 'org-1',
      userId: 'user-1',
      projectId: 'proj-1',
      conversationId: 'conv-1',
    })
    const payload = JSON.parse(Buffer.from(sentHeaders()['X-Request-Context'], 'base64url').toString('utf8'))
    expect(payload.collectionScope).toContainEqual({ collection: 'proj_abc', shelf: 'project' })
    expect(sentHeaders().Authorization).toBe('Bearer token-abc')
  })

  it('signs it on DELETE', async () => {
    await DELETE(
      new Request('https://grid.example/api/jobs/async/job/job-1/cancel?projectId=proj-1', { method: 'DELETE' }),
      postParams(['job', 'job-1', 'cancel'])
    )

    expect(verifiedEnvelope()).toMatchObject({ organizationId: 'org-1', userId: 'user-1', projectId: 'proj-1' })
  })

  it('signs a cancel’s `?projectId=` without loading what only a submit configures', async () => {
    await POST(
      postRequest('https://grid.example/api/jobs/async/job/job-1/cancel?projectId=proj-1'),
      postParams(['job', 'job-1', 'cancel'])
    )

    expect(buildCollectionScopeFromRequest).toHaveBeenCalledWith(session, { projectId: 'proj-1' })
    expect(verifiedEnvelope()).toMatchObject({ projectId: 'proj-1' })
    expect(getEffectiveModelOverrides).not.toHaveBeenCalled()
  })

  it('signs nothing as a conversation the scope builder did not find and authorize', async () => {
    vi.mocked(buildCollectionScopeFromRequest).mockResolvedValue({
      headerValue: 'scope',
      scope: ['oib_knowledge', 's_conv-new'],
      scopedCollections: [{ collection: 'oib_knowledge', shelf: 'base' }],
      projectId: undefined,
      projectCollectionName: undefined,
      conversationId: 'conv-new',
      verifiedConversationId: undefined,
    })

    await GET(getRequest('https://grid.example/api/jobs/async/job/job-1?conversationId=conv-new'), streamParams(['job', 'job-1']))

    expect(verifiedEnvelope()?.conversationId).toBeNull()
  })

  it('filters the run listing to the checked project and never forwards a client collection', async () => {
    await GET(
      getRequest('https://grid.example/api/jobs/async/jobs?projectId=proj-1&project_collection=proj_other&status=running'),
      streamParams(['jobs'])
    )

    const upstream = new URL(String(fetchSpy.mock.calls[0][0]))
    expect(upstream.pathname).toBe('/v1/jobs/async/jobs')
    expect(upstream.searchParams.get('project_collection')).toBe('proj_abc')
    expect(upstream.searchParams.get('status')).toBe('running')
    expect(upstream.searchParams.has('projectId')).toBe(false)
    expect(verifiedEnvelope()).toMatchObject({ projectId: 'proj-1' })
  })

  it('forwards no project filter when the listing names no project', async () => {
    await GET(
      getRequest('https://grid.example/api/jobs/async/jobs?project_collection=proj_other'),
      streamParams(['jobs'])
    )

    const upstream = new URL(String(fetchSpy.mock.calls[0][0]))
    expect(upstream.searchParams.has('project_collection')).toBe(false)
  })
})

describe('/api/jobs/async/[...path] proxy — a cancel the backend refuses because the run ended (#632)', () => {
  // The Sessions panel's stop goes out as POST /job/{id}/cancel. The first
  // fix for #632 guarded GET and DELETE only, so this path kept filing an
  // ERROR per refused cancel. Both terminal statuses the backend names.
  beforeEach(() => {
    delete process.env.REQUIRE_AUTH
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalRequireAuth !== undefined) process.env.REQUIRE_AUTH = originalRequireAuth
  })

  it.each(['success', 'failure'])('warns, never errors, for a job already at %s', async (terminal) => {
    const detail = `{"detail":"Job not cancellable: job-1 (status: ${terminal})"}`
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(detail, { status: 400 }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const res = await POST(postRequest('https://grid.example/api/jobs/async/job/job-1/cancel'), postParams(['job', 'job-1', 'cancel']))

    expect(res.status).toBe(400)
    expect(error).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cancel race'), expect.stringContaining(terminal))
  })

  it('still errors for any other backend refusal', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"detail":"boom"}', { status: 500 }))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await POST(postRequest('https://grid.example/api/jobs/async/job/job-1/cancel'), postParams(['job', 'job-1', 'cancel']))

    expect(error).toHaveBeenCalledWith(expect.stringContaining('POST backend error'), 500, '{"detail":"boom"}')
  })
})

describe('/api/jobs/async/[...path] proxy — a run’s documents have one door (ADR-0055, ADR-0087)', () => {
  // `addRunDocument` checks a document against the project's restricted
  // folders before the backend hears of it; the proxy would forward the same
  // control with a signed project and no such check, so it does not serve it.
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    delete process.env.REQUIRE_AUTH
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalRequireAuth !== undefined) process.env.REQUIRE_AUTH = originalRequireAuth
  })

  it.each([
    [['job', 'job-1', 'documents']],
    [['job', 'job-1', 'documents', '']],
    [['job', 'job-1', 'x', '..', 'documents']],
    [['job', 'job-1', 'x/../documents']],
  ])('refuses %j without calling the backend, and names the run route', async (path) => {
    const res = await POST(
      postRequest('https://grid.example/api/jobs/async/job/job-1/documents?projectId=project-1', {
        name: 'Abmahnung_Meier_2026.pdf',
        title: 'Abmahnung Meier',
      }),
      postParams(path)
    )

    expect(res.status).toBe(404)
    expect((await res.json()).error.message).toContain('/api/projects/{projectId}/runs/{runId}/documents')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it.each(['cancel', 'write-now'])('still forwards %s', async (action) => {
    const res = await POST(
      postRequest(`https://grid.example/api/jobs/async/job/job-1/${action}?projectId=project-1`),
      postParams(['job', 'job-1', action])
    )
    expect(res.status).toBe(200)
    expect(String(fetchSpy.mock.calls[0][0])).toContain(`/v1/jobs/async/job/job-1/${action}`)
  })
})
