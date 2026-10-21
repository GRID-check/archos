/**
 * The platform operations (ADR-0121): the GRID operator console. See
 * `projects.ts` for the shape and `docs/architecture/agent-surface.md` for the rules.
 *
 * Every route here is declared through `platformApiRoute`, so only a platform
 * operator's call gets past the route's own gate; the catalog does not widen
 * it. The quality views (`/api/platform/answer-feedback`, `citation-health`,
 * `profiler`, `quality/scope-options`) read their scope with hand-written
 * parsers (`parseQualityScopeStrict`, `requireFeedbackQuery`), not zod, so the
 * `query` schemas below describe those parameters for the agent; the route's
 * parser stays the gate.
 */

import { z } from 'zod'
import { CONVERSATION_TAG_KEYS } from '@/lib/conversations/tags'
import {
  FEEDBACK_CONFIDENCE_FILTERS,
  FEEDBACK_MODE_FILTERS,
  FEEDBACK_REASON_FILTERS,
} from '@/lib/feedback/filters'
import { platformOrgBudgetPutSchema } from '@/lib/budgets/platform-contract'
import { putNormRegistryBodySchema, verifyNormRequestSchema } from '@/lib/norms/schemas'
import { updateLessonSchema } from '@/lib/platform-lessons/types'
import {
  modelDefaultsPutSchema,
  pricingPutSchema,
  reasoningEffortsPutSchema,
  reingestKnowledgeSchema,
  retrievalSettingsPutSchema,
} from '@/lib/platform/platform-wire'
import { listProductFeedbackQuerySchema, triageProductFeedbackSchema } from '@/lib/product-feedback/types'
import {
  createCategorySchema,
  createPlatformSkillSchema,
  patchCategorySchema,
  patchPlatformSkillSchema,
} from '@/lib/skills/types'
import { storageQuotaPutSchema, uploadLimitPutSchema } from '@/lib/storage/contract'
import type { AgentOperation } from '../operation'
import { MAX_UPLOAD_BYTES, uploadBodySchemaWith } from '../upload-wire'

const organizationParams = z.object({
  organizationId: z.string().describe('The organization id, from platform-overview-get.'),
})
const lessonParams = z.object({
  lessonId: z.string().describe('The lesson id (a uuid), from platform-lesson-list.'),
})
const reportParams = z.object({
  reportId: z.string().describe('The product-feedback report id (a uuid), from platform-feedback-list.'),
})
const skillParams = z.object({
  skillId: z.string().describe('The platform skill id, from platform-skill-list.'),
})
const categoryParams = z.object({
  categoryId: z.string().describe('The platform skill category id, from platform-skill-category-list.'),
})
const fileNameParams = z.object({
  fileName: z
    .string()
    .describe('The base-corpus file name, exactly as the knowledge corpus status lists it (knowledge-corpus operations).'),
})

/** The scope every quality view shares (`parseQualityScopeStrict`). */
const qualityScopeQuery = z.object({
  from: z.string().optional().describe('First day, YYYY-MM-DD, UTC, inclusive. Give `from` and `to` together.'),
  to: z.string().optional().describe('Last day, YYYY-MM-DD, UTC, inclusive. At most 366 days after `from`.'),
  days: z
    .union([z.literal(7), z.literal(30), z.literal(90)])
    .optional()
    .describe('A range ending today, used when `from` and `to` are absent. Default 30.'),
  org: z.array(z.string()).optional().describe('Limit to these organization ids; empty means every organization.'),
  project: z.array(z.string()).optional().describe('Limit to these project ids; empty means every project.'),
})

/** The ratings filters on top of the scope (`requireFeedbackQuery`). */
const ratingsQuery = qualityScopeQuery.extend({
  verdict: z.enum(['up', 'down', 'all']).optional().describe('Thumbs filter.'),
  reason: z.array(z.enum(FEEDBACK_REASON_FILTERS)).optional().describe('Down-vote reasons to keep.'),
  topic: z.array(z.enum(CONVERSATION_TAG_KEYS)).optional().describe('Conversation topics to keep.'),
  mode: z.array(z.enum(FEEDBACK_MODE_FILTERS)).optional().describe('Answer modes to keep.'),
  confidence: z.array(z.enum(FEEDBACK_CONFIDENCE_FILTERS)).optional().describe('Answer confidence levels to keep.'),
  has_comment: z.enum(['0', '1']).optional().describe('1 keeps only votes with a comment.'),
  has_expected: z.enum(['0', '1']).optional().describe('1 keeps only votes with an expected answer.'),
  q: z.string().max(120).optional().describe('Free-text search over the vote.'),
})

export const platformOperations: readonly AgentOperation[] = [
  // Overview, storage, audit
  {
    name: 'platform-overview-get',
    domain: 'platform',
    summary: 'Platform overview across all organizations',
    description:
      'The operator dashboard in one read: every organization with its headline figures. Start here for organization ids; ' +
      'the platform-org-* operations take one. Platform operators only.',
    method: 'GET',
    path: '/api/platform/overview',
    load: () => import('@/app/api/platform/overview/route'),
  },
  {
    name: 'platform-storage-overview',
    domain: 'platform',
    summary: 'Storage use of every organization',
    description:
      'Storage used and quota per organization, for the whole platform. Use it to find an organization near its quota, ' +
      'then change it with platform-org-storage-update.',
    method: 'GET',
    path: '/api/platform/storage',
    load: () => import('@/app/api/platform/storage/route'),
  },
  {
    name: 'platform-audit-portal-link',
    domain: 'platform',
    summary: 'Get an Admin Portal link to the platform audit log',
    description:
      'Generates a short-lived WorkOS Admin Portal link to the platform organization’s audit-log viewer, where break-glass ' +
      'access and other platform events land. Returns `{ link }`; open it in a browser. The link is a credential to the ' +
      'platform audit log: hand it to nobody else.',
    method: 'POST',
    path: '/api/platform/audit-portal',
    // Mints an Admin Portal credential: a write that hands out a secret, never a read.
    idempotent: false,
    sensitivity: 'secret',
    load: () => import('@/app/api/platform/audit-portal/route'),
  },

  // Per-organization limits
  {
    name: 'platform-org-budget-get',
    domain: 'platform',
    summary: 'Read an organization’s credit budget',
    description:
      'The daily and monthly credit limits of one organization and what the platform default would give it. ' +
      'Organization ids come from platform-overview-get. Change it with platform-org-budget-update.',
    method: 'GET',
    path: '/api/platform/organizations/[organizationId]/budgets',
    params: organizationParams,
    load: () => import('@/app/api/platform/organizations/[organizationId]/budgets/route'),
  },
  {
    name: 'platform-org-budget-update',
    domain: 'platform',
    summary: 'Set an organization’s credit budget',
    description:
      'Replaces the credit limits of one organization. Read the current values with platform-org-budget-get first. ' +
      'Takes effect on the organization’s next generation and is audited.',
    method: 'PUT',
    path: '/api/platform/organizations/[organizationId]/budgets',
    params: organizationParams,
    body: platformOrgBudgetPutSchema,
    load: () => import('@/app/api/platform/organizations/[organizationId]/budgets/route'),
  },
  {
    name: 'platform-org-usage-get',
    domain: 'platform',
    summary: 'Read an organization’s credit usage',
    description:
      'Credits one organization has used against its budget. Organization ids come from platform-overview-get; ' +
      'compare with platform-org-budget-get.',
    method: 'GET',
    path: '/api/platform/organizations/[organizationId]/usage',
    params: organizationParams,
    load: () => import('@/app/api/platform/organizations/[organizationId]/usage/route'),
  },
  {
    name: 'platform-org-storage-get',
    domain: 'platform',
    summary: 'Read an organization’s storage quota and use',
    description:
      'Bytes stored and the quota of one organization. Organization ids come from platform-overview-get. ' +
      'Change the quota with platform-org-storage-update.',
    method: 'GET',
    path: '/api/platform/organizations/[organizationId]/storage',
    params: organizationParams,
    load: () => import('@/app/api/platform/organizations/[organizationId]/storage/route'),
  },
  {
    name: 'platform-org-storage-update',
    domain: 'platform',
    summary: 'Set an organization’s storage quota',
    description:
      'Sets the storage quota in bytes for one organization (the route’s schema bounds the value). ' +
      'Read the current figure with platform-org-storage-get first. Audited.',
    method: 'PUT',
    path: '/api/platform/organizations/[organizationId]/storage',
    params: organizationParams,
    body: storageQuotaPutSchema,
    load: () => import('@/app/api/platform/organizations/[organizationId]/storage/route'),
  },
  {
    name: 'platform-org-upload-limit-update',
    domain: 'platform',
    summary: 'Set an organization’s maximum upload file size',
    description:
      'Sets the largest single file one organization may upload, in bytes, within the platform ceiling. ' +
      'Organization ids come from platform-overview-get. Audited.',
    method: 'PUT',
    path: '/api/platform/organizations/[organizationId]/upload-limit',
    params: organizationParams,
    body: uploadLimitPutSchema,
    load: () => import('@/app/api/platform/organizations/[organizationId]/upload-limit/route'),
  },

  // Models, reasoning, retrieval, pricing
  {
    name: 'platform-model-defaults-get',
    domain: 'platform',
    summary: 'Read the fleet-wide default models',
    description:
      'The model each agent group runs by default for every organization, who set it, whether it is zero-data-retention safe, ' +
      'and the YAML fallback. Read it before platform-model-defaults-update, which replaces the whole set.',
    method: 'GET',
    path: '/api/platform/model-defaults',
    load: () => import('@/app/api/platform/model-defaults/route'),
  },
  {
    name: 'platform-model-defaults-update',
    domain: 'platform',
    summary: 'Set the fleet-wide default models',
    description:
      'Replaces the complete set of default models, one OpenRouter `author/slug` id per agent group. This moves every ' +
      'organization at once: each id is revalidated against the live catalog and the ZDR list, and the change is audited. ' +
      'Groups left out are cleared back to the YAML. Find ids with platform-model-search.',
    method: 'PUT',
    path: '/api/platform/model-defaults',
    body: modelDefaultsPutSchema,
    load: () => import('@/app/api/platform/model-defaults/route'),
  },
  {
    name: 'platform-model-search',
    domain: 'platform',
    summary: 'Search models allowed for an agent group',
    description:
      'Searches the OpenRouter catalog for models a given agent group may use under the platform’s ZDR rule. ' +
      'Agent group ids are the keys platform-model-defaults-get returns. Use the ids it returns in platform-model-defaults-update.',
    method: 'GET',
    path: '/api/platform/model-defaults/models',
    query: z.object({
      group: z.string().describe('The agent group id, from platform-model-defaults-get `agentGroups`.'),
      q: z.string().optional().describe('Search text over model names and ids.'),
    }),
    load: () => import('@/app/api/platform/model-defaults/models/route'),
  },
  {
    name: 'platform-reasoning-efforts-get',
    domain: 'platform',
    summary: 'Read the fleet-wide reasoning efforts',
    description:
      'The reasoning effort set per agent group for every organization, with the YAML fallback. ' +
      'Read it before platform-reasoning-efforts-update, which replaces the whole set.',
    method: 'GET',
    path: '/api/platform/reasoning-efforts',
    load: () => import('@/app/api/platform/reasoning-efforts/route'),
  },
  {
    name: 'platform-reasoning-efforts-update',
    domain: 'platform',
    summary: 'Set the fleet-wide reasoning efforts',
    description:
      'Replaces the complete reasoning-effort set per agent group; groups left out return to the YAML. Lowering effort is ' +
      'the lever for a run that burns tokens. Applies to every organization and is audited.',
    method: 'PUT',
    path: '/api/platform/reasoning-efforts',
    body: reasoningEffortsPutSchema,
    load: () => import('@/app/api/platform/reasoning-efforts/route'),
  },
  {
    name: 'platform-retrieval-settings-get',
    domain: 'platform',
    summary: 'Read the fleet-wide retrieval settings',
    description:
      'The retrieval depth settings (how many chunks each stage fetches): their definitions and the values currently saved. ' +
      'Read it before platform-retrieval-settings-update.',
    method: 'GET',
    path: '/api/platform/retrieval-settings',
    load: () => import('@/app/api/platform/retrieval-settings/route'),
  },
  {
    name: 'platform-retrieval-settings-update',
    domain: 'platform',
    summary: 'Set the fleet-wide retrieval settings',
    description:
      'Replaces the complete retrieval settings map `{key: count}`; omitted keys are cleared to their defaults. ' +
      'Shifts recall and token spend for every organization and is audited. Keys come from platform-retrieval-settings-get.',
    method: 'PUT',
    path: '/api/platform/retrieval-settings',
    body: retrievalSettingsPutSchema,
    load: () => import('@/app/api/platform/retrieval-settings/route'),
  },
  {
    name: 'platform-pricing-get',
    domain: 'platform',
    summary: 'Read the price list',
    description:
      'The current pricing version (margin multiplier, USD per credit, default organization allowances), its bounds and a ' +
      'reference request. Read it before platform-pricing-update.',
    method: 'GET',
    path: '/api/platform/pricing',
    load: () => import('@/app/api/platform/pricing/route'),
  },
  {
    name: 'platform-pricing-update',
    domain: 'platform',
    summary: 'Publish a new price list',
    description:
      'Saves a new pricing version: margin multiplier, USD per credit and the default daily and monthly credit allowances ' +
      '(null for none). It reprices every organization’s next generation and is audited; the previous version is kept.',
    method: 'PUT',
    path: '/api/platform/pricing',
    body: pricingPutSchema,
    load: () => import('@/app/api/platform/pricing/route'),
  },

  // Norms
  {
    name: 'platform-norm-registry-get',
    domain: 'platform',
    summary: 'Read the norm registry',
    description:
      'The registry of building-law norms the agent cites, with its version number. Read it before platform-norm-registry-update, ' +
      'which writes the whole registry back at the next version.',
    method: 'GET',
    path: '/api/platform/norms',
    load: () => import('@/app/api/platform/norms/route'),
  },
  {
    name: 'platform-norm-registry-update',
    domain: 'platform',
    summary: 'Replace the norm registry',
    description:
      'Writes the complete norm registry (`{ version, registry }`) as read from platform-norm-registry-get with your edits; ' +
      'a stale version is rejected. It changes which norms every organization’s answers can cite. Audited.',
    method: 'PUT',
    path: '/api/platform/norms',
    body: putNormRegistryBodySchema,
    load: () => import('@/app/api/platform/norms/route'),
  },
  {
    name: 'platform-norm-verify',
    domain: 'platform',
    summary: 'Check a norm against the legal source',
    description:
      'Looks a norm up by title and application and returns the candidates the legal source offers, so an entry can be ' +
      'confirmed before it enters the registry. Changes nothing.',
    method: 'POST',
    path: '/api/platform/norms/verify',
    body: verifyNormRequestSchema,
    readOnly: true,
    load: () => import('@/app/api/platform/norms/verify/route'),
  },

  // Platform skills
  {
    name: 'platform-skill-list',
    domain: 'platform',
    summary: 'List the platform skills',
    description:
      'Every skill the platform offers to organizations, published or draft, with ids. Skill ids feed ' +
      'platform-skill-update and platform-skill-delete.',
    method: 'GET',
    path: '/api/platform/skills',
    load: () => import('@/app/api/platform/skills/route'),
  },
  {
    name: 'platform-skill-create',
    domain: 'platform',
    summary: 'Create a platform skill',
    description:
      'Adds a skill (name, description, body) to the platform catalog, a draft unless `published` is true. Published skills ' +
      'are offered to every organization, which may take or leave them. Category ids come from platform-skill-category-list.',
    method: 'POST',
    path: '/api/platform/skills',
    body: createPlatformSkillSchema,
    load: () => import('@/app/api/platform/skills/route'),
  },
  {
    name: 'platform-skill-update',
    domain: 'platform',
    summary: 'Edit or publish a platform skill',
    description:
      'Changes any field of a platform skill, including `published` and `categoryId` (null removes the category). ' +
      'Send only the fields to change. Skill ids come from platform-skill-list.',
    method: 'PATCH',
    path: '/api/platform/skills/[skillId]',
    params: skillParams,
    body: patchPlatformSkillSchema,
    idempotent: true,
    load: () => import('@/app/api/platform/skills/[skillId]/route'),
  },
  {
    name: 'platform-skill-delete',
    domain: 'platform',
    summary: 'Delete a platform skill',
    description:
      'Removes a skill from the platform catalog for every organization. Skill ids come from platform-skill-list. ' +
      'Prefer platform-skill-update with `published: false` to withdraw it reversibly.',
    method: 'DELETE',
    path: '/api/platform/skills/[skillId]',
    params: skillParams,
    destructive: true,
    load: () => import('@/app/api/platform/skills/[skillId]/route'),
  },
  {
    name: 'platform-skill-category-list',
    domain: 'platform',
    summary: 'List the platform skill categories',
    description: 'The categories that group platform skills, with ids and sort order. Ids feed the `categoryId` of a skill.',
    method: 'GET',
    path: '/api/platform/skill-categories',
    load: () => import('@/app/api/platform/skill-categories/route'),
  },
  {
    name: 'platform-skill-category-create',
    domain: 'platform',
    summary: 'Create a platform skill category',
    description: 'Adds a category for grouping platform skills. Returns it with its id; assign skills to it with platform-skill-update.',
    method: 'POST',
    path: '/api/platform/skill-categories',
    body: createCategorySchema,
    load: () => import('@/app/api/platform/skill-categories/route'),
  },
  {
    name: 'platform-skill-category-update',
    domain: 'platform',
    summary: 'Edit a platform skill category',
    description:
      'Renames a category or changes its description or sort order. Send only the fields to change. ' +
      'Category ids come from platform-skill-category-list.',
    method: 'PATCH',
    path: '/api/platform/skill-categories/[categoryId]',
    params: categoryParams,
    body: patchCategorySchema,
    idempotent: true,
    load: () => import('@/app/api/platform/skill-categories/[categoryId]/route'),
  },
  {
    name: 'platform-skill-category-delete',
    domain: 'platform',
    summary: 'Delete a platform skill category',
    description:
      'Removes a skill category. Category ids come from platform-skill-category-list; check which skills use it first.',
    method: 'DELETE',
    path: '/api/platform/skill-categories/[categoryId]',
    params: categoryParams,
    destructive: true,
    load: () => import('@/app/api/platform/skill-categories/[categoryId]/route'),
  },

  // Lessons
  {
    name: 'platform-lesson-list',
    domain: 'platform',
    summary: 'List the platform lessons',
    description:
      'The fleet-wide lesson register distilled from answer feedback, every lesson with status counts. ' +
      'Lesson ids feed platform-lesson-get and platform-lesson-update.',
    method: 'GET',
    path: '/api/platform/lessons',
    load: () => import('@/app/api/platform/lessons/route'),
  },
  {
    name: 'platform-lesson-sweep-run',
    domain: 'platform',
    summary: 'Distil lessons from unprocessed down-votes',
    description:
      'Runs a catch-up sweep that turns unprocessed down-votes into candidate lessons. Needed after an outage or for old ' +
      'feedback; new votes are processed on their own. Returns the sweep result; then review with platform-lesson-list.',
    method: 'POST',
    path: '/api/platform/lessons',
    idempotent: true,
    load: () => import('@/app/api/platform/lessons/route'),
  },
  {
    name: 'platform-lesson-get',
    domain: 'platform',
    summary: 'Read one lesson with its trail and provenance',
    description:
      'One lesson with its append-only event trail and provenance rows (feedback ids, organization hashes, anonymized summaries; ' +
      'never the raw reports). Lesson ids come from platform-lesson-list.',
    method: 'GET',
    path: '/api/platform/lessons/[lessonId]',
    params: lessonParams,
    load: () => import('@/app/api/platform/lessons/[lessonId]/route'),
  },
  {
    name: 'platform-lesson-update',
    domain: 'platform',
    summary: 'Activate, retire or edit a lesson',
    description:
      'Moves a lesson to active or retired, rewrites its text, or records its root cause; send only the fields to change. ' +
      'An active lesson shapes answers for every organization. Audited.',
    method: 'PATCH',
    path: '/api/platform/lessons/[lessonId]',
    params: lessonParams,
    body: updateLessonSchema,
    idempotent: true,
    load: () => import('@/app/api/platform/lessons/[lessonId]/route'),
  },

  // Product feedback triage
  {
    name: 'platform-feedback-list',
    domain: 'platform',
    summary: 'List product-feedback reports',
    description:
      'Product-feedback reports from every organization with the status of their PostHog Support ticket; filter by ticket ' +
      'status and kind, and page with the returned `nextCursor`. Report ids feed platform-feedback-get and platform-feedback-triage.',
    method: 'GET',
    path: '/api/platform/feedback',
    query: listProductFeedbackQuerySchema,
    load: () => import('@/app/api/platform/feedback/route'),
  },
  {
    name: 'platform-feedback-get',
    domain: 'platform',
    summary: 'Read one product-feedback report',
    description: 'One report and its live PostHog ticket. Report ids come from platform-feedback-list.',
    method: 'GET',
    path: '/api/platform/feedback/[reportId]',
    params: reportParams,
    load: () => import('@/app/api/platform/feedback/[reportId]/route'),
  },
  {
    name: 'platform-feedback-triage',
    domain: 'platform',
    summary: 'Move a feedback ticket to another status',
    description:
      'Sets the PostHog Support ticket status of a report; PostHog records who did it. Report ids come from ' +
      'platform-feedback-list; valid statuses are those it filters by.',
    method: 'PATCH',
    path: '/api/platform/feedback/[reportId]',
    params: reportParams,
    body: triageProductFeedbackSchema,
    idempotent: true,
    load: () => import('@/app/api/platform/feedback/[reportId]/route'),
  },

  // Answer quality
  {
    name: 'platform-quality-scope-options',
    domain: 'platform',
    summary: 'List organizations and projects for a quality scope',
    description:
      'The organizations and projects that have data in a date range, for building the `org` and `project` filters of the ' +
      'quality operations (answer feedback, citation health, profiler).',
    method: 'GET',
    path: '/api/platform/quality/scope-options',
    query: qualityScopeQuery,
    load: () => import('@/app/api/platform/quality/scope-options/route'),
  },
  {
    name: 'platform-answer-feedback-get',
    domain: 'platform',
    summary: 'Answer-feedback figures across organizations',
    description:
      'Thumbs up and down on answers over a scope: rates, reasons, topics, modes and the individual ratings, filtered like ' +
      'the Ratings tab. Narrow with platform-quality-scope-options ids; summarize in words with platform-answer-feedback-digest-get.',
    method: 'GET',
    path: '/api/platform/answer-feedback',
    query: ratingsQuery,
    load: () => import('@/app/api/platform/answer-feedback/route'),
  },
  {
    name: 'platform-answer-feedback-digest-get',
    domain: 'platform',
    summary: 'Plain-language digest of answer feedback',
    description:
      'An LLM-written summary of the answer feedback in a scope, cached server-side. A young window may answer with ' +
      '`no_feedback` or `too_few_votes` instead of text. It can be slow; the numbers are in platform-answer-feedback-get.',
    method: 'GET',
    path: '/api/platform/answer-feedback/digest',
    query: ratingsQuery.extend({
      locale: z.string().optional().describe('Language of the digest, de or en. Default de.'),
      refresh: z.literal('1').optional().describe('1 regenerates the digest instead of reading the cache.'),
    }),
    load: () => import('@/app/api/platform/answer-feedback/digest/route'),
  },
  {
    name: 'platform-answer-feedback-options-get',
    domain: 'platform',
    summary: 'Counts behind the answer-feedback filters',
    description:
      'Per-value counts (verdicts, reasons, topics, modes, confidences) and how many votes the current filters would match, ' +
      'to pick filters for platform-answer-feedback-get.',
    method: 'GET',
    path: '/api/platform/answer-feedback/options',
    query: ratingsQuery,
    load: () => import('@/app/api/platform/answer-feedback/options/route'),
  },
  {
    name: 'platform-citation-health-get',
    domain: 'platform',
    summary: 'Citation quality across organizations',
    description:
      'Rollup of citation checks over a scope: how many cited sources held up and why the others failed. ' +
      'For the flagged turns themselves use platform-citation-health-export.',
    method: 'GET',
    path: '/api/platform/citation-health',
    query: qualityScopeQuery,
    load: () => import('@/app/api/platform/citation-health/route'),
  },
  {
    name: 'platform-citation-health-export',
    domain: 'platform',
    summary: 'Diagnostic bundle of flagged citation turns',
    description:
      'A JSON bundle for root-cause analysis: every flagged turn, the sources retrieval returned, the sources the answer cited ' +
      'and which citation failed for which reason, with a glossary. Same scope as platform-citation-health-get; can be large.',
    method: 'GET',
    path: '/api/platform/citation-health/export',
    query: qualityScopeQuery,
    load: () => import('@/app/api/platform/citation-health/export/route'),
  },
  {
    name: 'platform-profiler-conversation-list',
    domain: 'platform',
    summary: 'List profiled conversations',
    description:
      'Conversations with timing profiles across organizations in a scope, optionally searched or narrowed to one. ' +
      'Conversation ids feed platform-profiler-conversation-get.',
    method: 'GET',
    path: '/api/platform/profiler/conversations',
    query: qualityScopeQuery.extend({
      q: z.string().optional().describe('Free-text search over conversations.'),
      conversation: z.string().optional().describe('Narrow to one conversation id.'),
    }),
    load: () => import('@/app/api/platform/profiler/conversations/route'),
  },
  {
    name: 'platform-profiler-conversation-get',
    domain: 'platform',
    summary: 'Timeline of one profiled conversation',
    description:
      'The step-by-step timeline of one conversation: where each turn spent its time. ' +
      'Conversation ids come from platform-profiler-conversation-list.',
    method: 'GET',
    path: '/api/platform/profiler/conversations/[conversationId]',
    params: z.object({
      conversationId: z.string().describe('The conversation id, from platform-profiler-conversation-list.'),
    }),
    load: () => import('@/app/api/platform/profiler/conversations/[conversationId]/route'),
  },
  {
    name: 'platform-card-list',
    domain: 'platform',
    summary: 'List the card types the agent can render',
    description:
      'Every card type the agent can render, with the fields each shows and a worked example, plus the link for requesting a ' +
      'card that does not exist yet. Derived from the backend, so it matches what the product renders.',
    method: 'GET',
    path: '/api/platform/cards',
    load: () => import('@/app/api/platform/cards/route'),
  },

  // Base knowledge corpus
  {
    name: 'platform-knowledge-document-delete',
    domain: 'platform',
    summary: 'Delete an uploaded base-corpus document',
    description:
      'Removes an admin-uploaded PDF from the shared base corpus for every organization: source file, registry entry and ' +
      'indexed chunks. It cannot be undone, and repo-shipped corpus files cannot be deleted. The file name comes from the corpus listing.',
    method: 'DELETE',
    path: '/api/platform/knowledge/documents/[fileName]',
    params: fileNameParams,
    destructive: true,
    load: () => import('@/app/api/platform/knowledge/documents/[fileName]/route'),
  },
  {
    name: 'platform-knowledge-title-update',
    domain: 'platform',
    summary: 'Rename a base-corpus document’s display title',
    description:
      'Sets the title users see on citation chips for a base-corpus document, with no re-ingest. An empty or null title ' +
      'restores the default. Returns `{ fileName, displayTitle }`.',
    method: 'PATCH',
    path: '/api/platform/knowledge/documents/[fileName]/display-title',
    params: fileNameParams,
    // The route reads the body by hand (no zod schema); it is the gate.
    body: z.object({
      display_title: z.string().nullable().describe('The new display title; empty or null clears the override.'),
    }),
    idempotent: true,
    load: () => import('@/app/api/platform/knowledge/documents/[fileName]/display-title/route'),
  },
  {
    name: 'platform-knowledge-doc-class-update',
    domain: 'platform',
    summary: 'Reclassify a base-corpus document',
    description:
      'Sets the document type (`doc_class`) of a base-corpus document; it takes effect in retrieval at once with no re-ingest. ' +
      'Returns `{ fileName, docClass }`.',
    method: 'PATCH',
    path: '/api/platform/knowledge/documents/[fileName]/doc-class',
    params: fileNameParams,
    // The route reads the body by hand (no zod schema); it is the gate.
    body: z.object({ doc_class: z.string().min(1).describe('The document type to set.') }),
    idempotent: true,
    load: () => import('@/app/api/platform/knowledge/documents/[fileName]/doc-class/route'),
  },
  {
    name: 'platform-knowledge-reingest',
    domain: 'platform',
    summary: 'Force a rebuild of chosen base-corpus documents',
    description:
      'Rebuilds the chunks of the named base-corpus documents even if the PDF is unchanged, which is what a change to how ' +
      'chunks are built needs. For new or changed files only, use platform-knowledge-sync.',
    method: 'POST',
    path: '/api/platform/knowledge/reingest',
    body: reingestKnowledgeSchema,
    idempotent: true,
    load: () => import('@/app/api/platform/knowledge/reingest/route'),
  },
  {
    name: 'platform-knowledge-sync',
    domain: 'platform',
    summary: 'Re-sync the base corpus incrementally',
    description:
      'Re-ingests new or changed PDFs of the shared base corpus; unchanged files are skipped by hash. Returns the sync result.',
    method: 'POST',
    path: '/api/platform/knowledge/sync',
    idempotent: true,
    load: () => import('@/app/api/platform/knowledge/sync/route'),
  },

  // Maintenance
  {
    name: 'platform-kill-runs',
    domain: 'platform',
    summary: 'Kill switch: stop every running deep research',
    description:
      'Interrupts every running deep research in every organization, stops its worker and closes the run as `interrupted`. ' +
      'It cannot be undone and hits all tenants; use it only for a runaway cost or an outage. Returns what it stopped.',
    method: 'POST',
    path: '/api/platform/maintenance/kill-runs',
    destructive: true,
    load: () => import('@/app/api/platform/maintenance/kill-runs/route'),
  },
  {
    name: 'platform-vectors-reconcile',
    domain: 'platform',
    summary: 'Delete orphaned vector chunks',
    description:
      'Deletes vector-store chunks whose owning document row no longer exists, the residue of past deletes. ' +
      'The deleted chunks cannot be restored. Returns the counts.',
    method: 'POST',
    path: '/api/platform/maintenance/reconcile-vectors',
    destructive: true,
    load: () => import('@/app/api/platform/maintenance/reconcile-vectors/route'),
  },
  {
    name: 'platform-answer-feedback-export',
    domain: 'platform',
    summary: 'Export answer feedback as CSV or Excel',
    description:
      'The votes behind platform-answer-feedback-get as a file: `format` csv (default, returned as text) or xlsx (a four-sheet workbook, ' +
      'returned as an attached resource up to 5 MiB). Same scope and filters as the Ratings tab; `scope: "all"` ignores the ratings filters. ' +
      '`summary: "weekly"` exports a CSV per organization and ISO week instead. A cut export says so in its file name.',
    method: 'GET',
    path: '/api/platform/answer-feedback/export',
    query: ratingsQuery.extend({
      format: z.enum(['csv', 'xlsx']).optional().describe('csv (default) or xlsx.'),
      scope: z.enum(['all', 'selection']).optional().describe('all: every vote in the scope, ratings filters ignored.'),
      summary: z.literal('weekly').optional().describe('weekly: a CSV per organization and ISO week instead of the votes.'),
    }),
    binaryResponse: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    load: () => import('@/app/api/platform/answer-feedback/export/route'),
  },
  {
    name: 'platform-knowledge-document-upload',
    domain: 'platform',
    summary: 'Upload a PDF or ZIP to the base corpus',
    description:
      `Adds a PDF, or a ZIP of PDFs, to the shared building-law corpus every organization reads. Up to ${MAX_UPLOAD_BYTES / (1024 * 1024)} MiB per call ` +
      'through the agent door. Send `body.files[0]` as { name, mimeType, contentBase64 }; `body.fields.doc_class` presets the document type ' +
      'of a single PDF. Ingestion runs in the background: the answer is `pending`, follow it with the corpus status operations. ' +
      'Platform owners only.',
    method: 'POST',
    path: '/api/platform/knowledge/documents',
    body: uploadBodySchemaWith({
      doc_class: z.string().max(100).optional().describe('The document type for a single PDF; omit to let ingestion decide.'),
    }),
    bodyEncoding: 'multipart',
    load: () => import('@/app/api/platform/knowledge/documents/route'),
  },

]
