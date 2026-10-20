import { findProjectProfile, findProjectPromptView } from '@/lib/projects/repository'
import { loadDocumentRolesPromptSection } from '@/lib/document-roles/prompt-loader'
import { loadUnreadableDocumentsSection } from './unreadable-section'
import { getCached, invalidateCached } from '@/lib/cache'
import { buildProjectBriefView } from './brief-view'
import { normalizeLegacyPromptView } from './legacy-names'
import { isValidFederalStateToken } from './intake-definition'
import { ProjectProfileSchema } from './types'
import type {
  ProjectAssumption,
  ProjectFact,
  ProjectPrimitiveValue,
  ProjectProfile,
  ProjectProfileDisplay,
} from './types'

// Re-exported so existing server-side importers (profile / patches routes, tests)
// keep a single import surface; the engine itself now lives in the isomorphic
// patch-engine module so the intake wizard can share it.
export { applyProjectProfilePatch, emptyProjectProfile } from './patch-engine'

const PROMPT_VIEW_CACHE_TTL_MS = 5 * 60 * 1000

/** Key segment for a request that legitimately has no organization. */
const ANONYMOUS_TENANT = 'anon'

/**
 * Cache keys derived from the stored profile (`projects.profile`). BOTH are
 * served with the same 5-min TTL and MUST be invalidated together on every
 * profile write — see {@link invalidateProjectProfileCaches}.
 *
 * The organization is part of the key, and that is a tenancy boundary rather
 * than a nicety. `getCached` returns BEFORE the loader runs, so a key of
 * `projectId` alone meant a hit served whatever the first caller had populated
 * — without ever entering the tenant scope or consulting row-level security.
 * The project id is supplied by the caller on the websocket-scope path, so an
 * id belonging to another organization would have returned that organization's
 * project context straight out of the cache. Partitioning by tenant is what
 * makes the cached path obey the same boundary as the query behind it.
 */
// `-v2` and `federal-state:` are new prefixes on purpose: a cache is shared by the
// pods of a rolling deploy, and an older pod fills the old keys with the German
// names. A new pod never reads those.
const promptViewCacheKey = (projectId: string, organizationId: string | null | undefined) =>
  `promptview-v2:${organizationId ?? ANONYMOUS_TENANT}:${projectId}`
const federalStateCacheKey = (projectId: string, organizationId: string | null | undefined) =>
  `federal-state:${organizationId ?? ANONYMOUS_TENANT}:${projectId}`

/**
 * Cached read of the project-context prompt view injected into the agent on
 * every WS upgrade. Backed by the shared cache (ADR-0020), so a profile edit
 * on one replica invalidates for all replicas — the per-process Map this
 * replaces served stale project context for up to 5 minutes after an edit.
 *
 * The view is one per project, read by every member and by scheduled and
 * deep-research runs, and it names no document in a restricted folder, for
 * anyone (ADR-0087): listing is not use, and a chat finds a restricted
 * document by searching for it.
 */
export async function loadProjectPromptView(
  projectId: string | undefined,
  organizationId: string | null | undefined
): Promise<string | null> {
  if (!projectId) return null

  const build = async (): Promise<string | null> => {
    const [stored, documents] = await Promise.all([
      findProjectPromptView(projectId, organizationId),
      // Appended here rather than baked into the stored view, because a role
      // binding changes without the profile changing. `buildProjectPromptView`
      // runs at profile-save; a document declared afterwards would never reach
      // a view built there. Declaring or revoking a role invalidates this cache
      // (`lib/document-roles/service`), so the block cannot go stale either.
      loadDocumentRolesPromptSection(projectId, organizationId),
    ])
    // A view an older pod stored after the rename still names the German keys
    // and tokens; the agent reads them in English only.
    const combined = [stored ? normalizeLegacyPromptView(stored).trim() : null, documents]
      .filter(Boolean)
      .join('\n\n')
      .trim()
    return combined || null
  }

  // The unreadable files ride beside the cached view, not inside it: a re-read
  // changes them without touching anything that invalidates the cache, and
  // the next turn must not be told about a failure „Alle erneut lesen" fixed.
  const [view, unreadable] = await Promise.all([
    getCached(promptViewCacheKey(projectId, organizationId), PROMPT_VIEW_CACHE_TTL_MS, build),
    loadUnreadableDocumentsSection(projectId, organizationId),
  ])
  return [view, unreadable].filter(Boolean).join('\n\n') || null
}

export async function invalidateProjectPromptViewCache(
  projectId: string,
  organizationId: string | null | undefined
): Promise<void> {
  await Promise.all(
    tenantVariants(promptViewCacheKey, projectId, organizationId).map((key) =>
      invalidateCached(key)
    )
  )
}

/**
 * Every tenant-partitioned key a project's cached value can live under.
 *
 * A write must drop the anonymous variant as well as its own: an anonymous
 * deployment populates `anon` while an authenticated write knows an
 * organization, and dropping only one leaves the other serving the value the
 * write just replaced.
 */
function tenantVariants(
  key: (projectId: string, organizationId: string | null | undefined) => string,
  projectId: string,
  organizationId: string | null | undefined
): string[] {
  const keys = new Set([key(projectId, organizationId), key(projectId, null)])
  return [...keys]
}

/**
 * Invalidate EVERY per-project cache derived from the stored profile. Both the
 * prompt-view text (`promptview:`) and the structured `federal_state` fact
 * (`federal_state:`) are read from `projects.profile` with a 5-min TTL, so a
 * profile write must drop BOTH keys — otherwise a wizard save that changes the
 * location leaves the jurisdiction-dependent `federal_state` on the WS handshake
 * (RIS logic) stale for up to 5 minutes. This is the single invalidation every
 * profile write path (`saveProjectProfile`, `patchProjectProfile`) must call.
 */
export async function invalidateProjectProfileCaches(
  projectId: string,
  organizationId: string | null | undefined
): Promise<void> {
  await Promise.all(
    [
      ...tenantVariants(promptViewCacheKey, projectId, organizationId),
      ...tenantVariants(federalStateCacheKey, projectId, organizationId),
    ].map((key) => invalidateCached(key))
  )
}

/**
 * Cached read of the project's validated `federal_state` fact, straight off the
 * stored structured profile (`projects.profile.facts.federal_state.value`) —
 * the SAME source `buildProjectPromptView` reads to emit the
 * `federal_state=<token>` text line `loadProjectPromptView` above serves.
 *
 * Backlog T3-9 follow-up (2026-07-16, user-mandated): jurisdiction is a
 * cross-cutting request fact and must travel STRUCTURED on the
 * `X-Grid-Request-Context` envelope, not be re-parsed out of that prompt
 * text — this is the read producers resolve `GridRequestContextInput.federal_state`
 * from. Returns `null` for no project, no fact, or a value outside the
 * validated intake vocabulary (a stale/corrupt row must never leak an
 * unvalidated token onto the wire).
 */
export async function loadProjectFederalState(
  projectId: string | undefined,
  organizationId: string | null | undefined
): Promise<string | null> {
  if (!projectId) return null

  return getCached(
    federalStateCacheKey(projectId, organizationId),
    PROMPT_VIEW_CACHE_TTL_MS,
    async () => {
      const profile = await findProjectProfile(projectId, organizationId)
      const value = profile?.facts?.federal_state?.value
      return typeof value === 'string' && isValidFederalStateToken(value) ? value : null
    }
  )
}

export function buildProjectPromptView(profile: ProjectProfile): string {
  const normalized = ProjectProfileSchema.parse(profile)
  const sections: string[][] = [['PROJECT_CONTEXT v1']]

  const factKeys = Object.keys(normalized.facts).sort()

  // Legacy profile: no country fact but valid AT federal_state → derive country=at
  const countryInFacts = normalized.facts.country
  if (!countryInFacts && normalized.facts.federal_state?.value) {
    const bv = normalized.facts.federal_state.value
    if (typeof bv === 'string' && bv !== 'outside_austria' && isValidFederalStateToken(bv)) {
      factKeys.unshift('country')
      normalized.facts.country = {
        value: 'at',
        confidence: 'confirmed',
        source: 'onboarding',
        updatedAt: '',
      }
    }
  }

  if (factKeys.length > 0) {
    sections.push([
      'confirmed:',
      ...factKeys.map(
        (key) => `- ${formatPromptToken(key)}=${formatPromptValue(normalized.facts[key].value)}`
      ),
    ])
  }

  const goalKeys = Object.keys(normalized.goals).sort()
  if (goalKeys.length > 0) {
    sections.push([
      'goals:',
      ...goalKeys.map(
        (key) => `- ${formatPromptToken(key)}=${formatPromptValue(normalized.goals[key])}`
      ),
    ])
  }

  const unknowns = [...normalized.unknowns].sort()
  if (unknowns.length > 0) {
    sections.push(['unknown:', ...unknowns.map((unknown) => `- ${formatPromptToken(unknown)}`)])
  }

  const assumptionKeys = Object.keys(normalized.assumptions).sort()
  if (assumptionKeys.length > 0) {
    sections.push([
      'assumptions:',
      ...bounded(
        assumptionKeys.map((key) => {
          const assumption = normalized.assumptions[key]
          return `- ${formatPromptToken(key)}=${formatPromptValue(assumption.value)}${provenanceSuffix(assumption.evidence)}`
        })
      ),
    ])
  }

  const contested = contestedLines(normalized)
  if (contested.length > 0) sections.push(['contested:', ...bounded(contested)])

  return sections.map((section) => section.join('\n')).join('\n\n')
}

/**
 * The most lines the `assumptions:` and `contested:` sections list each. The
 * view rides every turn, so a reading that suggested hundreds of values must not
 * grow it without end; the text says how many it left out.
 */
const MAX_VIEW_LINES = 60

/** Longest file name the view carries; a name is a pointer, not content. */
const MAX_VIEW_FILE_NAME_LENGTH = 120

/** At most {@link MAX_VIEW_LINES} lines, then one line saying how many more there are. */
function bounded(lines: string[]): string[] {
  if (lines.length <= MAX_VIEW_LINES) return lines
  return [...lines.slice(0, MAX_VIEW_LINES), `- … und ${lines.length - MAX_VIEW_LINES} weitere`]
}

/** `Datei, S. n`, or `Datei` when the document has no pages. Never a quote: a quote is document text, and the view is not the place for it. */
function documentSource(evidence: ProjectFact['evidence']): string | null {
  const document = evidence?.find((entry) => entry.kind === 'document')
  if (document?.kind !== 'document') return null
  const name = formatPromptToken(document.fileName.slice(0, MAX_VIEW_FILE_NAME_LENGTH))
  return document.page === null ? name : `${name}, S. ${document.page}`
}

/**
 * Where a suggestion came from, for an `assumptions:` line: the first document
 * it was read in, or that it was derived from other values. Nothing when it has
 * no evidence (a person's estimate, a profile from before the intake).
 */
function provenanceSuffix(evidence: ProjectAssumption['evidence']): string {
  const source = documentSource(evidence)
  if (source) return ` [Vorschlag: ${source}]`
  return evidence?.some((entry) => entry.kind === 'derivation') ? ' [abgeleitet]' : ''
}

/**
 * Keys that carry a different value found beside the one they hold, facts and
 * assumptions alike: `- key: value | alternativ: v2 (Datei, S. n)`. The agent
 * must not state either as settled; it asks, or names both.
 */
function contestedLines(profile: ProjectProfile): string[] {
  const entries = [
    ...Object.entries(profile.facts).map(([key, fact]) => ({ key, ...fact })),
    ...Object.entries(profile.assumptions).map(([key, assumption]) => ({ key, ...assumption })),
  ]
  return entries
    .filter((entry) => (entry.alternatives?.length ?? 0) > 0)
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((entry) => {
      const alternatives = (entry.alternatives ?? []).map((alternative) => {
        const source = documentSource(alternative.evidence)
        return ` | alternativ: ${formatPromptValue(alternative.value)}${source ? ` (${source})` : ''}`
      })
      return `- ${formatPromptToken(entry.key)}: ${formatPromptValue(entry.value)}${alternatives.join('')}`
    })
}

export function buildProjectProfileDisplay(
  profile: ProjectProfile,
  // The AI summary is generated by a separate async call (POST /generate-summary)
  // and stored on profileDisplay.summary. Rebuilding the display from the raw
  // profile (on every save/patch) must PRESERVE that summary rather than wiping
  // it -- otherwise any chat-driven profile edit permanently blanks the Project
  // Brief prose until the next full intake save.
  previousSummary = '',
  // The locale that `previousSummary` was generated in, carried over 1:1 with
  // the summary so a preserved prose keeps its language provenance (and a reset
  // summary drops it — callers pass undefined). See ProjectProfileDisplaySchema.
  previousSummaryLocale?: string
): ProjectProfileDisplay {
  const normalized = ProjectProfileSchema.parse(profile)
  const brief = buildProjectBriefView(normalized)

  return {
    title: 'Project profile',
    summary: previousSummary,
    summaryLocale: previousSummaryLocale,
    // Human-readable, intake-ordered: question labels ("Building class") and
    // option labels ("Residential") instead of raw keys/enum values.
    keyFacts: brief.groups.flatMap((group) =>
      group.facts.map((fact) => ({ label: fact.label, value: fact.value }))
    ),
    missingInfo: brief.missing.map((item) => item.label),
  }
}

function formatPromptToken(value: string): string {
  return isSafePromptToken(value)
    ? value
    : JSON.stringify(value).replace(/[\u0080-\u009f\u2028\u2029]/g, escapeLineSeparator)
}

function formatPromptValue(value: ProjectPrimitiveValue): string {
  if (typeof value === 'string') {
    return formatPromptToken(value)
  }

  return String(value)
}

function isSafePromptToken(value: string): boolean {
  return !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)
}

function escapeLineSeparator(value: string): string {
  return `\\u${value.charCodeAt(0).toString(16).padStart(4, '0')}`
}
