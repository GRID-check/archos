/**
 * What a chat turn's socket carries, resolved from a session: the collection
 * scope, who asks, the conversation the BFF authorized, the budget left, the
 * model overrides, the organization's switches (ADR-0020, ADR-0047, ADR-0054).
 *
 * Two callers, one resolution. `GET /api/auth/websocket-scope` answers it for
 * `server.js`, which proxies a browser's upgrade with the cookie session; the
 * wake job (`lib/annotations/wake-job.ts`, ADR-0106) resolves it for the
 * pinned session of the person whose act woke Piloti, and opens the socket
 * itself. Both turn it into headers with `turnContextHeaders`
 * (`./turn-headers.js`), so there is one mapping and no third copy.
 *
 * Not to be confused with `lib/turn-context/`, the per-turn PROMPT blocks the
 * agent fetches by `POST /api/internal/turn-context` once the socket is open:
 * the handshake carries only identity, scope and policy, because base64 alone
 * can push prompt blocks past the upstream header-line limit. Anonymous
 * contexts keep their prompt blocks inline here.
 *
 * Every project-scoped lookup uses the EFFECTIVE project (the authorized
 * scope's project, falling back to the requested one), never the raw request,
 * so an implicit project from the stored active-project preference is not
 * silently dropped from the budget, the prompt, the Bundesland or memory.
 */

import 'server-only'
import type { GridSession } from '@/lib/auth/types'
import { buildCollectionScopeFromRequest } from '@/lib/retrieval-scope/collection-scope-request'
import { loadProjectFederalState, loadProjectPromptView } from '@/lib/project-profile/prompt-view'
import { buildProjectMemoryDigest } from '@/lib/projects/memory-service'
import { resolveOrgInstructions } from '@/lib/org-instructions/service'
import { isMemoryReflectionEnabled } from '@/lib/workos/feature-flags'
import { isWebSearchEnabledForOrg } from '@/lib/organizations/service'
import { getEffectiveModelOverrides } from '@/lib/model-config/service'
import { getBudgetStatus } from '@/lib/budgets/service'
import { announceBudgetBlocked } from '@/lib/budgets/budget-events'
import type { ScopedCollection } from '@/lib/retrieval-scope/collection-scope'
import { requesterOf, type GridRequester } from '@/lib/request-context'

/** Run a best-effort lookup: its failure is logged and read as "absent". */
async function bestEffort<T>(what: string, load: () => Promise<T>): Promise<T | null> {
  try {
    return await load()
  } catch (error) {
    console.warn(`[Turn Context] Failed to ${what}:`, error)
    return null
  }
}

/** The remaining budget a turn carries, so the backend tracker can stop a runaway turn mid-flight. */
export interface TurnBudget {
  remainingOrgUsd: number | null
  remainingUserUsd: number | null
  remainingProjectUsd: number | null
  remainingOrgTokens: number | null
  remainingUserTokens: number | null
  remainingProjectTokens: number | null
}

/**
 * The turn context, in the shape `GET /api/auth/websocket-scope` answers and
 * `turnContextHeaders` reads (`TurnContextData` there).
 */
export interface TurnContext {
  /** The bare collection names existing clients read (ADR-0047). */
  scope: string[]
  /** The shelf-bearing entries `server.js` signs into the envelope. */
  scopedCollections: ScopedCollection[]
  /** base64url of the scope: the `x-grid-collection-scope` header. */
  header: string
  /** The conversation `authorizeConversationScope` ran on: what may be signed. */
  conversationId?: string
  organizationId?: string | null
  userId?: string | null
  accessToken?: string | null
  /** The EFFECTIVE project every lookup was scoped to. */
  projectId?: string
  federalState?: string
  memoryReflectionEnabled: boolean
  disabledSources?: string[]
  modelOverrides?: Record<string, string>
  budget?: TurnBudget
  /** Anonymous contexts only: the prompt blocks inline. */
  projectContext?: string
  projectMemory?: string
  orgInstructions?: string
  /** Who `userId` is, by name: signed into the envelope (`requesterOf`). */
  requester?: GridRequester
}

/** The person's (or the organization's, or the project's) LLM budget is spent: no turn starts. */
export class TurnBudgetExhaustedError extends Error {
  constructor(readonly blockedScope: string | null) {
    super(
      `The ${blockedScope} LLM budget is exhausted. An org admin can raise limits under Organization → Usage & budgets.`
    )
    this.name = 'TurnBudgetExhaustedError'
  }
}

/**
 * Resolve the context of a turn this session may run in `request.projectId` /
 * `request.conversationId`. Throws what the scope's authorization throws (a
 * project or conversation this session may not reach) and
 * {@link TurnBudgetExhaustedError} when a budget scope is spent.
 *
 * `session` is null only where nobody authenticates (local dev).
 */
export async function resolveTurnContext(
  session: GridSession | null,
  request: { projectId?: string; conversationId?: string }
): Promise<TurnContext> {
  const { projectId, conversationId } = request
  const {
    scope,
    scopedCollections,
    headerValue,
    projectId: authorizedProjectId,
  } = await buildCollectionScopeFromRequest(session, {
    projectId,
    conversationId,
    // An interactive chat turn: the one scope that may carry the
    // restricted-folder collections this session, and everyone the
    // conversation is shared with, is cleared for (ADR-0087). A turn draws on
    // one only through an admission that checks the conversation's audience.
    interactiveChat: true,
  })

  // Keys in the order the route has always answered them.
  const context: Omit<TurnContext, 'memoryReflectionEnabled'> & { memoryReflectionEnabled?: boolean } = {
    scope,
    scopedCollections,
    header: headerValue,
  }
  // Echoed so the envelope signs the conversation this tier was ALLOWED to
  // sign: `buildCollectionScopeFromRequest` has just run
  // `authorizeConversationScope` on it, and throws when that fails.
  if (conversationId) context.conversationId = conversationId
  if (session) {
    context.organizationId = session.organizationId
    context.userId = session.userId
    context.accessToken = session.accessToken
    const requester = requesterOf(session)
    if (requester) context.requester = requester
  }

  const organizationId = session?.organizationId
  const effectiveProjectId = authorizedProjectId ?? projectId

  // The async memory-reflection stage, per organization; forwarded as
  // x-grid-feature-memory-reflection.
  const memoryReflectionEnabled = await isMemoryReflectionEnabled(organizationId)
  // Budget enforcement (ADR-0015): no turn when a budget scope is already
  // exhausted, otherwise the remaining budget rides along. Fails OPEN on read
  // errors: a broken budget lookup must not take chat down.
  const budgetStatus =
    organizationId && session
      ? await bestEffort('compute budget status', () =>
          getBudgetStatus(organizationId, session.userId, effectiveProjectId ?? null)
        )
      : null

  if (budgetStatus?.blocked) {
    // `budget_blocked` for PostHog (ADR-0100), once per person and scope per
    // hour. Not awaited: the refusal answers exactly as fast as before.
    if (organizationId && session && budgetStatus.blockedScope) {
      void announceBudgetBlocked({
        organizationId,
        userId: session.userId,
        scope: budgetStatus.blockedScope,
        unit: budgetStatus.unit,
      })
    }
    throw new TurnBudgetExhaustedError(budgetStatus.blockedScope ?? null)
  }

  // Org-level web-search setting (ADR-0022): off is enforcement, not hiding.
  // Best-effort: a lookup failure leaves web search on.
  const webSearchEnabled = organizationId
    ? await bestEffort('resolve web-search setting', () => isWebSearchEnabledForOrg(organizationId))
    : null
  // The platform defaults with the org's active model config on top.
  // Best-effort: the workflow YAML models apply instead.
  const modelOverrides = organizationId
    ? await bestEffort('load model overrides', () => getEffectiveModelOverrides(organizationId))
    : null
  const federalState = effectiveProjectId
    ? await bestEffort('load federal-state fact', () => loadProjectFederalState(effectiveProjectId, organizationId))
    : null

  if (!organizationId || !session?.userId) {
    const [projectContext, projectMemory, orgInstructions] = await Promise.all([
      effectiveProjectId ? loadProjectPromptView(effectiveProjectId, organizationId) : Promise.resolve(null),
      // Open memory only (ADR-0087): restricted notes are admitted per turn
      // against the conversation's audience, never here.
      bestEffort('build project memory digest', () =>
        buildProjectMemoryDigest(effectiveProjectId, organizationId ?? undefined)
      ),
      organizationId ? resolveOrgInstructions(organizationId) : Promise.resolve(null),
    ])
    if (projectContext) context.projectContext = projectContext
    if (projectMemory) context.projectMemory = projectMemory
    if (orgInstructions) context.orgInstructions = orgInstructions
  }

  context.memoryReflectionEnabled = memoryReflectionEnabled
  if (organizationId) {
    if (webSearchEnabled === false) context.disabledSources = ['web_search']
    if (modelOverrides) context.modelOverrides = modelOverrides
    if (budgetStatus) {
      context.budget = {
        remainingOrgUsd: budgetStatus.remainingOrgUsd,
        remainingUserUsd: budgetStatus.remainingUserUsd,
        remainingProjectUsd: budgetStatus.remainingProjectUsd,
        remainingOrgTokens: budgetStatus.remainingOrgTokens,
        remainingUserTokens: budgetStatus.remainingUserTokens,
        remainingProjectTokens: budgetStatus.remainingProjectTokens,
      }
    }
  }

  // The EFFECTIVE project: with an implicit project the request names none,
  // but the lookups above were project-scoped.
  if (effectiveProjectId) {
    context.projectId = effectiveProjectId
    if (federalState) context.federalState = federalState
  }
  return { ...context, memoryReflectionEnabled }
}
