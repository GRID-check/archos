/**
 * What a background run's request context says, beside who it acts as.
 *
 * Two producers sign it: `submitAgentRun` when the run is submitted, and
 * `renewRunEnvelope` (`lib/runs/run-envelope.ts`, ADR-0108) when the worker asks
 * for a fresh envelope past the renewal age. The worker injects whichever it
 * holds into the run, and the agent reads a signed envelope wholesale: its
 * `modelOverrides` is then the only source of the model selection, its `budget`
 * the only budget. A renewal that signed identity alone would therefore run the
 * rest of the job on the YAML models with no budget. One derivation, here, is
 * what keeps the two envelopes saying the same thing.
 */

import 'server-only'
import { getBudgetStatus } from '@/lib/budgets/service'
import { computeCollectionScope } from '@/lib/collection-scope'
import { getEffectiveModelOverrides } from '@/lib/model-config/service'
import { resolveOrgInstructions } from '@/lib/org-instructions/service'
import { loadProjectBundesland, loadProjectPromptView } from '@/lib/project-profile/prompt-view'
import { buildProjectMemoryDigest } from '@/lib/projects/memory-service'
import { findProjectInOrg } from '@/lib/projects/repository'
import type { GridBudgetSnapshot, GridRequestContextInput } from '@/lib/request-context'
import { isMemoryReflectionEnabled } from '@/lib/workos/feature-flags'

/** Who a run is for, and where. */
export interface RunSubject {
  organizationId: string
  projectId: string
  /** The requester. */
  userId: string
}

/**
 * The run's context as of now. Every lookup but the scope and the organization's
 * instructions is best-effort: a failed read must not stop a run, and absent
 * means what it means on a chat turn (the YAML models, no budget line, no block).
 *
 * `prompt` is what the project-memory digest is ranked against.
 */
export async function resolveRunContext({ organizationId, projectId, userId }: RunSubject, prompt: string) {
  const [
    budget,
    modelOverrides,
    collectionScope,
    projectContext,
    bundesland,
    projectMemory,
    memoryReflectionEnabled,
    orgInstructions,
  ] = await Promise.all([
    resolveBudgetSnapshot(organizationId, userId, projectId),
    getEffectiveModelOverrides(organizationId).catch(() => null),
    buildProjectCollectionScope(projectId, organizationId),
    loadProjectPromptView(projectId, organizationId).catch(() => null),
    loadProjectBundesland(projectId, organizationId).catch(() => null),
    buildProjectMemoryDigest(projectId, organizationId, { query: prompt }).catch(() => null),
    isMemoryReflectionEnabled(organizationId).catch(() => false),
    // The organization's standing instruction block. A scheduled or delegated
    // run is a turn like any other, so it carries the same preferences a chat
    // turn does — a task that answered in a voice the office had asked against
    // would be the whole point of the block, missed.
    resolveOrgInstructions(organizationId),
  ])
  return {
    budget,
    modelOverrides,
    collectionScope,
    projectContext,
    bundesland,
    projectMemory,
    memoryReflectionEnabled,
    orgInstructions,
  }
}

export type RunContext = Awaited<ReturnType<typeof resolveRunContext>>

/**
 * The input a run's envelope is signed from: the subject, the context, the
 * thread the run writes into, and when it was minted. Without `issuedAt` the
 * BFF refuses the envelope as an acting identity (ADR-0054 §4).
 */
export function runRequestContextInput(
  subject: RunSubject,
  context: RunContext,
  conversationId: string | null,
  issuedAt: number,
): GridRequestContextInput {
  return {
    organizationId: subject.organizationId,
    userId: subject.userId,
    projectId: subject.projectId,
    collectionScope: context.collectionScope,
    projectContext: context.projectContext,
    projectMemory: context.projectMemory,
    orgInstructions: context.orgInstructions,
    modelOverrides: context.modelOverrides,
    budget: context.budget,
    bundesland: context.bundesland,
    memoryReflectionEnabled: context.memoryReflectionEnabled,
    conversationId,
    issuedAt,
  }
}

/**
 * The raw remaining-budget snapshot — identical values to the interactive
 * path's `x-grid-budget` header. Best-effort: a lookup failure must not block
 * the run.
 */
async function resolveBudgetSnapshot(
  organizationId: string,
  userId: string,
  projectId: string,
): Promise<GridBudgetSnapshot | null> {
  try {
    const status = await getBudgetStatus(organizationId, userId, projectId)
    return {
      remainingOrgUsd: status.remainingOrgUsd,
      remainingUserUsd: status.remainingUserUsd,
      remainingProjectUsd: status.remainingProjectUsd,
      // An organization on its own key counts in tokens (ADR-0053). The agent
      // reads a signed envelope's budget wholesale, so a run whose envelope
      // left these out would run with no token limit at all.
      remainingOrgTokens: status.remainingOrgTokens,
      remainingUserTokens: status.remainingUserTokens,
      remainingProjectTokens: status.remainingProjectTokens,
    }
  } catch {
    return null
  }
}

/**
 * The ordered collection scope for the project — exactly what
 * buildCollectionScopeFromRequest produces for a project. Resolved from the
 * project row (session-less path); falls back to the id-derived name if the
 * row is gone.
 */
async function buildProjectCollectionScope(
  projectId: string,
  organizationId: string,
): Promise<string[] | null> {
  const project = await findProjectInOrg(projectId, organizationId)
  const scope = computeCollectionScope(null, {
    projectId,
    projectCollectionName: project?.collectionName,
    includeProject: true,
  })
  return scope.length > 0 ? scope : null
}

/**
 * A run's envelope is echoed on every call its tools make to the BFF (ADR-0108),
 * and Node refuses a request whose headers pass 16 KB. The blocks it carries
 * are bounded (memory digest, organization instructions) except the project's
 * prompt view, so this measures instead of guessing: past this size it warns,
 * with the run, before any request is refused.
 */
export const RUN_ENVELOPE_WARN_BYTES = 12 * 1024

/**
 * Warn when a run's context headers near the header budget. Takes the whole
 * header set (or the envelope alone): their total is what Node counts. Never
 * throws.
 */
export function warnIfRunEnvelopeLarge(headers: Record<string, string> | string | undefined, runId: string): void {
  if (!headers) return
  const bytes =
    typeof headers === 'string'
      ? headers.length
      : Object.entries(headers).reduce((sum, [name, value]) => sum + name.length + String(value ?? '').length, 0)
  if (bytes > RUN_ENVELOPE_WARN_BYTES) {
    console.warn(
      `[runs] run ${runId}: its request context headers are ${bytes} bytes; ` +
        `past ${RUN_ENVELOPE_WARN_BYTES} they near the 16 KB header limit its tools' calls must stay under`
    )
  }
}
