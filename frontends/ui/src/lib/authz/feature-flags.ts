/**
 * Feature-flag registry: every switch the code reads, and which kind it is.
 *
 * A flag is one of two kinds ({@link FLAG_KINDS}), and the kind decides where
 * its answer comes from (ADR-0102, amending ADR-0100):
 *
 *   - an `entitlement` is AUTHORIZATION. It is granted per organization because
 *     it costs money or changes who can read what (deep research, tasks, BYOK,
 *     model configuration, collaboration, the mail import, skills). It lives in
 *     WorkOS's Feature Flags product, is targeted in the WorkOS dashboard, and
 *     arrives in the AuthKit JWT as the `feature_flags` claim: signed, and the
 *     same delivery path as permissions.
 *   - a `rollout` is a KILL SWITCH. It is a feature we ship to everybody (web
 *     search, the knowledge page, image upload, the wizard's conflict check, IFC
 *     models, filing agent-written documents, the follow-up stage), and the flag
 *     exists so an operator can withdraw it without a deploy. It lives in
 *     PostHog and is evaluated per ORGANIZATION
 *     (`lib/analytics/rollout-flags.ts`).
 *
 * PostHog flags are never authorization (ADR-0100). That is why the split runs
 * along the kind: nothing an organization pays for, or that changes who may
 * read what, is decided by an analytics vendor.
 *
 * ## Where a session's flags come from
 *
 * `session.featureFlags` is assembled where a session is built
 * (`sessionFeatureFlags` in `lib/workos/feature-flags.ts`, which
 * `lib/auth/session.ts` calls, and `enabledFlagsForOrganization`, which
 * `lib/auth/pinned-session.ts` calls): the entitlements the WorkOS claim
 * carries, plus the rollouts PostHog has not switched off for the
 * organization. A rollout slug still sitting in the WorkOS claim is ignored. So
 * every gate below stays a synchronous read of one array. A caller with no
 * session (a scheduled fire, an internal route, the per-turn stage read) asks
 * `isOrgFeatureEnabled` in the same module, which routes by kind the same way.
 *
 * ## Two semantics, one per kind
 *
 * An entitlement is ON exactly when WorkOS says so. Anything short of a yes is
 * a no: a token minted before the claim existed, a slug missing from WorkOS, a
 * failed lookup, a caller with no organization. An outage never hands out what
 * an organization was not granted.
 *
 * A rollout is ON unless PostHog explicitly answers off for the organization.
 * PostHog not configured, the flag not created there, an evaluation that fails
 * and a stale token all leave it on: it is shipped to everybody, and an outage
 * of the analytics vendor must not withdraw it.
 *
 * ## The one exception: a deployment that authenticates nobody
 *
 * With `REQUIRE_AUTH` not `true` (local dev, an anonymous compose stack) there
 * is no signed-in user, so there is no claim and usually no organization to
 * ask about. Such a deployment gets a FIXED answer per flag, decided by its
 * kind:
 *
 *   - a `rollout` is ON. A developer must see what customers see.
 *   - an `entitlement` is OFF. An unauthenticated deployment that is reachable
 *     from somewhere it should not be must not hand those out, the same
 *     direction every other entitlement failure takes.
 *
 * The condition is `REQUIRE_AUTH` rather than `NODE_ENV`, because the built
 * image runs `NODE_ENV=production` in compose too, and rather than the absence
 * of a WorkOS key, because a stack that signs people in cannot run without one.
 * To exercise an entitlement locally, run with `REQUIRE_AUTH=true` against the
 * Staging WorkOS environment: that is the code path production runs, and the
 * only one worth rehearsing.
 *
 * Every entitlement slug must exist in BOTH WorkOS environments, or it is off
 * for everybody: `task fe:provision:flags` checks that, read-only (runbook:
 * docs/deployment/workos-provisioning.md). A rollout needs no flag anywhere to
 * be on; it needs a PostHog flag to be switchable off.
 */

import type { GridSession } from '@/lib/auth/types'
import { isAuthRequired } from '@/lib/auth/auth-required'
import { NextResponse } from 'next/server'

export const FEATURE_FLAGS = {
  /** Runtime AI model configuration (ADR-0014) — a premium admin feature. */
  modelConfiguration: 'runtime-model-config',
  /** Deep research agent mode — the expensive long-running workflow. */
  deepResearch: 'deep-research',
  /**
   * Delegated tasks and their schedules (ADR-0051/0054): work a chat turn hands
   * over instead of answering, plus the recurring `cadence` form.
   *
   * Deliberately NOT part of `skills`, although the two shipped together and the
   * Automation section shows both. They are not one feature. A skill is a
   * published instruction the agent may follow inside a turn; a task is a unit
   * of work that OUTLIVES the turn, costs the requester's budget and runs under
   * their permissions. An organization can reasonably have the toolbox and not
   * the right to queue work against it — which is exactly the shape the product
   * wanted: the skills we publish stay usable in chat, the Automation tab and
   * everything that queues work do not.
   *
   * It is also the second door into the workflow `deep-research` closes, since
   * a task's agent type may be `researcher` or `deep_researcher`. Gating the
   * escalation and leaving this open would withdraw deep research from the chat
   * turn and leave it reachable by asking for it as a task.
   */
  taskAutomation: 'task-automation',
  /** Project-level knowledge-base transparency page (nav section). */
  projectKnowledgePage: 'project-knowledge-page',
  /** Per-org BYOK LLM credentials via WorkOS Vault (ADR-0022) — enterprise tier. */
  byokLlm: 'byok-llm',
  /** Platform-layer web-search gate; tenant toggle lives in org settings (ADR-0022). */
  webSearch: 'web-search',
  /** Standalone PNG/JPG image upload via VLM captioning (FB-15a); gates the
   *  accept-list (client) and the server-side upload allow-list (BFF). */
  imageUpload: 'image-upload',
  /** End-of-wizard AI conflict check (FB-13): on Save, an LLM checks the intake
   *  answers for internal contradictions and the user confirms/overrides or
   *  revises. Server-computed in the intake page, prop-drilled to the wizard;
   *  off → the wizard saves exactly as before (no check). */
  wizardConflictCheck: 'wizard-conflict-check',
  /**
   * Collaboration (ADR-0032/0033/0034/0035): shared chats, @-mentions with the
   * agent hand-off, and the inbox. An entitlement: it changes who can see a
   * conversation, so nobody has it until an operator targets the organization.
   *
   * Gates the inbox nav entry + page, the share surfaces, the mention picker, and
   * every `/api/inbox/*`, `/api/sharing/*` and `/api/stream` route. With the flag
   * off the product behaves exactly as it did before the feature existed
   * (spec NF-8).
   *
   * Note there is deliberately NO paired capability gate: the feature works with
   * the shared cache tier absent (live updates degrade to polling, spec RT-3), so
   * it has no infrastructure dependency to derive a capability from — per the
   * capability doctrine in AGENTS.md.
   */
  collaboration: 'collaboration',
  /**
   * IFC/BIM models (ADR-0045): `.ifc` upload, in-browser model viewer, and the
   * agent's deterministic `ifc_query` tool.
   *
   * Gates the `.ifc` entry in the upload accept-list (client and the BFF
   * allow-list), the model surfaces, and every `/api/**\/bim/*` route.
   *
   * Like `collaboration`, there is deliberately NO paired capability gate.
   * Extraction runs in the BFF process with `@ifc-lite/parser` and the viewer
   * runs in the browser, so the feature has no infrastructure dependency to
   * derive a capability from — per the capability doctrine in AGENTS.md. The
   * viewer's WebGPU requirement is a per-BROWSER fact, detected at render time
   * and degraded to the data explorer, not a deployment capability.
   */
  ifcModels: 'ifc-models',
  /**
   * Agent-authored documents: a finished deep-research report and a drawn
   * diagram filed into a project as `documents` rows
   * (`lib/documents/generated.ts`, ADR-0047's 2026-08-20 addenda).
   *
   * Gates the ONE filing seam, so every producer rides it — a flag per producer
   * could only let the two disagree, which is the argument the `skills` entry
   * above already makes about jobs.
   *
   * ## Why this exists ALONGSIDE `project:documents:generate`
   *
   * They answer different questions, and neither can answer the other's.
   *
   *   - The permission is the TENANT's: per project, per role, set by the
   *     organization's own admin, and withheld by putting people on a custom
   *     project role that omits it. It cannot serve as an operator kill switch,
   *     because the only way to withdraw it fleet-wide is to edit the built-in
   *     `project-editor`/`project-admin` roles in WorkOS — which makes
   *     `provision:authz --check` fail in CI (ADR-0038 §1). The repo actively
   *     forbids using the catalog as a knob.
   *   - This flag is the OPERATOR's: is the capability present in this
   *     deployment at all. It is what the rollout runbook's §4 reaches for when
   *     filing has to stop now, and it stops filing for every producer and every
   *     tenant without touching a single role.
   *
   * A rollout: ON for every organization unless its PostHog flag answers off,
   * and switching it off for one organization (or all) is a release-condition
   * change in PostHog, no deploy.
   */
  agentAuthoredDocuments: 'agent-authored-documents',
  /** Agent Skills: the org toolbox of agentskills.io-format skills plus the
   *  project jobs that may attach them. Gates every /api/skills and
   *  /api/projects/[id]/jobs route, and whether a due schedule fires for the
   *  organization (`fireScheduledJob`). Jobs ride this one flag: they ship as
   *  one feature, so a second flag could only let them disagree. */
  skills: 'skills',
  /** Outlook archive (.pst/.ost) import into a project (ADR-0085). It files the
   *  correspondence of everyone who wrote to the office, so an operator
   *  switches it on per organization, deliberately. */
  mailImport: 'mail-import',
  /**
   * The post-answer follow-up-questions stage (`docs/architecture/
   * post-answer-stages.md`). Read per turn by the agent tier through
   * `GET /api/internal/stages` (`POST_ANSWER_STAGE_FLAGS` in
   * `lib/workos/feature-flags.ts`), never from a session. The memory-reflection
   * stage had a flag beside it and has none now: it is core, and runs wherever
   * a model is configured for it.
   */
  postAnswerFollowUps: 'post-answer-follow-ups',
} as const

export type KnownFeatureFlag = (typeof FEATURE_FLAGS)[keyof typeof FEATURE_FLAGS]

/** The two kinds of switch; see the module header. */
export type FlagKind = 'entitlement' | 'rollout'

/**
 * What kind of switch each flag is, which decides where its answer comes from
 * (WorkOS or PostHog) and its fixed answer in a deployment that authenticates
 * nobody (see the module header). Checked against every slug, so a flag added
 * to the registry does not compile until somebody has said which kind it is,
 * and kept as literal types, so each kind is a type as well as a list.
 */
export const FLAG_KINDS = {
  'runtime-model-config': 'entitlement',
  'deep-research': 'entitlement',
  'task-automation': 'entitlement',
  'byok-llm': 'entitlement',
  collaboration: 'entitlement',
  skills: 'entitlement',
  'mail-import': 'entitlement',
  'web-search': 'rollout',
  'project-knowledge-page': 'rollout',
  'image-upload': 'rollout',
  'wizard-conflict-check': 'rollout',
  'ifc-models': 'rollout',
  'agent-authored-documents': 'rollout',
  'post-answer-follow-ups': 'rollout',
} as const satisfies Readonly<Record<KnownFeatureFlag, FlagKind>>

/** A slug WorkOS decides: authorization, carried by the signed claim. */
export type EntitlementFlag = {
  [Slug in KnownFeatureFlag]: (typeof FLAG_KINDS)[Slug] extends 'entitlement' ? Slug : never
}[KnownFeatureFlag]

/** A slug PostHog decides: a kill switch over something shipped to everybody. */
export type RolloutFlag = Exclude<KnownFeatureFlag, EntitlementFlag>

const KIND_OF: Readonly<Record<string, FlagKind | undefined>> = FLAG_KINDS

/** Whether `slug` is a registry entitlement. Any other string is not. */
export function isEntitlementFlag(slug: string): slug is EntitlementFlag {
  return KIND_OF[slug] === 'entitlement'
}

/** Whether `slug` is a registry rollout. Any other string is not. */
export function isRolloutFlag(slug: string): slug is RolloutFlag {
  return KIND_OF[slug] === 'rollout'
}

/** Every slug the code reads. */
export const REGISTRY_FLAG_SLUGS: readonly KnownFeatureFlag[] = Object.values(FEATURE_FLAGS)

/** The slugs WorkOS must hold, for the drift check (`task fe:provision:flags`). */
export const ENTITLEMENT_FLAG_SLUGS: readonly EntitlementFlag[] = REGISTRY_FLAG_SLUGS.filter(isEntitlementFlag)

/** The slugs PostHog decides: the keys of the flags it needs to switch one off. */
export const ROLLOUT_FLAG_SLUGS: readonly RolloutFlag[] = REGISTRY_FLAG_SLUGS.filter(isRolloutFlag)

/**
 * Whether flags are evaluated live here (entitlements by WorkOS, rollouts by
 * PostHog) rather than given their fixed per-kind answer: true wherever people
 * sign in. The one definition the session gates and the session-less ones
 * share.
 */
export function flagsAreLive(): boolean {
  return isAuthRequired()
}

/** A flag's fixed answer in a deployment that authenticates nobody. */
export function unauthenticatedDefault(flag: KnownFeatureFlag): boolean {
  return FLAG_KINDS[flag] === 'rollout'
}

/** Whether the session's user+org context has the feature enabled. */
export function isFeatureEnabled(
  session: Pick<GridSession, 'featureFlags'>,
  flag: KnownFeatureFlag
): boolean {
  if (!flagsAreLive()) return unauthenticatedDefault(flag)
  // A session `getGridSession` or `resolvePinnedRequesterSession` built is never
  // null here: a stale token's missing claim already reads as "no
  // entitlements", and its rollouts came from PostHog. `null` is the hand-made
  // session of a caller nobody is signed in as, and everything is off for it.
  if (session.featureFlags === null) return false
  return session.featureFlags.includes(flag)
}

/**
 * The project knowledge page. The platform owner's base-knowledge manager is
 * NOT gated by this.
 */
export function isProjectKnowledgePageEnabled(session: Pick<GridSession, 'featureFlags'>): boolean {
  return isFeatureEnabled(session, FEATURE_FLAGS.projectKnowledgePage)
}

/**
 * The Outlook archive import (ADR-0085). Checked when an import is started and
 * when its upload completes; the job that files it does not re-check, so
 * switching the flag off stops new imports and lets a running one finish.
 */
export function isMailImportEnabled(session: Pick<GridSession, 'featureFlags'>): boolean {
  return isFeatureEnabled(session, FEATURE_FLAGS.mailImport)
}

/** Collaboration (ADR-0032…0035). */
export function isCollaborationEnabled(session: Pick<GridSession, 'featureFlags'>): boolean {
  return isFeatureEnabled(session, FEATURE_FLAGS.collaboration)
}

/**
 * IFC/BIM models (ADR-0045). Worth knowing before enabling it for a customer:
 * the feature renders OIB compliance verdicts, so an organization that has not
 * looked at its output is being told something about a building.
 */
export function isIfcModelsEnabled(session: Pick<GridSession, 'featureFlags'>): boolean {
  return isFeatureEnabled(session, FEATURE_FLAGS.ifcModels)
}

/**
 * Agent-authored documents: whether Piloti may file what it writes. The
 * OPERATOR's lever; the tenant's is `project:documents:generate`. See the
 * registry entry for why there are two.
 */
export function isAgentAuthoredDocumentsEnabled(
  session: Pick<GridSession, 'featureFlags'>
): boolean {
  return isFeatureEnabled(session, FEATURE_FLAGS.agentAuthoredDocuments)
}

/**
 * Route guard for collaboration: stable-coded 403 when off, null when allowed.
 * Usage: `const gated = requireCollaborationEnabled(session); if (gated) return gated`
 */
export function requireCollaborationEnabled(
  session: Pick<GridSession, 'featureFlags'>
): Response | null {
  return requireFeature(session, FEATURE_FLAGS.collaboration)
}

/** Agent Skills and the project jobs that attach them (ADR-0046). */
export function isSkillsEnabled(session: Pick<GridSession, 'featureFlags'>): boolean {
  return isFeatureEnabled(session, FEATURE_FLAGS.skills)
}

/**
 * Route guard for the skills feature: stable-coded 403 when off (matching
 * requireFeature's envelope), null when allowed. Usage:
 * `const gated = requireSkillsEnabled(session); if (gated) return gated`
 */
export function requireSkillsEnabled(session: Pick<GridSession, 'featureFlags'>): Response | null {
  return requireFeature(session, FEATURE_FLAGS.skills)
}

/** Whether this session may create delegated tasks and schedules. */
export function isTaskAutomationEnabled(session: Pick<GridSession, 'featureFlags'>): boolean {
  return isFeatureEnabled(session, FEATURE_FLAGS.taskAutomation)
}

/**
 * Route guard for delegated tasks: stable-coded 403 when off, null when allowed.
 * Usage: `const gated = requireTaskAutomationEnabled(session); if (gated) return gated`
 */
export function requireTaskAutomationEnabled(
  session: Pick<GridSession, 'featureFlags'>
): Response | null {
  return requireFeature(session, FEATURE_FLAGS.taskAutomation)
}

/**
 * Route guard: stable-coded 403 when the feature is off, null when allowed.
 * Usage: `const gated = requireFeature(session, FEATURE_FLAGS.x); if (gated) return gated`
 */
export function requireFeature(
  session: Pick<GridSession, 'featureFlags'>,
  flag: KnownFeatureFlag
): Response | null {
  if (isFeatureEnabled(session, flag)) return null
  return NextResponse.json({ error: 'feature-disabled', feature: flag }, { status: 403 })
}
