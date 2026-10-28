/**
 * Deep Research API Route Proxy
 *
 * Proxies requests to the deep research async jobs API.
 * This avoids CORS issues by keeping browser requests on the same origin.
 *
 * Authentication handling:
 * - When REQUIRE_AUTH=true: Forwards idToken cookie to backend for backend authentication
 * - When REQUIRE_AUTH=false: Skips all auth info to ensure anonymous requests
 *
 * Session/bearer resolution (incl. the `?token=` fallback for EventSource
 * streams) is shared with the v1 proxy via `@/lib/proxy/proxy-request`.
 *
 * Authorization (ADR-0084): every method resolves the scope the caller named
 * (`?projectId=`, `?conversationId=`, or the body's) through
 * `buildCollectionScopeFromRequest`, which checks `CHAT_PERMISSIONS` on the
 * project and `viewer` on the conversation, and sends it as the signed
 * envelope. The backend lets the job's owner through, and anyone else only to a
 * job inside that project (read and steer) or conversation (read).
 *
 * Handles:
 * - GET /api/jobs/async/jobs?projectId= - List research runs, filtered to the checked project
 * - GET /api/jobs/async/agents - List available agents
 * - POST /api/jobs/async/submit - Submit a new job
 * - GET /api/jobs/async/job/{job_id} - Get job status
 * - GET /api/jobs/async/job/{job_id}/stream - SSE stream (primary use case)
 * - GET /api/jobs/async/job/{job_id}/stream/{last_event_id} - SSE reconnection
 * - POST /api/jobs/async/job/{job_id}/cancel - Cancel job
 * - POST /api/jobs/async/job/{job_id}/write-now - „Jetzt schreiben"
 *
 * Not served: POST job/{job_id}/documents answers 404 without reaching the
 * backend. A document reaches a running run only through the run primitive,
 * `POST /api/projects/{id}/runs/{runId}/documents` (`addRunDocument`,
 * ADR-0055), which refuses a document from a restricted folder (ADR-0087).
 * - DELETE /api/jobs/async/job/{job_id}/cancel - Cancel job
 * - GET /api/jobs/async/job/{job_id}/state - Get job artifacts
 * - GET /api/jobs/async/job/{job_id}/report - Get final report
 *
 * The report GET is also where a commissioned run's completion is OBSERVED on
 * the BFF, and therefore where the report stops being a chat message that dies
 * with the run's file system and becomes a `documents` row the project can
 * find, assign, preview and delete (`fileCommissionedReport` in
 * `@/lib/documents/commissioned-report`; this route only matches the path).
 *
 * @see docs/api/bff-routes.md - Deep Research / Async Jobs, incl. the additive
 *      `filed` object this route adds to the report response
 */

import { NextResponse } from 'next/server'
import { tenantSlotRoute } from '@/lib/db/tenant-context'
import { buildCollectionScopeFromRequest } from '@/lib/retrieval-scope/collection-scope-request'
import { FEATURE_FLAGS, requireFeature } from '@/lib/authz/feature-flags'
import { isAuthzRefusal } from '@/lib/api/errors'
import { getEffectiveModelOverrides } from '@/lib/model-config/service'
import { loadProjectFederalState } from '@/lib/project-profile/prompt-view'
import { resolveOrgInstructions } from '@/lib/org-instructions/service'
import {
  signJobRequestContext,
  type AuthorizedJobScope,
  type JobSubmitContext,
} from '@/lib/jobs/request-envelope'
import {
  buildAuthHeaders,
  backendErrorEnvelope,
  errorEnvelope,
  noResponseBodyEnvelope,
  handleAuthzError,
  proxyErrorEnvelope,
  sseStreamResponse,
} from '@/lib/backend-proxy'
import { parseQueryContext, resolveRequestContext } from '@/lib/proxy/collection-authz'
import { buildProxyUrl, resolveSessionAndBearer } from '@/lib/proxy/proxy-request'
import type { GridSession } from '@/lib/auth/types'
import { fileCommissionedReport } from '@/lib/documents/commissioned-report'
import { findProjectTenancy } from '@/lib/projects/repository'
import { isProjectClosed, projectClosedError } from '@/lib/projects/project-status'

/**
 * The signed context envelope (backlog T3-9 follow-up, 2026-07-16,
 * user-mandated; ADR-0084) for every request this proxy forwards, plus, on a
 * submit, the per-org runtime model overrides ({agentGroup: openrouterModelId})
 * — same header/encoding server.js forwards on the WebSocket upgrade
 * (x-grid-model-overrides, base64url JSON), decoded by the backend
 * (model_overrides.py). Without the overrides header, submit falls through to
 * the WS-only override path and jobs silently run on YAML-default models even
 * when the org has configured overrides.
 *
 * The envelope goes on every method, not only the submit: the backend
 * authorizes a job by the scope it signs (`backend/jobs/access.py`). It lets the
 * owner through on the bearer alone and anyone else only inside the project or
 * conversation this tier checked, so a teammate's stream, status, report and
 * cancel all need it. Without it the caller reaches only the jobs it owns.
 *
 * Built by `signJobRequestContext` (`@/lib/jobs/request-envelope`), the one
 * builder every job request uses. Always returns at least the envelope headers
 * (never just `{}`) so the caller can unconditionally spread the result into the
 * fetch headers.
 */
async function resolveGridContextHeaders(
  session: GridSession | null,
  scope: AuthorizedJobScope,
  { submit }: { submit: boolean }
): Promise<Record<string, string>> {
  const submitContext = submit ? await resolveSubmitContext(session, scope.projectId) : {}
  return signJobRequestContext(session, scope, submitContext)
}

/**
 * What a submit configures its run with. Every lookup here is best-effort: a
 * failure must not block job submission — the rest of the context
 * (org/user/project/scope, still enough to satisfy the envelope requirement) is
 * still sent, matching the fail-open contract of every other override consumer.
 */
async function resolveSubmitContext(
  session: GridSession | null,
  projectId: string | undefined
): Promise<JobSubmitContext> {
  const input: JobSubmitContext = {}

  if (session?.organizationId) {
    try {
      const overrides = await getEffectiveModelOverrides(session.organizationId)
      if (overrides) {
        input.modelOverrides = overrides
      }
    } catch (error) {
      console.warn('[Deep Research API] Failed to load model overrides:', error)
    }
    // The organization's standing instruction block (migration 0087) — the
    // same text a chat turn carries, because a deep-research run is a turn the
    // same office asked for. `resolveOrgInstructions` already fails soft to
    // null, so a lookup failure costs the run its preferences and not the run.
    const orgInstructions = await resolveOrgInstructions(session.organizationId)
    if (orgInstructions) {
      input.orgInstructions = orgInstructions
    }
  }

  if (projectId) {
    // Structured jurisdiction fact (backlog T3-9 follow-up, 2026-07-16,
    // user-mandated) — rides the envelope's `federalState` field. Best-effort:
    // a lookup failure must not block job submission; the backend falls back
    // to prompt-text parsing of `project_context` (unaffected either way).
    try {
      const federalState = await loadProjectFederalState(projectId, session?.organizationId)
      if (federalState) {
        input.federalState = federalState
      }
    } catch (error) {
      console.warn('[Deep Research API] Failed to load federal-state fact:', error)
    }
  }

  return input
}

/**
 * The run listing's query, with the project filter taken from the scope this
 * tier authorized rather than from the client.
 *
 * The client names a project by `projectId`, which `buildCollectionScopeFromRequest`
 * checked; the backend filters by collection. Translating here means the
 * collection the backend narrows to is the one the envelope signs, and a
 * `project_collection` the client sent is never forwarded: it named a project
 * nobody checked.
 */
function listingSearchParams(
  searchParams: URLSearchParams,
  scope: AuthorizedJobScope
): URLSearchParams {
  const params = new URLSearchParams(searchParams)
  params.delete('project_collection')
  const requestedProject = params.get('projectId')
  params.delete('projectId')
  params.delete('conversationId')
  const signedProject = scope.scopedCollections.find((entry) => entry.shelf === 'project')
  if (requestedProject && scope.projectId === requestedProject && signedProject) {
    params.set('project_collection', signedProject.collection)
  }
  return params
}

const LOG_LABEL = 'Deep Research API'

/**
 * Per-request proxy tracing. Dev-only: these fire on every deep-research
 * request (including each SSE reconnect), so at production volume they are
 * pure noise in the service log while telling an operator nothing an error
 * path does not already report.
 */
const traceRequest = (...args: unknown[]): void => {
  if (process.env.NODE_ENV !== 'development') return
  console.debug(`[${LOG_LABEL}]`, ...args)
}
const JOBS_BASE_PATH = '/v1/jobs/async'

/** The run id when this GET reads a run's report (`job/{id}/report`), else `null`. */
function reportRunId(path: string[]): string | null {
  return path.length === 3 && path[0] === 'job' && path[2] === 'report' ? path[1] : null
}

/**
 * Handle GET requests (status, stream, state, report)
 */
/**
 * One log line for a backend refusal, at the severity it has.
 *
 * A cancel that lands after the job finished (`400 Job not cancellable: <id>
 * (status: success|failure)`) is the backend's verdict, not a failure: the
 * Sessions panel's stop is confirmed in a dialog, the run can end while it is
 * open, and the panel re-reads the list either way. The warn guard for #632
 * went onto GET and DELETE while the live cancel is a POST
 * (`cancelJob` → `/job/{id}/cancel`), so it never ran; one helper for every
 * method is what keeps that from happening twice.
 */
function logBackendError(method: 'GET' | 'POST' | 'DELETE', status: number, errorText: string): void {
  if (status === 400 && errorText.includes('Job not cancellable')) {
    console.warn(`[Deep Research API] ${method} cancel race: job already terminal:`, errorText.slice(0, 200))
    return
  }
  console.error(`[Deep Research API] ${method} backend error:`, status, errorText)
}

export const GET = tenantSlotRoute(async function GET(
  req: Request,
  { params }: { params: Promise<{ path: string[] }> }
): Promise<Response> {
  try {
    const { path } = await params
    const isStreamRequest = path.includes('stream')
    const { searchParams } = new URL(req.url)

    // SSE reconnection: the browser's EventSource automatically sends a
    // `Last-Event-ID` header when it reconnects after a dropped connection.
    // Map it onto the backend's /stream/{last_event_id} resume endpoint so
    // reconnects resume after the last delivered event instead of replaying
    // the whole job (duplicated steps/tool calls, double-counted tokens).
    // Backend event ids are integers — anything else is ignored so a bogus
    // header can never break the stream.
    const lastEventId = req.headers.get('Last-Event-ID')?.trim()
    const upstreamPath =
      isStreamRequest &&
      path[path.length - 1] === 'stream' &&
      lastEventId &&
      /^\d+$/.test(lastEventId)
        ? [...path, lastEventId]
        : path
    const backendUrl = buildProxyUrl(JOBS_BASE_PATH, upstreamPath)

    traceRequest('GET:', backendUrl, isStreamRequest ? '(SSE)' : '')

    const { session, authHeader } = await resolveSessionAndBearer(req, path, LOG_LABEL)
    const authHeaders = buildAuthHeaders(authHeader)
    traceRequest('WorkOS access token present:', !!authHeaders.Authorization)

    // The reader's scope goes to the backend, signed, because the backend
    // authorizes the job by it. It is never handed to `fileCommissionedReport`:
    // a report's destination comes from the run, not from whoever reads it.
    const scope = await buildCollectionScopeFromRequest(session, parseQueryContext(searchParams))
    const gridContextHeaders = await resolveGridContextHeaders(session, scope, { submit: false })

    // The token query param is consumed for auth and forwarded via headers.
    const upstreamParams =
      path.length === 1 && path[0] === 'jobs' ? listingSearchParams(searchParams, scope) : searchParams
    const upstreamUrl = buildProxyUrl(JOBS_BASE_PATH, upstreamPath, upstreamParams, ['token'])

    // Forward the request to the backend. The scope header is set LAST, from
    // the same value the envelope encodes, as on the POST below.
    const response = await fetch(upstreamUrl, {
      method: 'GET',
      headers: {
        ...authHeaders,
        ...gridContextHeaders,
        Accept: isStreamRequest ? 'text/event-stream' : 'application/json',
        'X-Grid-Collection-Scope': scope.headerValue,
      },
      ...(isStreamRequest ? { signal: req.signal } : {}),
    })

    // Handle error responses
    if (!response.ok) {
      const errorText = await response.text()
      logBackendError('GET', response.status, errorText)

      return backendErrorEnvelope(response.status, errorText)
    }

    // For SSE streams, pass through the response body
    if (isStreamRequest) {
      if (!response.body) {
        return noResponseBodyEnvelope('Backend returned no SSE stream body')
      }

      // Stream the SSE response back to the client.
      //
      // NOTE: the body is piped AFTER this handler returns, so it runs outside
      // the `runWithTenantSlot` scope this route opened. The pipeline only
      // forwards upstream bytes, so nothing there touches the database today —
      // but a database read added inside the stream would throw
      // `MissingTenantContextError` at an awkward moment. Read what you need
      // before returning, or open a fresh scope inside the stream.
      return sseStreamResponse(response.body, {
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no', // Disable nginx buffering
      })
    }

    // For regular JSON responses
    const data = await response.json()

    // This is where a run's completion is observed on the BFF: the client asks
    // for the finished report, and until now the answer was read once, rendered
    // into a chat message and thrown away with the run's file system.
    const runId = reportRunId(path)
    const filing = runId ? await fileCommissionedReport({ runId, session, body: data }) : null

    // Four shapes: `filed` when it landed, `filingQueued` when a job is
    // rendering it, `filingFailed` when a promise was made and broken, and the
    // untouched body when no promise was made at all (no project, no report, not
    // a report request). A client that has never heard of these keys keeps working.
    if (filing?.outcome === 'filed') return NextResponse.json({ ...data, filed: filing.filed })
    if (filing?.outcome === 'queued') return NextResponse.json({ ...data, filingQueued: true })
    if (filing?.outcome === 'failed' || filing?.outcome === 'refused') {
      return NextResponse.json({ ...data, filingFailed: true })
    }
    return NextResponse.json(data)
  } catch (error) {
    if (isAuthzRefusal(error)) {
      return handleAuthzError(error)
    }

    // #646: backend unreachable (EHOSTUNREACH, fetch failed) is a transient
    // transport miss, not an application bug. Warn with the host so operators
    // can see which tier dropped, without filing an ERROR per blip.
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('fetch failed') || message.includes('EHOSTUNREACH') || message.includes('ECONNREFUSED')) {
      console.warn('[Deep Research API] GET transport miss:', message.slice(0, 300))
    } else {
      console.error('[Deep Research API] GET error:', error)
    }

    return proxyErrorEnvelope(error)
  }
})

/**
 * The backend's `job/{id}/documents` control, however the browser spelled the
 * path: matched on the upstream URL after it is normalized, so an encoded
 * slash or a dot segment cannot reach it under another name. A trailing slash
 * too, which the backend would redirect onto the control.
 */
const RUN_DOCUMENTS_CONTROL = /\/job\/[^/]+\/documents\/?$/

function isRunDocumentsControl(backendUrl: string): boolean {
  return RUN_DOCUMENTS_CONTROL.test(new URL(backendUrl).pathname)
}

/**
 * Handle POST requests (submit, cancel, write-now)
 */
export const POST = tenantSlotRoute(async function POST(
  req: Request,
  { params }: { params: Promise<{ path: string[] }> }
): Promise<Response> {
  try {
    const { path } = await params
    const backendUrl = buildProxyUrl(JOBS_BASE_PATH, path)

    traceRequest('POST:', backendUrl)

    // Handing a run a document has one door, the run primitive (ADR-0055):
    // there the document is checked against the project's restricted folders,
    // because its name and title reach everyone who reads the run (ADR-0084).
    // Forwarded from here it would reach the backend with a signed project and
    // no such check. No client calls it here.
    if (isRunDocumentsControl(backendUrl)) {
      return errorEnvelope(
        404,
        'NOT_FOUND',
        'Documents are handed to a run through POST /api/projects/{projectId}/runs/{runId}/documents'
      )
    }

    // Get the request body (may be empty for cancel)
    let parsedBody: Record<string, unknown> | undefined
    let body: string | undefined
    try {
      parsedBody = await req.json()
      body = JSON.stringify(parsedBody)
    } catch {
      // No body or invalid JSON - that's okay for cancel
      parsedBody = undefined
      body = undefined
    }

    const { session, authHeader } = await resolveSessionAndBearer(req, path, LOG_LABEL)
    const authHeaders = buildAuthHeaders(authHeader)
    traceRequest('POST WorkOS access token present:', !!authHeaders.Authorization)

    // Deep research is flag-gated (expensive workflow). Only the submit
    // entry point is gated — cancel/stream on running jobs stay available.
    // Anonymous mode (REQUIRE_AUTH=false) has no session, and gets the fixed
    // answer an entitlement has there — the one the agent's per-turn read
    // (`isDeepResearchEnabledForOrg`) reaches too, so the two halves agree.
    if (path[0] === 'submit') {
      const gated = requireFeature(session ?? { featureFlags: null }, FEATURE_FLAGS.deepResearch)
      if (gated) return gated
    }

    // Body first, then the query: a submit names its project in the body, a
    // cancel (no body) in `?projectId=`.
    const scope = await buildCollectionScopeFromRequest(
      session,
      resolveRequestContext(new URL(req.url).searchParams, parsedBody)
    )
    // The shelf-bearing entries, not the bare names: the signed envelope is the
    // copy `scoping.py` trusts for an authenticated turn (ADR-0047).
    const gridContextHeaders = await resolveGridContextHeaders(session, scope, {
      submit: path[0] === 'submit',
    })

    // A closed project files nothing (ADR-0090): a research run's report would
    // land in it. The agent no longer offers research there; this is the door a
    // direct call comes through.
    if (path[0] === 'submit' && scope.projectId && isProjectClosed(await findProjectTenancy(scope.projectId))) {
      const closed = projectClosedError()
      return NextResponse.json(
        { error: { code: closed.code, message: closed.message, details: closed.details } },
        { status: closed.status }
      )
    }

    // Forward the request to the backend.
    //
    // `resolveGridContextHeaders` also emits `X-Grid-Collection-Scope` (it
    // encodes the same `scope` for the signed envelope), so it must NOT be
    // spread over the authoritative header the route computed. Set the scope
    // header from `buildCollectionScopeFromRequest`'s `headerValue` LAST so it
    // is the single source of truth — identical to the envelope's encoding in
    // production, and consistent with the GET/DELETE handlers.
    const response = await fetch(backendUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
        ...gridContextHeaders,
        'X-Grid-Collection-Scope': scope.headerValue,
      },
      ...(body ? { body } : {}),
    })

    // Handle error responses
    if (!response.ok) {
      const errorText = await response.text()
      logBackendError('POST', response.status, errorText)

      return backendErrorEnvelope(response.status, errorText)
    }

    // Return JSON response
    const data = await response.json()
    return NextResponse.json(data, { status: response.status })
  } catch (error) {
    if (isAuthzRefusal(error)) {
      return handleAuthzError(error)
    }

    console.error('[Deep Research API] POST error:', error)

    return proxyErrorEnvelope(error)
  }
})

/**
 * Handle DELETE requests (cancel)
 */
export const DELETE = tenantSlotRoute(async function DELETE(
  req: Request,
  { params }: { params: Promise<{ path: string[] }> }
): Promise<Response> {
  try {
    const { path } = await params
    const backendUrl = buildProxyUrl(JOBS_BASE_PATH, path)
    const { searchParams } = new URL(req.url)

    traceRequest('DELETE:', backendUrl)

    const { session, authHeader } = await resolveSessionAndBearer(req, path, LOG_LABEL)
    const authHeaders = buildAuthHeaders(authHeader)
    traceRequest('DELETE WorkOS access token present:', !!authHeaders.Authorization)

    const scope = await buildCollectionScopeFromRequest(session, parseQueryContext(searchParams))
    const gridContextHeaders = await resolveGridContextHeaders(session, scope, { submit: false })

    const upstreamUrl = buildProxyUrl(JOBS_BASE_PATH, path, searchParams, ['token'])

    const response = await fetch(upstreamUrl, {
      method: 'DELETE',
      headers: {
        ...authHeaders,
        ...gridContextHeaders,
        Accept: 'application/json',
        'X-Grid-Collection-Scope': scope.headerValue,
      },
    })

    if (!response.ok) {
      const errorText = await response.text()
      logBackendError('DELETE', response.status, errorText)

      return backendErrorEnvelope(response.status, errorText)
    }

    const data = await response.json().catch(() => ({}))
    return NextResponse.json(data, { status: response.status })
  } catch (error) {
    if (isAuthzRefusal(error)) {
      return handleAuthzError(error)
    }

    console.error('[Deep Research API] DELETE error:', error)

    return proxyErrorEnvelope(error)
  }
})
