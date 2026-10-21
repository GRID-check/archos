/** The organization operations (ADR-0121). See `projects.ts` for the shape and `docs/architecture/agent-surface.md` for the rules. */

import { z } from 'zod'
import {
  budgetDeleteSchema,
  budgetPutSchema,
  createOrgMemorySchema,
  deletedFolderContentSchema,
  downloadLogQuerySchema,
  downloadLogRetentionSchema,
  modelConfigPutSchema,
  modelSearchQuerySchema,
  orgInstructionsSchema,
  orgSettingsPutSchema,
  patchOrgMemorySchema,
  usageNoticeQuerySchema,
  usageQuerySchema,
  zdrPutSchema,
} from '@/lib/organizations/organization-wire'
import { createRoleSchema, updateRoleSchema } from '@/lib/authz/role-wire'
import { createCredentialSchema, providerModeSchema } from '@/lib/llm-credentials/credential-wire'
import { uploadScreeningPolicySchema } from '@/lib/upload-screening/policy'
import type { AgentOperation } from '../operation'

const memoryParams = z.object({
  itemId: z.string().describe('The organization memory item id, from organization-memory-list.'),
})

const roleParams = z.object({
  slug: z.string().describe('The custom role’s slug, from organization-role-list.'),
})

const credentialParams = z.object({
  id: z.string().uuid().describe('The credential id (a UUID), from organization-llm-credential-list.'),
})

const versionParams = z.object({
  id: z
    .string()
    .describe(
      'A model configuration version id (a UUID) from organization-model-config-version-list, or the word "none" to drop every override and return to the inherited defaults.',
    ),
})

/** The memory list reads `includeArchived` straight from the URL, so the query is declared here. */
const memoryListQuery = z.object({
  includeArchived: z.enum(['true', 'false']).optional().describe('"true" also returns archived items.'),
})

export const organizationOperations: readonly AgentOperation[] = [
  // --- members and roles ---------------------------------------------------
  {
    name: 'organization-member-list',
    domain: 'organization',
    summary: 'List the organization’s members',
    description:
      'Every active member of the organization with user id, email and display name, read from the identity provider. ' +
      'Organization admins only. Use the user ids for per-member budgets (organization-budget-set) and for the ' +
      'userId filter of organization-download-log-list and organization-usage-get.',
    method: 'GET',
    path: '/api/organization/members',
    load: () => import('@/app/api/organization/members/route'),
  },
  {
    name: 'organization-role-list',
    domain: 'organization',
    summary: 'List the organization’s roles',
    description:
      'The roles of this organization (built-in and the office’s custom roles) by name and slug; any member may read them. ' +
      'Permissions and the list of assignable permissions are included only for holders of org:members:manage. ' +
      'Role slugs are what a folder restriction names.',
    method: 'GET',
    path: '/api/organization/roles',
    load: () => import('@/app/api/organization/roles/route'),
  },
  {
    name: 'organization-role-create',
    domain: 'organization',
    summary: 'Define a custom role',
    description:
      'Creates a custom role from `name`, an optional `description` and `permissions`, at most 50, each one the editor holds; ' +
      'the `assignable` list of organization-role-list names them. The slug is derived from the name, once. Needs ' +
      'org:members:manage. Returns `{ role }`. Sensitive: the organization switches it on for agents, and the person confirms every call.',
    method: 'POST',
    path: '/api/organization/roles',
    body: createRoleSchema,
    idempotent: false,
    sensitivity: 'access',
    load: () => import('@/app/api/organization/roles/route'),
  },
  {
    name: 'organization-role-update',
    domain: 'organization',
    summary: 'Change a custom role',
    description:
      'Changes a custom role’s `name`, `description` or `permissions`; send only what changes. A built-in role cannot be ' +
      'changed, and a permission the editor lacks cannot be added. Every holder of the role gets the new permissions. Needs ' +
      'org:members:manage. Returns `{ role }`. Sensitive: the organization switches it on for agents, and the person confirms every call.',
    method: 'PATCH',
    path: '/api/organization/roles/[slug]',
    params: roleParams,
    body: updateRoleSchema,
    idempotent: true,
    sensitivity: 'access',
    load: () => import('@/app/api/organization/roles/[slug]/route'),
  },
  {
    name: 'organization-role-delete',
    domain: 'organization',
    summary: 'Delete a custom role',
    description:
      'Deletes a custom role. Refused with 409 `role-assigned` while somebody holds it, and for a built-in role. Needs ' +
      'org:members:manage. Returns `{ slug }`. Sensitive: the organization switches it on for agents, and the person confirms every call.',
    method: 'DELETE',
    path: '/api/organization/roles/[slug]',
    params: roleParams,
    sensitivity: 'access',
    load: () => import('@/app/api/organization/roles/[slug]/route'),
  },

  // --- settings ------------------------------------------------------------
  {
    name: 'organization-settings-get',
    domain: 'organization',
    summary: 'Read the organization’s settings',
    description:
      'Display name, default language and the settings bag of the caller’s organization. Any member may read. ' +
      'Change them with organization-settings-update.',
    method: 'GET',
    path: '/api/organization/settings',
    load: () => import('@/app/api/organization/settings/route'),
  },
  {
    name: 'organization-settings-update',
    domain: 'organization',
    summary: 'Update the organization’s settings',
    description:
      'Merges the provided fields into the organization’s settings: displayName, defaultLocale, and keys of the settings bag. ' +
      'Needs org:settings:manage. Keys that own a dedicated operation are refused: switch zero data retention with ' +
      'organization-zdr-set, the upload policy with organization-upload-screening-set, download log retention with ' +
      'organization-download-log-retention-set. Read the current values first with organization-settings-get.',
    method: 'PUT',
    path: '/api/organization/settings',
    body: orgSettingsPutSchema,
    load: () => import('@/app/api/organization/settings/route'),
  },
  {
    name: 'organization-instructions-get',
    domain: 'organization',
    summary: 'Read the standing instructions',
    description:
      'The organization’s standing instruction block that shapes every answer its members get. Any member may read. ' +
      'Change it with organization-instructions-set.',
    method: 'GET',
    path: '/api/organization/instructions',
    load: () => import('@/app/api/organization/instructions/route'),
  },
  {
    name: 'organization-instructions-set',
    domain: 'organization',
    summary: 'Replace the standing instructions',
    description:
      'Replaces the organization’s standing instruction block with the given text; an empty or blank text clears it. ' +
      'Needs org:settings:manage. The block applies to every member’s answers, so read the current text with ' +
      'organization-instructions-get and edit it rather than overwriting it blindly.',
    method: 'PUT',
    path: '/api/organization/instructions',
    body: orgInstructionsSchema,
    load: () => import('@/app/api/organization/instructions/route'),
  },

  // --- organization memory -------------------------------------------------
  {
    name: 'organization-memory-list',
    domain: 'organization',
    summary: 'List organization memory',
    description:
      'The knowledge shared by every project of the organization (kind, content, status, confidence, pinned). ' +
      'Any member may read. Item ids feed organization-memory-update and organization-memory-delete.',
    method: 'GET',
    path: '/api/organization/memory',
    query: memoryListQuery,
    load: () => import('@/app/api/organization/memory/route'),
  },
  {
    name: 'organization-memory-create',
    domain: 'organization',
    summary: 'Add an organization memory item',
    description:
      'Records one item of organization-wide knowledge that every project then carries. Any member may add one. ' +
      'Returns the created item with its id. Check organization-memory-list first to avoid a duplicate.',
    method: 'POST',
    path: '/api/organization/memory',
    body: createOrgMemorySchema,
    load: () => import('@/app/api/organization/memory/route'),
  },
  {
    name: 'organization-memory-update',
    domain: 'organization',
    summary: 'Edit an organization memory item',
    description:
      'Changes fields of one organization memory item (kind, content, status, confidence, verification, pinned). ' +
      'At least one field is required. The id comes from organization-memory-list.',
    method: 'PATCH',
    path: '/api/organization/memory/[itemId]',
    params: memoryParams,
    body: patchOrgMemorySchema,
    idempotent: true,
    load: () => import('@/app/api/organization/memory/[itemId]/route'),
  },
  {
    name: 'organization-memory-delete',
    domain: 'organization',
    summary: 'Delete an organization memory item',
    description:
      'Permanently deletes one organization memory item; it cannot be undone. To keep it but stop using it, set its ' +
      'status with organization-memory-update instead. The id comes from organization-memory-list.',
    method: 'DELETE',
    path: '/api/organization/memory/[itemId]',
    params: memoryParams,
    destructive: true,
    load: () => import('@/app/api/organization/memory/[itemId]/route'),
  },

  // --- model configuration and zero data retention -------------------------
  {
    name: 'organization-model-config-get',
    domain: 'organization',
    summary: 'Read the model configuration',
    description:
      'The agent groups, the active model configuration version, whether zero data retention is on and applicable, and ' +
      'which groups have no ZDR-capable model. Needs org:models:manage. Pick models with ' +
      'organization-model-search, then save with organization-model-config-set.',
    method: 'GET',
    path: '/api/organization/model-config',
    load: () => import('@/app/api/organization/model-config/route'),
  },
  {
    name: 'organization-model-config-set',
    domain: 'organization',
    summary: 'Save a new model configuration',
    description:
      'Validates the chosen model per agent group against the live catalog (and ZDR, while it is on), then writes a new ' +
      'version and activates it for the whole organization. Needs org:models:manage. Group ids come from ' +
      'organization-model-config-get, model ids from organization-model-search. The earlier version stays in ' +
      'organization-model-config-version-list for rollback.',
    method: 'PUT',
    path: '/api/organization/model-config',
    body: modelConfigPutSchema,
    idempotent: false,
    load: () => import('@/app/api/organization/model-config/route'),
  },
  {
    name: 'organization-model-search',
    domain: 'organization',
    summary: 'Search models for an agent group',
    description:
      'Models that satisfy one agent group’s requirements, filtered by a search text, with context length, a ZDR mark and ' +
      'an approximate credit cost per request. Needs org:models:manage. The group id comes from ' +
      'organization-model-config-get; pass the chosen model id to organization-model-config-set.',
    method: 'GET',
    path: '/api/organization/model-config/models',
    query: modelSearchQuerySchema,
    load: () => import('@/app/api/organization/model-config/models/route'),
  },
  {
    name: 'organization-model-config-version-list',
    domain: 'organization',
    summary: 'List model configuration versions',
    description:
      'The history of the organization’s model configurations, newest first, with the id of the active one. ' +
      'Needs org:models:manage. A version id goes to organization-model-config-version-activate to roll back.',
    method: 'GET',
    path: '/api/organization/model-config/versions',
    load: () => import('@/app/api/organization/model-config/versions/route'),
  },
  {
    name: 'organization-model-config-version-activate',
    domain: 'organization',
    summary: 'Roll back to a model configuration version',
    description:
      'Makes an earlier configuration version the active one for the whole organization, or pass the id "none" to drop ' +
      'every override and return to the inherited defaults. Needs org:models:manage. Refused with the offending groups ' +
      'when zero data retention is on and the version selects a model without a ZDR endpoint.',
    method: 'POST',
    path: '/api/organization/model-config/versions/[id]/activate',
    params: versionParams,
    idempotent: true,
    load: () => import('@/app/api/organization/model-config/versions/[id]/activate/route'),
  },
  {
    name: 'organization-zdr-set',
    domain: 'organization',
    summary: 'Turn zero data retention on or off',
    description:
      'Switches the organization’s zero-data-retention privacy control. On (the default) only models with a ZDR endpoint ' +
      'are accepted and every model request is sent with data collection denied; turning it off lets data reach ' +
      'endpoints that may retain it, so do it only when the person asks. Needs org:models:manage. The response names ' +
      'groups whose model has no ZDR endpoint; fix them with organization-model-config-set.',
    method: 'PUT',
    path: '/api/organization/model-config/zdr',
    body: zdrPutSchema,
    sensitivity: 'control',
    load: () => import('@/app/api/organization/model-config/zdr/route'),
  },

  // --- LLM provider keys ---------------------------------------------------
  {
    name: 'organization-llm-credential-list',
    domain: 'organization',
    summary: 'List the organization’s LLM provider keys',
    description:
      'The organization’s own LLM provider keys as metadata: provider, label, base URL, status, dates, a masked `keyHint` ' +
      '(the last four characters) and a fingerprint. The key itself is write-only and never returned. Also the `mode` ' +
      '(`byok` or `platform`). Needs org:models:manage and the byok-llm feature. ' +
      'Sensitive: the organization switches it on for agents, and the person confirms every call. ',
    method: 'GET',
    path: '/api/organization/llm-credentials',
    sensitivity: 'secret',
    load: () => import('@/app/api/organization/llm-credentials/route'),
  },
  {
    name: 'organization-llm-credential-create',
    domain: 'organization',
    summary: 'Connect an LLM provider key',
    description:
      'Checks `apiKey` against the provider, stores it encrypted and makes it the active key. `provider` is one of the presets; ' +
      '`baseUrl` only where the provider takes one; `rotatedFrom` names the key it replaces. The key is write-only: no answer carries it ' +
      'back. Returns `{ credential }` as organization-llm-credential-list shows it. Needs ' +
      'org:models:manage and the byok-llm feature. Sensitive: the organization switches it on for agents, and the person confirms every call. Ask the person for the key; never invent or reuse one.',
    method: 'POST',
    path: '/api/organization/llm-credentials',
    body: createCredentialSchema,
    idempotent: false,
    sensitivity: 'secret',
    load: () => import('@/app/api/organization/llm-credentials/route'),
  },
  {
    name: 'organization-llm-credential-revoke',
    domain: 'organization',
    summary: 'Revoke an LLM provider key',
    description:
      'Revokes the key; the organization’s traffic falls back to the platform service within a minute. The key is never ' +
      'returned. Needs org:models:manage and the byok-llm feature. Sensitive: the organization switches it on for agents, and the person confirms every call.',
    method: 'DELETE',
    path: '/api/organization/llm-credentials/[id]',
    params: credentialParams,
    sensitivity: 'secret',
    load: () => import('@/app/api/organization/llm-credentials/[id]/route'),
  },
  {
    name: 'organization-llm-credential-verify',
    domain: 'organization',
    summary: 'Check an LLM provider key against the provider',
    description:
      'Asks the provider whether the active key still works and records when. Returns `{ credential, modelCount }`; the key ' +
      'itself is never returned. Needs org:models:manage and the byok-llm feature. Sensitive: the organization switches it on for agents, and the person confirms every call.',
    method: 'POST',
    path: '/api/organization/llm-credentials/[id]/verify',
    params: credentialParams,
    idempotent: true,
    sensitivity: 'secret',
    load: () => import('@/app/api/organization/llm-credentials/[id]/verify/route'),
  },
  {
    name: 'organization-llm-provider-mode-set',
    domain: 'organization',
    summary: 'Choose between the organization’s key and the platform',
    description:
      'Sets `mode`: `byok` sends the organization’s traffic through its own key, `platform` through the platform service, ' +
      'without deleting the stored key. New conversations follow within a minute. Needs org:models:manage and the byok-llm ' +
      'feature. Sensitive: the organization switches it on for agents, and the person confirms every call.',
    method: 'PUT',
    path: '/api/organization/llm-credentials/mode',
    body: providerModeSchema,
    sensitivity: 'secret',
    load: () => import('@/app/api/organization/llm-credentials/mode/route'),
  },

  // --- budgets and usage ---------------------------------------------------
  {
    name: 'organization-budget-get',
    domain: 'organization',
    summary: 'Read the LLM budgets',
    description:
      'Daily and monthly limits (credits, or tokens for an organization on its own key) for the organization and the ' +
      'caller; budget admins also get every member and project limit. Change with organization-budget-set, remove a ' +
      'member or project limit with organization-budget-remove.',
    method: 'GET',
    path: '/api/organization/budgets',
    load: () => import('@/app/api/organization/budgets/route'),
  },
  {
    name: 'organization-budget-set',
    domain: 'organization',
    summary: 'Set a budget limit',
    description:
      'Sets the daily and monthly limit (null means unlimited) for the organization, one member or one project. ' +
      'The unit follows the organization’s key mode. Organization and member scopes need budget admin rights; project ' +
      'scope also works for that project’s admins. subjectId is a user id from organization-member-list or a ' +
      'project id from project-list; omit it for the organization scope.',
    method: 'PUT',
    path: '/api/organization/budgets',
    body: budgetPutSchema,
    load: () => import('@/app/api/organization/budgets/route'),
  },
  {
    name: 'organization-budget-remove',
    domain: 'organization',
    summary: 'Remove a member or project budget limit',
    description:
      'Deletes the limit of one member or one project so that the organization limits alone apply. The organization ' +
      'limits themselves are changed with organization-budget-set. subjectId is a user id from ' +
      'organization-member-list or a project id from project-list.',
    method: 'DELETE',
    path: '/api/organization/budgets',
    body: budgetDeleteSchema,
    destructive: true,
    load: () => import('@/app/api/organization/budgets/route'),
  },
  {
    name: 'organization-usage-get',
    domain: 'organization',
    summary: 'Read LLM usage in credits',
    description:
      'Per-model usage by day and month in credits. Budget admins see the whole organization and may narrow it by ' +
      'userId or projectId; other members get their own usage only.',
    method: 'GET',
    path: '/api/organization/usage',
    query: usageQuerySchema,
    load: () => import('@/app/api/organization/usage/route'),
  },
  {
    name: 'organization-usage-notice-get',
    domain: 'organization',
    summary: 'Read the budget warning for the asking person',
    description:
      'The one budget window close enough to stop this person, or null when none is. Pass projectId to include that ' +
      "project's budget. Any member may read; amounts appear only for budget admins. Read this before starting long work.",
    method: 'GET',
    path: '/api/organization/usage/notice',
    query: usageNoticeQuerySchema,
    load: () => import('@/app/api/organization/usage/notice/route'),
  },

  // --- storage, sensitive data, auditing -----------------------------------
  {
    name: 'organization-storage-get',
    domain: 'organization',
    summary: 'Read storage usage and quota',
    description:
      'How much storage the organization uses against its quota. Any member may read; the quota itself is set by the ' +
      'platform operator and cannot be changed here. Read this when an upload is refused.',
    method: 'GET',
    path: '/api/organization/storage',
    load: () => import('@/app/api/organization/storage/route'),
  },
  {
    name: 'organization-upload-screening-get',
    domain: 'organization',
    summary: 'Read the upload screening policy',
    description:
      'The policy that screens file names before an upload, whether it is still Piloti’s suggested list, and that ' +
      'suggestion. Any member may read. Change with organization-upload-screening-set.',
    method: 'GET',
    path: '/api/organization/upload-screening',
    load: () => import('@/app/api/organization/upload-screening/route'),
  },
  {
    name: 'organization-upload-screening-set',
    domain: 'organization',
    summary: 'Save the upload screening policy',
    description:
      'Replaces the organization’s upload screening policy. Needs org:settings:manage. Read the current policy and ' +
      'the suggested one with organization-upload-screening-get and send the whole policy.',
    method: 'PUT',
    path: '/api/organization/upload-screening',
    body: uploadScreeningPolicySchema,
    sensitivity: 'control',
    load: () => import('@/app/api/organization/upload-screening/route'),
  },
  {
    name: 'organization-deleted-folder-content-get',
    domain: 'organization',
    summary: 'Read the deleted-folder content policy',
    description:
      'Who may still see conversations, answers and notes drawn from a folder once the folder is purged. Any member may read. ' +
      'Change with organization-deleted-folder-content-set.',
    method: 'GET',
    path: '/api/organization/deleted-folder-content',
    load: () => import('@/app/api/organization/deleted-folder-content/route'),
  },
  {
    name: 'organization-deleted-folder-content-set',
    domain: 'organization',
    summary: 'Set the deleted-folder content policy',
    description:
      'Chooses what happens to content derived from a folder when the folder is purged. Needs org:settings:manage. ' +
      'Takes effect at read time for all derived content at once. Read the current choice with ' +
      'organization-deleted-folder-content-get.',
    method: 'PUT',
    path: '/api/organization/deleted-folder-content',
    body: deletedFolderContentSchema,
    sensitivity: 'control',
    load: () => import('@/app/api/organization/deleted-folder-content/route'),
  },
  {
    name: 'organization-download-log-list',
    domain: 'organization',
    summary: 'Read the download log',
    description:
      'Who took which document out, newest first, filtered by user, document, kind and day range (UTC, YYYY-MM-DD), ' +
      'paged by cursor (pass the cursor of the previous page). Needs org:downloads:view. Every read is recorded in the ' +
      'audit trail. Rows in folders the caller may not read come without document and folder names. User ids come ' +
      'from organization-member-list.',
    method: 'GET',
    path: '/api/organization/download-log',
    query: downloadLogQuerySchema,
    spansProjects: 'always',
    load: () => import('@/app/api/organization/download-log/route'),
  },
  {
    name: 'organization-download-log-retention-set',
    domain: 'organization',
    summary: 'Set download log retention',
    description:
      'Sets how many whole days (30 to 365) the download log is kept. Needs org:settings:manage. A shorter time takes ' +
      'effect at the next daily purge, after which older entries cannot be recovered.',
    method: 'PUT',
    path: '/api/organization/download-log/retention',
    body: downloadLogRetentionSchema,
    sensitivity: 'control',
    load: () => import('@/app/api/organization/download-log/retention/route'),
  },
  {
    name: 'organization-audit-portal-link-create',
    domain: 'organization',
    summary: 'Get a link to the audit log viewer',
    description:
      'Mints a short-lived, single-use link to the identity provider’s audit log portal for this organization only. ' +
      'Needs org:audit:view. Give the link to the person; each call creates a new one.',
    method: 'POST',
    path: '/api/organization/audit-portal',
    idempotent: false,
    // The link is a credential to the organization's audit log, as platform-audit-portal-link's is.
    sensitivity: 'secret',
    load: () => import('@/app/api/organization/audit-portal/route'),
  },
  {
    name: 'organization-failed-document-reingest',
    domain: 'organization',
    summary: 'Re-read every document that failed ingestion',
    description:
      'Queues a job that sends every document of the organization that could not be read back through ingestion, and ' +
      'answers at once with the job id. Needs org:settings:manage. For a single document use its own retry operation.',
    method: 'POST',
    path: '/api/organization/documents/reingest-failed',
    idempotent: true,
    load: () => import('@/app/api/organization/documents/reingest-failed/route'),
  },
]
