// @ts-check
/**
 * The headers a chat turn's socket upgrade carries to the backend, from the
 * turn context the BFF resolved (`resolveTurnContext`, `./turn-context.ts`).
 *
 * Two callers, one copy. `server.js` proxies a browser's upgrade and sets these
 * on the forwarded request; the wake job (`lib/annotations/wake-job.ts`) opens
 * the socket itself, as the person whose act woke Piloti (ADR-0106). Both
 * build the headers here, from the same data, so a field one of them forgets
 * cannot exist: before this, the mapping lived inline in `server.js` and the
 * wake would have been its second copy.
 *
 * The envelope builder below DUPLICATES `buildRequestContextEnvelopePayload`
 * in `request-context.ts`, which stays the one canonical definition: this file
 * is plain CommonJS because `server.js` requires it at startup with no build
 * step, and cannot import a TS module. `request-context.spec.ts` pins the two:
 * the field names and their order (the signature is over the bytes), and the
 * signed bytes for every fixture case. The production image copies this file
 * in by path (`deploy/Dockerfile`).
 */

// `require`, not `import`: `server.js` loads this file as CommonJS at startup.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const crypto = require('crypto')

/**
 * The turn context as `GET /api/auth/websocket-scope` answers it. Every field
 * is the BFF's own, derived from the authenticated session; none is the
 * client's.
 *
 * @typedef {object} TurnContextData
 * @property {string | null | undefined} [header] base64url of the collection scope
 * @property {ReadonlyArray<string> | undefined} [scope]
 * @property {ReadonlyArray<unknown> | undefined} [scopedCollections]
 * @property {string | null | undefined} [organizationId]
 * @property {string | null | undefined} [userId]
 * @property {string | null | undefined} [accessToken]
 * @property {string | undefined} [projectId]
 * @property {string | undefined} [conversationId] the conversation the BFF AUTHORIZED, never a query param
 * @property {string | null | undefined} [projectContext]
 * @property {string | null | undefined} [projectMemory]
 * @property {string | null | undefined} [orgInstructions]
 * @property {boolean | undefined} [memoryReflectionEnabled]
 * @property {object | null | undefined} [modelOverrides]
 * @property {object | null | undefined} [budget]
 * @property {ReadonlyArray<string> | undefined} [disabledSources]
 * @property {string | null | undefined} [federalState]
 * @property {Requester | null | undefined} [requester] who `userId` is, by name (envelope-only)
 */

/**
 * `RequestPerson` in `request-context.ts`.
 *
 * @typedef {object} Requester
 * @property {string | null | undefined} [name]
 * @property {string | null | undefined} [email]
 * @property {string | null | undefined} [organizationName]
 */

/**
 * `requesterOf` in `request-context.ts`: trimmed, empty as null, null when it names nobody.
 *
 * @param {Requester | null | undefined} value
 */
function requesterOf(value) {
  const requester = {
    name: value?.name?.trim() || null,
    email: value?.email?.trim() || null,
    organizationName: value?.organizationName?.trim() || null,
  }
  return requester.name || requester.email || requester.organizationName ? requester : null
}

/**
 * `RequestContextInput` in `request-context.ts`, as far as the envelope reads it.
 *
 * @typedef {object} EnvelopeInput
 * @property {string | null} [organizationId]
 * @property {string | null} [userId]
 * @property {string | null} [projectId]
 * @property {ReadonlyArray<unknown> | null} [collectionScope]
 * @property {string | null} [projectContext]
 * @property {string | null} [projectMemory]
 * @property {string | null} [orgInstructions]
 * @property {object | null} [modelOverrides]
 * @property {object | null} [budget]
 * @property {ReadonlyArray<string> | null} [disabledSources]
 * @property {boolean} [memoryReflectionEnabled]
 * @property {string | null} [federalState]
 * @property {string | null} [conversationId]
 * @property {number | null} [issuedAt]
 * @property {'bff'} [contextTransport]
 * @property {Requester | null} [requester]
 */

/**
 * The signed `X-Request-Context` envelope (and its signature when
 * `secret` is set). Field list, omission rules and key order are those of
 * `buildRequestContextEnvelopePayload` in `request-context.ts`: every
 * field added since `memoryReflectionEnabled` was appended LAST so earlier
 * signed payloads stay byte-identical. `conversationId` and `issuedAt` make it
 * a credential (ADR-0054): which conversation asked, and when it was minted.
 *
 * Fail-open note (dev): with no secret the envelope is still minted and
 * forwarded, unsigned; the backend skips the signature check only when it has
 * no token configured either.
 *
 * @param {EnvelopeInput} input
 * @param {string | null | undefined} secret
 * @returns {Record<string, string>}
 */
function buildRequestContextEnvelopeHeaders(input, secret) {
  /** @type {Record<string, unknown>} */
  const payload = {}
  if (input.organizationId) payload.organizationId = input.organizationId
  if (input.userId) payload.userId = input.userId
  if (input.projectId) payload.projectId = input.projectId
  if (input.collectionScope && input.collectionScope.length > 0) payload.collectionScope = input.collectionScope
  if (input.contextTransport !== 'bff' && input.projectContext) payload.projectContext = input.projectContext
  if (input.contextTransport !== 'bff' && input.projectMemory) payload.projectMemory = input.projectMemory
  if (input.modelOverrides && Object.keys(input.modelOverrides).length > 0) {
    payload.modelOverrides = input.modelOverrides
  }
  if (input.budget) payload.budget = input.budget
  if (input.disabledSources && input.disabledSources.length > 0) payload.disabledSources = input.disabledSources
  if (input.memoryReflectionEnabled !== undefined) payload.memoryReflectionEnabled = input.memoryReflectionEnabled
  if (input.federalState) payload.federalState = input.federalState
  if (input.conversationId) payload.conversationId = input.conversationId
  if (input.issuedAt !== undefined && input.issuedAt !== null) payload.issuedAt = input.issuedAt
  if (input.contextTransport !== 'bff' && input.orgInstructions) payload.orgInstructions = input.orgInstructions
  if (input.contextTransport) payload.contextTransport = input.contextTransport
  const requester = requesterOf(input.requester)
  if (requester) payload.requester = requester

  const json = JSON.stringify(payload)
  /** @type {Record<string, string>} */
  const headers = {
    'x-request-context': Buffer.from(json, 'utf8').toString('base64url'),
  }
  if (secret) {
    headers['x-request-context-sig'] = crypto.createHmac('sha256', secret).update(json, 'utf8').digest('hex')
  }
  return headers
}

/** @param {unknown} value */
const base64urlJson = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')

/**
 * Every header the upgrade carries for one turn context: the individual
 * `x-grid-*` headers (the DUAL-WRITE the backend still reads beside the
 * envelope) and the signed envelope, built from the SAME values.
 *
 * An authenticated context (organization and user) sends its prompt blocks by
 * the per-turn `POST /api/internal/turn-context` instead (`contextTransport:
 * 'bff'`), because base64 alone can push them past the upstream header-line
 * limit; an anonymous one keeps them inline.
 *
 * @param {TurnContextData} data
 * @param {{ issuedAt: number, secret: string | null | undefined }} options
 *   `issuedAt` is minted by the caller: the envelope's age is the age of THIS
 *   handshake, and a builder that stamped its own clock would refresh a payload
 *   a caller handed it.
 * @returns {Record<string, string>}
 */
function turnContextHeaders(data, { issuedAt, secret }) {
  /** @type {Record<string, string>} */
  const headers = {}
  if (data.header) headers['x-collection-scope'] = data.header
  const authenticated = Boolean(data.organizationId && data.userId)
  // Who the caller is, so the backend knows without a token lookup.
  if (data.organizationId) {
    headers['x-organization-id'] = data.organizationId
    if (data.userId) headers['x-user-id'] = data.userId
  }
  if (data.accessToken) headers.authorization = `Bearer ${data.accessToken}`
  if (!authenticated) {
    for (const [field, header] of /** @type {const} */ ([
      ['projectContext', 'x-project-context'],
      ['projectMemory', 'x-project-memory'],
      ['orgInstructions', 'x-org-instructions'],
    ])) {
      const value = data[field]
      if (value) headers[header] = Buffer.from(value, 'utf8').toString('base64url')
    }
  }
  if (data.projectId) headers['x-project-id'] = data.projectId
  // Always sent, so the backend fails closed when it is absent.
  headers['x-feature-memory-reflection'] = data.memoryReflectionEnabled ? 'true' : 'false'
  // Per-org model overrides and the remaining budget, JSON then base64url;
  // decoded in agent (model_overrides.py, cost_tracking.py). Absent is the
  // workflow defaults and no cap.
  if (data.modelOverrides) headers['x-model-overrides'] = base64urlJson(data.modelOverrides)
  if (data.budget) headers['x-budget'] = base64urlJson(data.budget)
  // Sources the organization switched off (web search, ADR-0022).
  if (Array.isArray(data.disabledSources) && data.disabledSources.length > 0) {
    headers['x-disabled-sources'] = base64urlJson(data.disabledSources)
  }
  Object.assign(
    headers,
    buildRequestContextEnvelopeHeaders(
      {
        organizationId: data.organizationId,
        userId: data.userId,
        projectId: data.projectId,
        // Shelf-bearing entries when the resolver supplied them, bare names
        // otherwise: the envelope is the copy `scoping.py` trusts (ADR-0047).
        collectionScope: data.scopedCollections ?? data.scope,
        projectContext: data.projectContext,
        projectMemory: data.projectMemory,
        orgInstructions: data.orgInstructions,
        modelOverrides: data.modelOverrides,
        budget: data.budget,
        disabledSources: data.disabledSources,
        memoryReflectionEnabled: data.memoryReflectionEnabled,
        federalState: data.federalState,
        // The conversation the BFF authorized, not the raw query param: a
        // caller-chosen value must never sit inside a signature a write route
        // trusts.
        conversationId: data.conversationId,
        issuedAt,
        contextTransport: authenticated ? 'bff' : undefined,
        requester: data.requester,
      },
      secret,
    ),
  )
  return headers
}

module.exports = { buildRequestContextEnvelopeHeaders, turnContextHeaders }
